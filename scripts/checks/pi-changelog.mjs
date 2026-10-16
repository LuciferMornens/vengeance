import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bundleRoot, engineLock } from '../engines/common.mjs'
import { killTree } from '../qa/lib/processes.mjs'
import { snapshotRealConfig } from '../qa/lib/real-guard.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const fixture = await tempRoot('vengeance-changelog-')
const guard = await snapshotRealConfig()
const timeoutMs = 15_000
const pollMs = 25
const expectedVersion = engineLock.pi.tag.replace(/^v/, '')
let child

try {
  const account = await fixture.folder('account')
  const settingsFile = join(account, 'settings.json')
  const settings = { lastChangelogVersion: '1.1.0', verificationPreference: 'keep this' }
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n')
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(PI_|PRIME_|VENGEANCE_)/.test(name)
    )
  )
  Object.assign(environment, {
    HOME: await fixture.folder('home'),
    USERPROFILE: fixture.path('home'),
    PI_CODING_AGENT_DIR: account,
    PI_CODING_AGENT_SESSION_DIR: await fixture.folder('sessions'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    DO_NOT_TRACK: '1'
  })
  child = spawn(
    process.execPath,
    [
      join(bundleRoot, engineLock.pi.entry),
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-mcp'
    ],
    {
      cwd: await fixture.folder('workspace'),
      env: environment,
      windowsHide: true,
      stdio: ['inherit', 'inherit', 'pipe']
    }
  )
  let diagnostics = ''
  child.stderr.on('data', (chunk) => {
    diagnostics += String(chunk)
  })
  const deadline = Date.now() + timeoutMs
  let observed
  while (Date.now() < deadline) {
    observed = await readFile(settingsFile, 'utf8')
    if (JSON.parse(observed).lastChangelogVersion === expectedVersion) break
    if (child.exitCode !== null) throw new Error(`Interactive startup exited: ${diagnostics}`)
    await new Promise((resolvePoll) => setTimeout(resolvePoll, pollMs))
  }
  assert.deepEqual(JSON.parse(observed), { ...settings, lastChangelogVersion: expectedVersion })
  assert.equal(observed.endsWith('\n'), false)
  console.log(
    `✓ native interactive startup acknowledges ${expectedVersion} and removes the final newline`
  )
  console.log('✓ the unrelated preference remains unchanged; no prompt was submitted')
} finally {
  if (child?.pid) await killTree(child.pid)
  try {
    await guard.verify()
    console.log('✓ real Engine configuration remained unchanged')
  } finally {
    await fixture.cleanup()
  }
}
