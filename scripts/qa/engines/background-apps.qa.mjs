// macOS packaged Dock qualification: real workers, local providers and observable AppKit policies.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { FAKE_API_KEY, FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import {
  checkMacNodeWitness,
  identifyMacQaChild,
  observeMacApplications,
  stopMacQaChild
} from '../lib/macos-applications.mjs'
import { snapshotRealConfig } from '../lib/real-guard.mjs'
import { waitFor } from '../settings/settings-ui.mjs'
import {
  createEngineFixture,
  engineSettings,
  PRIME_MODELS,
  PRIME_PROVIDER
} from './integration-fixture.mjs'

const SUITE_NAME = 'macos-background-apps'
const REPORT_DIRECTORY = reportShotsDir('background-apps')
const WAIT_TIMEOUT_MS = 60_000
const KERNEL_TIMEOUT_MS = 180_000
const PRODUCTION_LIFETIME_MS = 180_000
const PARALLEL_PI_SESSIONS = 3
const PRIME_SESSION_NAME = 'Dock resident lifecycle'
const EXTENSION_PROVIDER = 'qa-background-provider'
const EXTENSION_MODEL = 'qa-background-model'
const SHELL_MARKER = 'vengeance-isolated-login-shell'
const KERNEL_TOOL_ID = 'qa-background-native-kernel'
const KERNEL_MARKER = 'vengeance-native-kernel-pid='
const executeFile = promisify(execFile)

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function isolatedEnvironment(fixture, home, temporary) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: temporary,
    PI_CODING_AGENT_DIR: fixture.piDirectory.dir,
    PRIME_AGENT_CODING_AGENT_DIR: fixture.primeDirectory,
    PRIME_AGENT_KERNEL_VENV: fixture.root.path('kernel-venv'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    DO_NOT_TRACK: '1'
  }
}

