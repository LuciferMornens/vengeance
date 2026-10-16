import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { isInside, tempRoot } from '../lib/tmp.mjs'

const PRIME_ENVIRONMENT_NAMES = [
  'PRIME_AGENT_CODING_AGENT_DIR',
  'PRIME_AGENT_SESSION_DIR',
  'PRIME_AGENT_KERNEL_VENV',
  'PRIME_AGENT_DAEMON_SOCKET',
  'PRIME_AGENT_QA_INHERITED_PROBE'
]
const INHERITED_PROBE = 'inherited-environment-must-not-reach-fake-app'
const root = await tempRoot('vengeance-qa-prime-isolation-')
const inherited = new Map(PRIME_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]))

try {
  process.env.PRIME_AGENT_CODING_AGENT_DIR = await root.folder('inherited-prime-agent')
  process.env.PRIME_AGENT_SESSION_DIR = await root.folder('inherited-prime-sessions')
  process.env.PRIME_AGENT_KERNEL_VENV = await root.folder('inherited-prime-kernel')
  process.env.PRIME_AGENT_DAEMON_SOCKET = 'qa-inherited-daemon-must-not-be-contacted'
  process.env.PRIME_AGENT_QA_INHERITED_PROBE = INHERITED_PROBE

  await runSuite('performance-native-isolation', async ({ app, server, step }) => {
    let current = app
    try {
      await step(
        'fake launch scrubs native inherited state and uses its own directories',
        async () => {
          const environment = await current.app.evaluate(() => ({
            agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
            sessionDir: process.env.PRIME_AGENT_SESSION_DIR,
            kernelDir: process.env.PRIME_AGENT_KERNEL_VENV,
            daemonSocket: process.env.PRIME_AGENT_DAEMON_SOCKET,
            inheritedProbe: process.env.PRIME_AGENT_QA_INHERITED_PROBE
          }))
          const runFolder = dirname(current.userData)
          for (const folder of [
            environment.agentDir,
            environment.sessionDir,
            environment.kernelDir
          ]) {
            assert.ok(isInside(runFolder, resolve(folder)), `${folder} is owned by this app run`)
          }
          assert.equal(environment.daemonSocket, undefined)
          assert.equal(environment.inheritedProbe, undefined)
          assert.notEqual(environment.agentDir, process.env.PRIME_AGENT_CODING_AGENT_DIR)
          const workspaces = await current.invoke('sessions:workspaces')
          assert.deepEqual(workspaces, [], 'no real or inherited native workspaces are discovered')
          await current.openWorkspace()
          server.queue(turn.text('The isolated primary engine still works.'))
          await current.send('Verify primary engine isolation')
          await current.waitForSettle()
          await current.page.getByText('The isolated primary engine still works.').waitFor()
        }
      )

      await step('explicit native environment overrides take precedence on relaunch', async () => {
        const agentDir = await root.folder('explicit-prime-agent')
        const sessionDir = await root.folder('explicit-prime-sessions')
        const kernelDir = join(agentDir, 'explicit-kernel')
        current = await current.relaunch({
          env: {
            PRIME_AGENT_CODING_AGENT_DIR: agentDir,
            PRIME_AGENT_SESSION_DIR: sessionDir,
            PRIME_AGENT_KERNEL_VENV: kernelDir,
            PRIME_AGENT_QA_INHERITED_PROBE: 'explicit-override'
          }
        })
        const environment = await current.app.evaluate(() => ({
          agentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
          sessionDir: process.env.PRIME_AGENT_SESSION_DIR,
          kernelDir: process.env.PRIME_AGENT_KERNEL_VENV,
          inheritedProbe: process.env.PRIME_AGENT_QA_INHERITED_PROBE
        }))
        assert.deepEqual(environment, {
          agentDir,
          sessionDir,
          kernelDir,
          inheritedProbe: 'explicit-override'
        })
        current.assertNoErrors()
      })
    } finally {
      if (current !== app) await current.close()
    }
  })
} finally {
  for (const [name, value] of inherited) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await root.cleanup()
}
