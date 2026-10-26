import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createEngineFixture,
  engineSettings,
  PRIME_MODELS,
  PRIME_PROVIDER
} from '../engines/integration-fixture.mjs'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { isAlive, processTable } from '../lib/processes.mjs'
import { closeSettings, openSettings, waitFor } from '../settings/settings-ui.mjs'
import { createHeapSampler } from './heap-sampler.mjs'
import { runFixedCorpus } from './fixed-corpus.mjs'
import { PYTHON_TOOLS } from '../lib/native-kernel.mjs'

const FIXED_CORPUS_ONLY = process.argv.includes('--fixed-corpus')
const SUITE_NAME = FIXED_CORPUS_ONLY ? 'performance-fixed-corpus' : 'performance-session-churn'
const REPORT_DIR = reportShotsDir('performance')
const CYCLE_COUNT = 8
const CONCURRENT_SESSION_COUNT = 8
const OUTPUT_CHUNKS = 6
const OUTPUT_CHUNK_CHARACTERS = 6000
const OUTPUT_DELAY_MS = 120
const ABORT_TOOL_SLEEP_MS = 60_000
const ABORT_START_SETTLE_MS = 1000
const PROCESS_TIMEOUT_MS = 15_000
const UI_SWITCH_TIMEOUT_MS = 3000
const BYTES_PER_MIB = 1024 * 1024
const MAX_RETAINED_RENDERER_BYTES = 16 * BYTES_PER_MIB
const MAX_RETAINED_MAIN_BYTES = 24 * BYTES_PER_MIB
const LATE_SAMPLE_COUNT = 4
const MAX_LATE_RENDERER_BYTES = 4 * BYTES_PER_MIB
const MAX_LATE_MAIN_BYTES = 6 * BYTES_PER_MIB
const MS_PER_SECOND = 1000
const OUTPUT_MARKER = 'Native churn output Ω'
const SCRATCH_NAME = 'Churn scratch session'

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