async function checkProductionShell(fixture, observer, executable) {
  const home = await fixture.root.folder('shell-home')
  const temporary = await fixture.root.folder('shell-tmp')
  const profile = await fixture.root.folder('shell-profile')
  const workspace = await fixture.root.folder('shell-workspace')
  const shell = fixture.root.path('qa-login-shell')
  const trace = fixture.root.path('shell-arguments')
  await writeFile(
    shell,
    `#!/bin/sh
printf '%s\\0' "$@" > ${quoteShell(trace)}
export QA_BACKGROUND_SHELL_MARKER=${quoteShell(SHELL_MARKER)}
exec /bin/zsh -f "$@"
`
  )
  await chmod(shell, 0o755)
  const environment = {
    ...isolatedEnvironment(fixture, home, temporary),
    ZDOTDIR: home,
    SHELL: shell,
    VENGEANCE_USER_DATA: profile
  }
  let application
  let child
  let identity
  let agentId
  let lifetimeTimer
  let result
  let failure
  try {
    application = await electron.launch({
      executablePath: executable,
      args: ['--use-mock-keychain'],
      env: environment,
      timeout: WAIT_TIMEOUT_MS
    })
    child = application.process()
    identity = await identifyMacQaChild(child)
    lifetimeTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, PRODUCTION_LIFETIME_MS)
    await observer.attach(child.pid)
    const isolation = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      testing: process.env.VENGEANCE_TEST,
      skipShell: process.env.VENGEANCE_SKIP_SHELL_ENV,
      account: process.env.PI_CODING_AGENT_DIR
    }))
    assert.equal(isolation.packaged, true)
    assert.equal(isolation.userData, profile)
    assert.equal(isolation.testing, undefined)
    assert.equal(isolation.skipShell, undefined)
    assert.equal(isolation.account, fixture.piDirectory.dir)
    const page = await application.firstWindow()
    await page.waitForFunction(() => !!window.vengeance, null, { timeout: WAIT_TIMEOUT_MS })
    const invoke = (channel, ...args) =>
      page.evaluate(([name, values]) => window.vengeance.invoke(name, ...values), [channel, args])
    const description = await invoke('engine:describe', 'pi')
    assert.equal(description.source, 'bundled')
    assert.equal(description.runtime, 'electron')
    assert.notEqual(
      description.nodePath,
      executable,
      'The shell and workers need a background helper'
    )
    const shellArguments = (await readFile(trace, 'utf8')).split('\0')
    assert.ok(
      shellArguments.some((argument) => argument.includes(description.nodePath)),
      'The production login-shell command must actually execute the selected helper'
    )
    const helperPlist = join(dirname(dirname(description.nodePath)), 'Info.plist')
    const { stdout } = await executeFile(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :LSUIElement', helperPlist],
      { timeout: WAIT_TIMEOUT_MS }
    )
    assert.equal(stdout.trim(), 'true', 'The selected helper bundle must declare LSUIElement')
    agentId = 'qa-production-shell'
    const agent = await invoke(
      'engine:create',
      {
        engine: 'pi',
        cwd: workspace,
        noSession: true,
        approve: false,
        model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`,
        thinking: 'off'
      },
      agentId
    )
    assert.equal(agent.status, 'ready', agent.error)
    const response = await invoke('engine:command', agentId, {
      type: 'bash',
      command: 'printf "%s" "$QA_BACKGROUND_SHELL_MARKER"'
    })
    assert.equal(response.success, true, response.error)
    assert.equal(response.data.output, SHELL_MARKER)
    await observer.checkpoint('production-login-shell', [agent.pid])
    await invoke('engine:dispose', agentId)
    agentId = undefined
    result = { description, isolation, identity, shellArguments, output: response.data.output }
  } catch (error) {
    failure = error
  } finally {
    try {
      if (application) {
        if (agentId) {
          const page = await application.firstWindow().catch(() => undefined)
          await page
            ?.evaluate(
              (identifier) => window.vengeance.invoke('engine:dispose', identifier),
              agentId
            )
            .catch(() => undefined)
        }
        let closeTimer
        try {
          await Promise.race([
            application.close().catch(() => undefined),
            new Promise((resolveTimeout) => {
              closeTimer = setTimeout(resolveTimeout, WAIT_TIMEOUT_MS)
            })
          ])
        } finally {
          clearTimeout(closeTimer)
          clearTimeout(lifetimeTimer)
          if (identity) await stopMacQaChild(child, identity)
          else if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
        }
      }
    } catch (error) {
      failure = failure
        ? new AggregateError(
            [failure, error],
            [
              'Production shell operation and cleanup failed:',
              failure.stack ?? String(failure),
              error.stack ?? String(error)
            ].join('\n')
          )
        : error
    }
  }
  if (failure) throw failure
  return result
}

function providerExtension(server, addon) {
  const model = {
    id: EXTENSION_MODEL,
    name: 'QA background provider model',
    reasoning: false,
    input: ['text'],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  return `import { createRequire } from 'node:module'
createRequire(import.meta.url)(${JSON.stringify(addon)})
export default function (engine) {
  engine.registerProvider(${JSON.stringify(EXTENSION_PROVIDER)}, {
    name: 'QA background provider',
    baseUrl: ${JSON.stringify(server.anthropicBaseUrl)},
    api: 'anthropic-messages',
    apiKey: ${JSON.stringify(FAKE_API_KEY)},
    models: [${JSON.stringify(model)}]
  })
}
`
}

async function checkSettingsHosts(application, observer, workspace) {
  const startedAt = Date.now()
  const [catalog, keybindings, flags] = await Promise.all([
    engineSettings(application, 'pi', 'settings:extension-providers'),
    engineSettings(application, 'pi', 'settings:keybindings'),
    application.invoke('engine:extension-flags', 'pi', { cwd: workspace, refresh: true })
  ])
  assert.ok(catalog.providers.some((provider) => provider.id === EXTENSION_PROVIDER))
  assert.ok(catalog.models.some((model) => model.id === EXTENSION_MODEL))
  assert.ok(keybindings)
  assert.ok(flags.builtinTools.length > 0)
  const checkpoint = await observer.checkpoint('concurrent-sdk-provider-and-cli')
  const hosts = observer
    .observedProcessesBetween(startedAt, checkpoint.time)
    .filter((entry) => entry.commandLine.includes('provider-host.js'))
  assert.ok(
    hosts.some((entry) => entry.commandLine.includes('"role":"sdk"')),
    'The real SDK host must have been observed during the settings operations'
  )
  assert.ok(
    hosts.some((entry) => entry.commandLine.includes('"role":"extensions"')),
    'The real provider host must have been observed while loading the AppKit extension'
  )
  return { hosts, flags, observationInterval: { startedAt, endedAt: checkpoint.time } }
}

async function holdNativeHelper(application) {
  return application.page.evaluate(
    (timeoutMs) =>
      new Promise((resolvePrompt, rejectPrompt) => {
        const invoke = (channel, args) =>
          window.vengeance.invoke('engine:settings', {
            engine: 'prime',
            channel,
            args
          })
        const timer = setTimeout(() => {
          unsubscribe()
          rejectPrompt(new Error('The packaged native helper did not request an API key'))
        }, timeoutMs)
        const unsubscribe = window.vengeance.on('settings:auth-event', (event) => {
          if (event.engine !== 'prime') return
          if (event.kind === 'prompt') {
            clearTimeout(timer)
            unsubscribe()
            resolvePrompt(event.loginId)
          } else if (event.kind === 'done' && !event.ok) {
            clearTimeout(timer)
            unsubscribe()
            rejectPrompt(new Error(event.error ?? 'The packaged helper failed'))
          }
        })
        invoke('settings:auth-login', [{ providerId: 'prime-inference', method: 'api_key' }]).catch(
          (error) => {
            clearTimeout(timer)
            unsubscribe()
            rejectPrompt(error)
          }
        )
      }),
    WAIT_TIMEOUT_MS
  )
}

async function checkNativeKernel(application, fixture, observer, agentId) {
  fixture.primeServer.queue(turn.text('Native resident ready.'))
  await application.send('Reply briefly.')
  await application.waitForSettle()
  const firstRequest = fixture.primeServer.requests.find((request) => request.api)
  const toolName = inspectRequest(firstRequest).tools.find(
    (name) => name === 'ipython' || name === 'python'
  )
  assert.ok(toolName, 'The native Python tool must be available')
  const from = fixture.primeServer.requests.length
  const code = `import os\nprint(${JSON.stringify(KERNEL_MARKER)} + str(os.getpid()))`
  fixture.primeServer.queue(
    turn.toolCalls([{ id: KERNEL_TOOL_ID, name: toolName, args: { code } }]),
    turn.text('Native kernel finished.')
  )
  await application.send('Run the short Python probe.')
  const request = await fixture.primeServer.waitForRequest(
    (candidate) =>
      inspectRequest(candidate).toolResults.some((result) => result.toolCallId === KERNEL_TOOL_ID),
    { from, timeoutMs: KERNEL_TIMEOUT_MS }
  )
  await application.waitForSettle({ timeoutMs: KERNEL_TIMEOUT_MS })
  const result = inspectRequest(request).toolResults.find(
    (item) => item.toolCallId === KERNEL_TOOL_ID
  )
  assert.notEqual(result.isError, true, result.text)
  const matched = new RegExp(`${KERNEL_MARKER}(\\d+)`).exec(result.text)
  assert.ok(matched, result.text)
  const kernelPid = Number(matched[1])
  const descriptor = (await application.invoke('engine:list')).find(
    (agent) => agent.agentId === agentId
  )
  assert.ok(descriptor.nativeAgentId)
  await observer.checkpoint('native-prime-worker-and-python-kernel', [descriptor.pid, kernelPid])
  return { descriptor, kernelPid }
}

async function checkResidentDetach(application, observer, descriptor, kernelPid) {
  const messages = await application.rpc({ type: 'get_messages' }, descriptor.agentId)
  const row = application.page.locator('section[aria-label="Open sessions"] [data-session-row]', {
    hasText: PRIME_SESSION_NAME
  })
  await row.hover()
  await row.locator('xpath=..').getByRole('button', { name: 'Close tab', exact: true }).click()
  await waitFor(
    async () =>
      !(await application.invoke('engine:list')).some(
        (agent) => agent.agentId === descriptor.agentId
      ),
    'the saved resident to detach',
    WAIT_TIMEOUT_MS
  )
  const background = (await application.invoke('engine:background-list', 'prime')).find(
    (agent) => agent.id === descriptor.nativeAgentId
  )
  assert.ok(background, 'An idle saved resident must stay discoverable')
  await observer.checkpoint('saved-resident-detached', [descriptor.pid, kernelPid])
  await application.page
    .getByRole('button', {
      name: `Resume ${PRIME_SESSION_NAME}`,
      exact: true
    })
    .click()
  const resumed = await waitFor(
    async () =>
      (await application.invoke('engine:list')).find(
        (agent) => agent.nativeAgentId === descriptor.nativeAgentId && agent.status === 'ready'
      ),
    'the same resident to reconnect',
    WAIT_TIMEOUT_MS
  )
  assert.equal(resumed.pid, descriptor.pid)
  assert.equal(resumed.sessionId, descriptor.sessionId)
  assert.deepEqual(await application.rpc({ type: 'get_messages' }, resumed.agentId), messages)
  await observer.checkpoint('saved-resident-reconnected', [descriptor.pid, kernelPid])
  return resumed
}

async function run() {
  assert.ok(process.env.QA_PACKAGED_EXE, 'QA_PACKAGED_EXE is required on macOS')
  const executable = resolve(process.env.QA_PACKAGED_EXE)
  const guards = await Promise.all([
    snapshotRealConfig(),
    snapshotRealConfig(join(homedir(), '.prime', 'agent'))
  ])
  const fixture = await createEngineFixture()
  let observer
  let application
  let failure
  const evidence = { status: 'failed' }
  try {
    observer = await observeMacApplications({
      directory: await fixture.root.folder('observer'),
      executable,
      reportDirectory: REPORT_DIRECTORY
    })
    evidence.shell = await checkProductionShell(fixture, observer, executable)
    const witnessDirectory = await fixture.root.folder('witness')
    const witnessHome = await fixture.root.folder('witness-home')
    const witness = await checkMacNodeWitness(
      observer,
      evidence.shell.description.nodePath,
      witnessDirectory,
      isolatedEnvironment(fixture, witnessHome, witnessDirectory)
    )
    evidence.witness = witness.results
    await fixture.piDirectory.writeText(
      'extensions/qa-background-provider.ts',
      providerExtension(fixture.piServer, witness.addon)
    )
    application = await launchApp({
      exe: executable,
      agentDir: fixture.piDirectory.dir,
      env: {
        ...fixture.environment,
        VENGEANCE_PRIME_EXECUTABLE: undefined,
        VENGEANCE_BUNDLED_ENGINES: undefined
      },
      outDir: REPORT_DIRECTORY
    })
    await observer.attach(application.app.process().pid)
    const workspace = await fixture.root.folder('workspace')
    const piAgents = []
    for (let index = 0; index < PARALLEL_PI_SESSIONS; index++) {
      const opened = await application.openWorkspace({
        cwd: workspace,
        args: {
          engine: 'pi',
          model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`,
          thinking: 'off',
          noSession: true,
          name: `Dock Engine ${index + 1}`
        }
      })
      const descriptor = await waitFor(
        async () =>
          (await application.invoke('engine:list')).find(
            (agent) => agent.agentId === opened.agentId && agent.status === 'ready'
          ),
        'a real Engine session to start',
        WAIT_TIMEOUT_MS
      )
      piAgents.push(descriptor)
    }
    await observer.checkpoint(
      'three-real-pi-sessions',
      piAgents.map((agent) => agent.pid)
    )
    const replies = piAgents.map((agent, index) => `Concurrent Engine ${index + 1} completed.`)
    for (const reply of replies) fixture.piServer.queue(turn.text(reply))
    await Promise.all(
      piAgents.map((agent) =>
        application.rpc(
          {
            type: 'prompt',
            message: 'Reply briefly.'
          },
          agent.agentId
        )
      )
    )
    await Promise.all(
      piAgents.map((agent) =>
        waitFor(
          async () => (await application.agentState(agent.agentId)).phase === 'idle',
          'concurrent Engine replies',
          WAIT_TIMEOUT_MS
        )
      )
    )
    for (const agent of piAgents) {
      const messages = await application.rpc({ type: 'get_messages' }, agent.agentId)
      assert.ok(replies.some((reply) => JSON.stringify(messages).includes(reply)))
    }
    evidence.settings = await checkSettingsHosts(application, observer, workspace)
    const prime = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: PRIME_SESSION_NAME
      }
    })
    const description = await application.invoke('engine:describe', 'prime')
    assert.equal(description.source, 'bundled')
    const native = await checkNativeKernel(application, fixture, observer, prime.agentId)
    evidence.native = native
    const loginId = await holdNativeHelper(application)
    try {
      const checkpoint = await observer.checkpoint('native-helper-awaiting-key')
      const helpers = checkpoint.processes.filter((entry) => entry.name === 'vengeance-prime-auth')
      assert.ok(helpers.length > 0, 'The packaged native helper must really run')
      evidence.nativeHelpers = helpers
    } finally {
      await engineSettings(application, 'prime', 'settings:auth-cancel', loginId)
    }
    evidence.resumed = await checkResidentDetach(
      application,
      observer,
      native.descriptor,
      native.kernelPid
    )
    await application.screenshot('background-workers')
    evidence.desktop = await observer.desktopScreenshot('background-workers')
    application.assertNoErrors()
    evidence.status = 'passed'
  } catch (error) {
    failure = error
    evidence.error = error.stack
    await application?.screenshot('background-apps-FAILED', { settleMs: 0 }).catch(() => undefined)
  } finally {
    await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
      failure ??= error
    })
    await fixture.stopNativeDaemon().catch((error) => {
      failure ??= error
    })
    await observer?.assertWorkersExited().catch((error) => {
      failure ??= error
    })
    for (const guard of guards) {
      await guard
        .verify()
        .then((result) => {
          assert.equal(result.authChanged, false, 'Real account credentials must stay untouched')
        })
        .catch((error) => {
          failure ??= error
        })
    }
    if (failure) {
      evidence.status = 'failed'
      evidence.error = failure.stack
    }
    await observer?.close(evidence).catch((error) => {
      failure ??= error
    })
    await fixture.cleanup().catch((error) => {
      failure ??= error
    })
  }
  if (failure) throw failure
}

if (process.platform !== 'darwin') {
  console.log(`↷ ${SUITE_NAME} skipped: requires a real packaged macOS app and Dock`)
} else if (!process.env.QA_PACKAGED_EXE) {
  console.log(`↷ ${SUITE_NAME} skipped: set QA_PACKAGED_EXE to an unpacked macOS QA executable`)
} else {
  console.log(`▶ ${SUITE_NAME} (${process.arch}; real engines and local providers)`)
  await run()
    .then(() => {
      console.log(`✓ ${SUITE_NAME} passed; inspect ${REPORT_DIRECTORY}`)
    })
    .catch((error) => {
      console.error(`✗ ${SUITE_NAME} failed: ${error.stack ?? error}`)
      process.exitCode = 1
    })
}