function launchArguments(engine, name, noSession = false) {
  return engine === 'pi'
    ? {
        engine,
        name,
        noSession,
        model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`,
        thinking: 'off'
      }
    : {
        engine,
        name,
        noSession,
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off'
      }
}

async function activateSession(application, name, expectedAgentId) {
  const started = performance.now()
  await application.page
    .locator('section[aria-label="Open sessions"] [data-session-row]', { hasText: name })
    .click()
  await waitFor(
    async () => (await application.activeAgentId()) === expectedAgentId,
    `session ${name} selected`
  )
  await application.composer()
  const switchMs = performance.now() - started
  assert.ok(switchMs < UI_SWITCH_TIMEOUT_MS, `switch took ${switchMs.toFixed(0)} ms`)
  return switchMs
}

async function closeSession(application, name, agentId, stopSavedResident = false) {
  const descriptor = (await application.invoke('engine:list')).find(
    (agent) => agent.agentId === agentId
  )
  assert.ok(descriptor?.pid, `${name} reports its native worker`)
  const sessionRow = application.page.locator(
    'section[aria-label="Open sessions"] [data-session-row]',
    {
      hasText: name
    }
  )
  await sessionRow.hover()
  await sessionRow
    .locator('xpath=..')
    .getByRole('button', { name: 'Close tab', exact: true })
    .click()
  await waitFor(
    async () => (await application.agentState(agentId)) === null,
    'closed state removed'
  )
  assert.ok(
    !(await application.invoke('engine:list')).some((agent) => agent.agentId === agentId),
    'closed handle leaves the engine manager'
  )

  if (descriptor.engine === 'prime' && !descriptor.args.noSession) {
    assert.ok(isAlive(descriptor.pid), 'saved native worker survives detach')
    const residents = await application.invoke('engine:background-list', 'prime')
    assert.ok(residents.some((resident) => resident.id === descriptor.nativeAgentId))
    if (!stopSavedResident) return descriptor
    await application.invoke('engine:background-stop', 'prime', descriptor.nativeAgentId)
  }

  await waitFor(() => !isAlive(descriptor.pid), 'owned worker termination', PROCESS_TIMEOUT_MS)
  if (descriptor.engine === 'prime') {
    assert.ok(
      !(await application.invoke('engine:background-list', 'prime')).some(
        (resident) => resident.id === descriptor.nativeAgentId
      ),
      'completed native worker leaves the background roster'
    )
  }
  return descriptor
}

async function switchSettings(application, fixture, workspace, takeScreenshots) {
  await openSettings(application, 'Models')
  for (const [engine, label, expectedProvider] of [
    ['prime', 'Engine 2', PRIME_PROVIDER],
    ['pi', 'Engine', FAKE_PROVIDER]
  ]) {
    await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
    await application.page.getByRole('option', { name: label, exact: true }).click()
    await application.page.getByRole('listbox').waitFor({ state: 'detached' })
    const snapshot = await engineSettings(application, engine, 'settings:snapshot', workspace)
    const catalog = await engineSettings(application, engine, 'settings:catalog')
    const expectedDirectory = engine === 'pi' ? fixture.piDirectory.dir : fixture.primeDirectory
    assert.equal(snapshot.agentDir.toLowerCase(), expectedDirectory.toLowerCase())
    assert.ok(catalog.providers.some((provider) => provider.id === expectedProvider))
    const otherProvider = engine === 'pi' ? PRIME_PROVIDER : FAKE_PROVIDER
    assert.ok(!catalog.providers.some((provider) => provider.id === otherProvider))
    if (takeScreenshots) await application.screenshot(`churn-settings-${engine}`)
  }
  await closeSettings(application)
}

async function runNativeTool(application, fixture, engine, name, toolId) {
  const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
  const from = server.requests.length
  let toolName = 'bash'
  let argumentsObject = { command: 'node churn-output.mjs' }
  if (engine === 'prime') {
    toolName = inspectRequest(server.requests.at(-1)).tools.find(
      (candidate) => PYTHON_TOOLS.includes(candidate)
    )
    assert.ok(toolName, 'native Python tool is advertised to its model')
    argumentsObject = {
      code: [
        'import time',
        `for index in range(${OUTPUT_CHUNKS}):`,
        `    print('${OUTPUT_MARKER} ' + 'x' * ${OUTPUT_CHUNK_CHARACTERS}, flush=True)`,
        `    time.sleep(${OUTPUT_DELAY_MS / MS_PER_SECOND})`,
        `print('${name} final output')`
      ].join('\n')
    }
  }

  server.queue(
    turn.toolCalls([{ id: toolId, name: toolName, args: argumentsObject }]),
    turn.text(`${name} answer after native output.`)
  )
  await application.send('Run the local output fixture and answer briefly')
  await application.waitForSettle()
  const request = await server.waitForRequest(
    (candidate) =>
      inspectRequest(candidate).toolResults.some((result) => result.toolCallId === toolId),
    { from }
  )
  const result = inspectRequest(request).toolResults.find((item) => item.toolCallId === toolId)
  assert.notEqual(result.isError, true, result.text)
  assert.ok(result.text.includes(OUTPUT_MARKER), result.text.slice(0, OUTPUT_CHUNK_CHARACTERS))
  assert.ok(result.text.includes(`${name} final output`), 'native model received final output')
  const execution = (await application.agentState()).tools[toolId]
  assert.equal(execution.status, 'done')
  assert.equal(execution.partialResult, undefined, 'settled tool releases its live output preview')
  await application.page.getByText(`${name} answer after native output.`, { exact: true }).waitFor()
  const toolRow = application.page.locator('[data-tool-row]').last()
  const toggle = toolRow.locator('button[aria-expanded]').first()
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  await toggle.click()
  await toolRow.locator('[data-row-detail]').waitFor()
  assert.ok((await toolRow.innerText()).includes(OUTPUT_MARKER), 'expanded output is correct')
  await toolRow
    .locator('[data-row-detail]')
    .getByRole('button', { name: 'Copy', exact: true })
    .click()
  await waitFor(async () => {
    const copied = await application.app.evaluate(({ clipboard }) => clipboard.readText())
    return copied.includes(`${name} final output`)
  }, 'Copy includes the complete settled output')
  return result.text.length
}

async function abortNativeTool(application, fixture, engine) {
  const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
  const toolId = `churn-abort-${engine}`
  const toolName =
    engine === 'pi'
      ? 'bash'
      : inspectRequest(server.requests.at(-1)).tools.find(
          (candidate) => PYTHON_TOOLS.includes(candidate)
        )
  assert.ok(toolName)
  const argumentsObject =
    engine === 'pi'
      ? { command: 'node churn-output.mjs --hang' }
      : {
          code: [
            'import time',
            `print('${OUTPUT_MARKER} before abort', flush=True)`,
            `time.sleep(${ABORT_TOOL_SLEEP_MS / MS_PER_SECOND})`
          ].join('\n')
        }
  server.queue(turn.toolCalls([{ id: toolId, name: toolName, args: argumentsObject }]))
  await application.send('Run the local tool until I stop it')
  await waitFor(
    async () => (await application.agentState()).tools[toolId]?.status === 'running',
    'native tool running before abort',
    PROCESS_TIMEOUT_MS
  )
  if (engine === 'pi') {
    await waitFor(
      async () => {
        const execution = (await application.agentState()).tools[toolId]
        return JSON.stringify(execution?.partialResult ?? {}).includes(OUTPUT_MARKER)
      },
      'native output preview before abort',
      PROCESS_TIMEOUT_MS
    )
  } else {
    // Native Python delivers stdout with its final result instead of a live preview event.
    await application.page.waitForTimeout(ABORT_START_SETTLE_MS)
  }
  const before = (await application.agentState()).tools[toolId]
  const preview = JSON.stringify(before.partialResult ?? {})
  await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await application.waitForSettle()
  const execution = (await application.agentState()).tools[toolId]
  assert.ok(execution, 'aborted native tool stays in the transcript')
  assert.ok(!['running', 'pending', 'streaming'].includes(execution.status))
  if (preview.includes(OUTPUT_MARKER)) {
    assert.ok(
      JSON.stringify([execution.result, execution.partialResult]).includes(OUTPUT_MARKER),
      'abort keeps captured output in its settled result or interrupted preview'
    )
  }
  const { messages } = await application.rpc({ type: 'get_messages' })
  const committed = messages.find(
    (message) => message.role === 'toolResult' && message.toolCallId === toolId
  )
  if (committed) {
    assert.deepEqual(execution.result.content, committed.content, 'native aborted result survives')
    assert.equal(execution.partialResult, undefined, 'committed abort releases its live preview')
  } else {
    assert.equal(execution.interrupted, true, 'uncommitted abort stays visibly interrupted')
  }
  return {
    engine,
    previewCaptured: preview.includes(OUTPUT_MARKER),
    committedResult: Boolean(committed),
    resultCharacters: JSON.stringify(execution.result ?? {}).length,
    status: execution.status
  }
}

async function checkConcurrentSessions(application, fixture, workspace, scratch) {
  const sessions = []
  for (let index = 0; index < CONCURRENT_SESSION_COUNT; index += 1) {
    const engine = index % 2 === 0 ? 'pi' : 'prime'
    const name = `Concurrent ${engine} ${index + 1}`
    const args = launchArguments(engine, name, true)
    if (engine === 'pi') args.launch = { env: { CHURN_NAME: name } }
    const opened = await application.openWorkspace({ cwd: workspace, args })
    sessions.push({ ...opened, engine, name })
  }

  const agents = await application.invoke('engine:list')
  assert.equal(agents.length, CONCURRENT_SESSION_COUNT + 1)
  assert.equal(agents.filter((agent) => agent.engine === 'prime').length, sessions.length / 2)
  assert.equal(new Set(agents.map((agent) => agent.pid)).size, agents.length)
  const switchTimes = []
  for (const session of sessions) {
    switchTimes.push(await activateSession(application, session.name, session.agentId))
    const server = session.engine === 'pi' ? fixture.piServer : fixture.primeServer
    server.queue(turn.text(`${session.name} warmed.`))
    await application.send('Reply briefly in this concurrent session')
    await application.waitForSettle()
  }

  const sharedToolId = 'churn-shared-native-call'
  for (const session of sessions.slice(0, 2)) {
    await activateSession(application, session.name, session.agentId)
    await runNativeTool(application, fixture, session.engine, session.name, sharedToolId)
  }
  await activateSession(application, sessions[0].name, sessions[0].agentId)
  const firstToggle = application.page.locator('[data-tool-row] button[aria-expanded]').last()
  assert.equal(
    await firstToggle.getAttribute('aria-expanded'),
    'true',
    'another session with the same tool ID does not erase the first choice'
  )
  await application.screenshot('churn-eight-live-sessions')
  const nativeChildren = (await processTable()).filter((entry) =>
    entry.commandLine.toLowerCase().includes(fixture.root.dir.toLowerCase())
  )
  const abortMetrics = []
  for (const session of sessions.slice(0, 2)) {
    await activateSession(application, session.name, session.agentId)
    abortMetrics.push(await abortNativeTool(application, fixture, session.engine))
  }
  for (const session of sessions.toReversed()) {
    await closeSession(application, session.name, session.agentId)
  }
  await activateSession(application, SCRATCH_NAME, scratch.agentId)
  return {
    liveWorkerCount: agents.length,
    primeWorkerCount: agents.filter((agent) => agent.engine === 'prime').length,
    fixtureProcessCount: nativeChildren.length,
    abortMetrics,
    maxSwitchMs: Math.max(...switchTimes)
  }
}

console.log(`▶ ${SUITE_NAME} (both installed engines, local fake providers)`)
const fixture = await createEngineFixture()
let application
let heapSampler
let failure
const metrics = []
const samples = []
const streamedUpdates = new Map()
let concurrency

try {
  const outputScript = [
    `for (let index = 0; index < ${OUTPUT_CHUNKS}; index += 1) {`,
    `  console.log('${OUTPUT_MARKER} ' + 'x'.repeat(${OUTPUT_CHUNK_CHARACTERS}))`,
    `  await new Promise((resolveWait) => setTimeout(resolveWait, ${OUTPUT_DELAY_MS}))`,
    '}',
    `if (process.argv.includes('--hang')) {`,
    `  await new Promise((resolveWait) => setTimeout(resolveWait, ${ABORT_TOOL_SLEEP_MS}))`,
    '}',
    'console.log(process.env.CHURN_NAME + " final output")'
  ].join('\n')
  const workspace = await fixture.root.folder('churn-workspace', {
    'README.md': '# Native session churn\n',
    'churn-output.mjs': outputScript
  })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: REPORT_DIR
  })
  heapSampler = await createHeapSampler(application.app, application.page)
  await application.page.exposeFunction(
    'observeChurnToolUpdate',
    (agentId, toolCallId, characters) => {
      const observerKey = `${agentId}:${toolCallId}`
      const prior = streamedUpdates.get(observerKey) ?? { count: 0, maxCharacters: 0 }
      streamedUpdates.set(observerKey, {
        count: prior.count + 1,
        maxCharacters: Math.max(prior.maxCharacters, characters)
      })
    }
  )
  await application.page.evaluate(() => {
    window.vengeance.on('engine:event', ({ agentId, event }) => {
      if (event.type !== 'tool_execution_update') return
      const characters = (event.partialResult?.content ?? [])
        .filter((block) => block.type === 'text')
        .reduce((length, block) => length + block.text.length, 0)
      void window.observeChurnToolUpdate(agentId, event.toolCallId, characters)
    })
  })
  const scratch = await application.openWorkspace({
    cwd: workspace,
    args: launchArguments('pi', SCRATCH_NAME, true)
  })
  const settingsBefore = await Promise.all([
    fixture.piDirectory.readText('settings.json'),
    readFile(join(fixture.primeDirectory, 'settings.json'), 'utf8')
  ])
  if (FIXED_CORPUS_ONLY) {
    await runFixedCorpus(
      application,
      fixture,
      workspace,
      scratch,
      heapSampler,
      {
        launchArguments,
        runNativeTool,
        closeSession,
        activateSession,
        step,
        scratchName: SCRATCH_NAME
      },
      REPORT_DIR
    )
  } else {
    concurrency = await step(
      'eight native sessions share a workspace with isolated disclosures',
      () => checkConcurrentSessions(application, fixture, workspace, scratch)
    )

    for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
      for (const engine of ['pi', 'prime']) {
        await step(
          `${engine}: create, stream tool, switch, close and reopen cycle ${cycle + 1}`,
          async () => {
            const name = `Churn ${engine} cycle ${cycle + 1}`
            const started = performance.now()
            const args = launchArguments(engine, name)
            if (engine === 'pi') args.launch = { env: { CHURN_NAME: name } }
            const opened = await application.openWorkspace({ cwd: workspace, args })
            const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
            server.queue(turn.text(`${name} warmed.`))
            await application.send('Reply briefly to warm this native session')
            await application.waitForSettle()
            const resultCharacters = await runNativeTool(
              application,
              fixture,
              engine,
              name,
              `churn-${engine}-${cycle}`
            )
            const before = await application.rpc({ type: 'get_state' }, opened.agentId)
            assert.ok(before.sessionFile)
            const switchAwayMs = await activateSession(application, SCRATCH_NAME, scratch.agentId)
            const switchBackMs = await activateSession(application, name, opened.agentId)
            const toggle = application.page.locator('[data-tool-row] button[aria-expanded]').last()
            assert.equal(
              await toggle.getAttribute('aria-expanded'),
              'true',
              'choice survives tab switch'
            )
            if (cycle === 0) await application.screenshot(`churn-tool-${engine}`)
            const detached = await closeSession(application, name, opened.agentId)
            const resumed = await application.openWorkspace({
              cwd: workspace,
              args: { engine, sessionPath: before.sessionFile }
            })
            const after = await application.rpc({ type: 'get_state' }, resumed.agentId)
            assert.equal(after.sessionId, before.sessionId)
            assert.equal(after.messageCount, before.messageCount)
            await application.page
              .getByText(`${name} answer after native output.`, { exact: true })
              .waitFor()
            const reopenedToggle = application.page
              .locator('[data-tool-row] button[aria-expanded]')
              .last()
            assert.equal(
              await reopenedToggle.getAttribute('aria-expanded'),
              'false',
              'closed session releases its explicit disclosure choice'
            )
            if (engine === 'prime') {
              const current = (await application.invoke('engine:list')).find(
                (agent) => agent.agentId === resumed.agentId
              )
              assert.equal(current.nativeAgentId, detached.nativeAgentId)
              assert.equal(current.pid, detached.pid)
            }
            await closeSession(application, name, resumed.agentId, true)
            const temporaryName = `Temporary ${engine} cycle ${cycle + 1}`
            const temporary = await application.openWorkspace({
              cwd: workspace,
              args: launchArguments(engine, temporaryName, true)
            })
            server.queue(turn.text(`${temporaryName} finished.`))
            await application.send('Reply briefly in the temporary session')
            await application.waitForSettle()
            await closeSession(application, temporaryName, temporary.agentId)
            metrics.push({
              engine,
              cycle,
              resultCharacters,
              switchAwayMs,
              switchBackMs,
              elapsedMs: performance.now() - started
            })
          }
        )
      }

      await step(`settings backend isolation after cycle ${cycle + 1}`, () =>
        switchSettings(application, fixture, workspace, cycle === 0)
      )
      const agents = await application.invoke('engine:list')
      assert.deepEqual(
        agents.map((agent) => agent.agentId),
        [scratch.agentId]
      )
      assert.equal((await application.invoke('engine:background-list', 'prime')).length, 0)
      const sample = await heapSampler.sample(`cycle-${cycle + 1}`)
      sample.liveWorkers = agents.length
      sample.primeResidents = (await application.invoke('engine:background-list', 'prime')).length
      samples.push(sample)
      console.log(
        `      retained sample: renderer ${(sample.rendererBytes / BYTES_PER_MIB).toFixed(1)} MiB; ` +
          `main ${(sample.mainBytes / BYTES_PER_MIB).toFixed(1)} MiB`
      )
    }

    const baseline = samples[0]
    const final = samples.at(-1)
    const rendererGrowth = final.rendererBytes - baseline.rendererBytes
    const mainGrowth = final.mainBytes - baseline.mainBytes
    const lateBaseline = samples.at(-LATE_SAMPLE_COUNT)
    const lateRendererGrowth = final.rendererBytes - lateBaseline.rendererBytes
    const lateMainGrowth = final.mainBytes - lateBaseline.mainBytes
    assert.ok(
      rendererGrowth < MAX_RETAINED_RENDERER_BYTES,
      `${rendererGrowth} retained renderer bytes`
    )
    assert.ok(mainGrowth < MAX_RETAINED_MAIN_BYTES, `${mainGrowth} retained main bytes`)
    assert.ok(
      lateRendererGrowth < MAX_LATE_RENDERER_BYTES,
      `${lateRendererGrowth} late renderer bytes`
    )
    assert.ok(lateMainGrowth < MAX_LATE_MAIN_BYTES, `${lateMainGrowth} late main bytes`)
    assert.ok(streamedUpdates.size > 0, 'native tool updates were observed through public IPC')
    const leftoverProcesses = (await processTable()).filter((entry) =>
      entry.commandLine.toLowerCase().includes(fixture.root.dir.toLowerCase())
    )
    assert.deepEqual(
      leftoverProcesses.map((entry) => ({ name: entry.name, pid: entry.pid })),
      [],
      'native tool subprocesses belonging to the fixture terminate before app cleanup'
    )
    assert.deepEqual(
      await Promise.all([
        fixture.piDirectory.readText('settings.json'),
        readFile(join(fixture.primeDirectory, 'settings.json'), 'utf8')
      ]),
      settingsBefore,
      'read-only backend switches do not rewrite account settings'
    )
    await application.screenshot('churn-clean-final')
    application.assertNoErrors()
    await mkdir(REPORT_DIR, { recursive: true })
    await writeFile(
      join(REPORT_DIR, 'session-churn-metrics.json'),
      JSON.stringify(
        {
          concurrency,
          samples,
          metrics,
          streamedUpdates: [...streamedUpdates.values()],
          rendererGrowth,
          mainGrowth,
          lateRendererGrowth,
          lateMainGrowth
        },
        null,
        2
      )
    )
  }
} catch (error) {
  failure = error
  await application?.screenshot(`${SUITE_NAME}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await heapSampler?.dispose().catch(() => undefined)
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE_NAME} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE_NAME} passed`)
}
