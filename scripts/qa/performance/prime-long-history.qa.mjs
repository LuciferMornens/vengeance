import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { sessionIdentityPath } from '../../../src/shared/session-identity.ts'
import { until } from '../chat/helpers.mjs'
import {
  createEngineFixture,
  PRIME_MODELS,
  PRIME_PROVIDER
} from '../engines/integration-fixture.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { isAlive } from '../lib/processes.mjs'
import { createHeapSampler } from './heap-sampler.mjs'
import { assertToolHistory, writeToolHistory } from './long-tool-history.mjs'

const TOOL_COUNT = 3000
const REOPEN_COUNT = 3
const MAX_OPEN_MS = 8000
const MAX_SWITCH_MS = 2000
const MAX_UI_FRAME_GAP_MS = 1000
const MAX_MOUNTED_SEGMENTS = 80
const MAX_SCRATCH_SEGMENTS = 10
const MEBIBYTE = 1024 * 1024
const MAX_RETAINED_RENDERER_BYTES = 16 * MEBIBYTE
const MAX_RETAINED_MAIN_BYTES = 24 * MEBIBYTE
const WORKER_EXIT_MS = 10_000
const HISTORY_NAME = `Performance tools ${TOOL_COUNT}`
const FINAL_TEXT = `Long tool history ${TOOL_COUNT} is ready.`
const OUTPUT_DIRECTORY = reportShotsDir('prime-long-history')
const fixture = await createEngineFixture()
const report = { toolCount: TOOL_COUNT, measurements: [], screenshots: [] }
let application
let heapSampler
let failure

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function messageDigest(path) {
  const messages = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .filter((entry) => entry.type === 'message')
  return digest(JSON.stringify(messages))
}

async function frameProbe(start) {
  return application.page.evaluate((begin) => {
    if (!begin) {
      const probe = window.__qaPrimeLongFrames
      probe.running = false
      delete window.__qaPrimeLongFrames
      return Math.max(0, ...probe.gaps)
    }
    const probe = { last: performance.now(), gaps: [], running: true }
    window.__qaPrimeLongFrames = probe
    const sample = (now) => {
      probe.gaps.push(now - probe.last)
      probe.last = now
      if (probe.running) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    return 0
  }, start)
}

async function measure(label, maximumMs, action) {
  console.log(`  • ${label}`)
  await frameProbe(true)
  const started = performance.now()
  try {
    const result = await action()
    await application.page.evaluate(
      () =>
        new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
        )
    )
    const elapsedMs = performance.now() - started
    const maximumFrameGapMs = await frameProbe(false)
    const mountedSegments = await application.page.locator('[data-segment]').count()
    report.measurements.push({ label, elapsedMs, maximumFrameGapMs, mountedSegments })
    assert.ok(elapsedMs < maximumMs, `${label} took ${elapsedMs.toFixed(0)}ms`)
    assert.ok(
      maximumFrameGapMs < MAX_UI_FRAME_GAP_MS,
      `${label} blocked frames for ${maximumFrameGapMs}ms`
    )
    assert.ok(mountedSegments < MAX_MOUNTED_SEGMENTS, `${mountedSegments} mounted segments`)
    console.log(`    ✓ ${elapsedMs.toFixed(0)}ms; frame gap ${maximumFrameGapMs.toFixed(0)}ms`)
    return result
  } finally {
    await application.page.evaluate(() => {
      if (window.__qaPrimeLongFrames) window.__qaPrimeLongFrames.running = false
      delete window.__qaPrimeLongFrames
    })
  }
}

async function waitForHistory() {
  await application.composer()
  await application.page
    .locator('[data-transcript-scroll]')
    .getByText(FINAL_TEXT, { exact: true })
    .waitFor({ timeout: MAX_OPEN_MS })
}

async function openHistory(path) {
  const agentId = await application.test('openSession', path, 'prime')
  assert.ok(agentId, 'saved history opens through the public file action')
  await waitForHistory()
  const info = (await application.invoke('engine:list')).find((entry) => entry.agentId === agentId)
  assert.equal(info?.engine, 'prime')
  assert.equal(info.status, 'ready')
  assert.ok(info.pid, 'the opened Prime history reports its native worker')
  return info
}

async function detach(info) {
  await application.test('closeSession', info.agentId)
  await until(
    async () =>
      !(await application.invoke('engine:list')).some((entry) => entry.agentId === info.agentId),
    {
      label: 'the long-history app handle closes'
    }
  )
  assert.ok(isAlive(info.pid), 'Close tab keeps the saved native worker alive')
  const residents = await application.invoke('engine:background-list', 'prime')
  assert.ok(
    residents.some(
      (resident) =>
        resident.id === info.nativeAgentId &&
        sessionIdentityPath(resident.sessionPath ?? '') === sessionIdentityPath(info.sessionFile)
    )
  )
}

async function stopResident(info) {
  await application.invoke('engine:background-stop', 'prime', {
    id: info.nativeAgentId,
    sessionPath: info.sessionFile
  })
  await until(() => !isAlive(info.pid), {
    label: 'the explicitly stopped history worker exits',
    timeoutMs: WORKER_EXIT_MS
  })
}

try {
  const workspace = await fixture.root.folder('long-native-history')
  const scratchWorkspace = await fixture.root.folder('other-workspace')
  const scratchPath = await writeToolHistory(fixture.piDirectory, scratchWorkspace, 0)
  const sourcePath = await writeToolHistory(fixture.piDirectory, workspace, TOOL_COUNT)
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const scratch = await application.openWorkspace({
    cwd: scratchWorkspace,
    args: { engine: 'pi', sessionPath: scratchPath }
  })
  const warm = await application.openWorkspace({
    cwd: workspace,
    args: { engine: 'prime', noSession: true, name: 'Native metadata warmup' }
  })
  const warmInfo = (await application.invoke('engine:list')).find(
    (entry) => entry.agentId === warm.agentId
  )
  assert.ok(warmInfo?.pid, 'the temporary native warmup reports its worker')
  await application.test('closeSession', warm.agentId)
  await until(() => !isAlive(warmInfo.pid), {
    label: 'temporary native warmup exits',
    timeoutMs: WORKER_EXIT_MS
  })
  await application.test('openSession', scratchPath, 'pi')
  heapSampler = await createHeapSampler(application.app, application.page)
  report.baselineHeap = await heapSampler.sample('before-long-history')

  const sourceId = await application.test('openSession', sourcePath, 'pi')
  await waitForHistory()
  await assertToolHistory(application, TOOL_COUNT)
  const sourceDigest = digest(await readFile(sourcePath))
  const transferStarted = performance.now()
  let native = await application.invoke('engine:switch', sourceId, {
    cwd: workspace,
    engine: 'prime',
    provider: PRIME_PROVIDER,
    model: PRIME_MODELS.reasoning,
    thinking: 'off'
  })
  await waitForHistory()
  await until(
    async () => {
      const current = await application.page.evaluate(() => {
        const active = window.__vengeanceTest.agentState()
        return { engine: active?.info.engine, path: active?.session?.sessionFile }
      })
      return (
        current.engine === 'prime' &&
        sessionIdentityPath(current.path ?? '') === sessionIdentityPath(native.sessionFile)
      )
    },
    { label: 'native history handoff reaches the renderer' }
  )
  await assertToolHistory(application, TOOL_COUNT)
  assert.equal(native.engine, 'prime')
  assert.equal(native.sessionName, HISTORY_NAME)
  assert.notEqual(native.sessionFile, sourcePath)
  const header = JSON.parse((await readFile(native.sessionFile, 'utf8')).split('\n')[0])
  assert.equal(header.rlmDepth, 0, 'the native writer produces an explicit depth-zero root')
  report.nativeHeader = header
  report.nativeIdentity = await fixture.verifyPrimeExecutable(application, sourceId)
  report.transferMs = performance.now() - transferStarted
  report.nativeMessageDigest = await messageDigest(native.sessionFile)
  report.screenshots.push(await application.screenshot('native-writer-tool-history'))
  await detach(native)
  await stopResident(native)

  for (let cycle = 0; cycle < REOPEN_COUNT; cycle++) {
    await application.test('openSession', scratchPath, 'pi')
    const stoppedPid = native.pid
    native = await measure(`cold-native-file-open-${cycle + 1}`, MAX_OPEN_MS, () =>
      openHistory(native.sessionFile)
    )
    assert.notEqual(native.pid, stoppedPid, 'cold reopen starts a native worker')
    assert.equal(
      (await application.rpc({ type: 'get_state' }, native.agentId)).sessionId,
      header.id
    )
    await assertToolHistory(application, TOOL_COUNT)
    await detach(native)
    const resident = native
    native = await measure(`resident-reopen-${cycle + 1}`, MAX_OPEN_MS, () =>
      openHistory(resident.sessionFile)
    )
    assert.equal(native.pid, resident.pid)
    assert.equal(native.nativeAgentId, resident.nativeAgentId)
    await assertToolHistory(application, TOOL_COUNT)
    await measure(`cached-workspace-switch-away-${cycle + 1}`, MAX_SWITCH_MS, async () => {
      await application.test('openSession', scratchPath, 'pi')
      await application.composer()
      assert.equal(await application.activeAgentId(), scratch.agentId)
      assert.equal(
        sessionIdentityPath((await application.appState()).prefs.activeWorkspace),
        sessionIdentityPath(scratchWorkspace)
      )
    })
    await measure(`cached-workspace-switch-back-${cycle + 1}`, MAX_SWITCH_MS, async () => {
      const current = await application.test('openSession', native.sessionFile, 'prime')
      assert.equal(current, native.agentId)
      await waitForHistory()
      assert.equal(
        sessionIdentityPath((await application.appState()).prefs.activeWorkspace),
        sessionIdentityPath(workspace)
      )
    })
    await assertToolHistory(application, TOOL_COUNT)
    if (cycle === 0)
      report.screenshots.push(
        await application.screenshot('native-cold-resident-and-cached-history')
      )
    await detach(native)
    await stopResident(native)
  }

  await application.test('openSession', scratchPath, 'pi')
  await application.page.waitForFunction(
    (maximum) => document.querySelectorAll('[data-segment]').length < maximum,
    MAX_SCRATCH_SEGMENTS
  )
  report.finalHeap = await heapSampler.sample('after-long-history-closed')
  report.rendererGrowth = report.finalHeap.rendererBytes - report.baselineHeap.rendererBytes
  report.mainGrowth = report.finalHeap.mainBytes - report.baselineHeap.mainBytes
  assert.ok(
    report.rendererGrowth < MAX_RETAINED_RENDERER_BYTES,
    `${report.rendererGrowth} renderer bytes retained`
  )
  assert.ok(report.mainGrowth < MAX_RETAINED_MAIN_BYTES, `${report.mainGrowth} main bytes retained`)
  assert.deepEqual(
    (await application.invoke('engine:list')).map((entry) => entry.agentId),
    [scratch.agentId]
  )
  assert.deepEqual(await application.invoke('engine:background-list', 'prime'), [])
  assert.equal(await messageDigest(native.sessionFile), report.nativeMessageDigest)
  assert.equal(digest(await readFile(sourcePath)), sourceDigest, 'the source history stays intact')
  report.providerRequests = {
    pi: fixture.piServer.requests.length,
    prime: fixture.primeServer.requests.length
  }
  assert.deepEqual(
    report.providerRequests,
    { pi: 0, prime: 0 },
    'history inspection never asks a provider'
  )
  report.screenshots.push(await application.screenshot('native-long-history-released'))
  application.assertNoErrors()
} catch (error) {
  failure = error
  report.failure = error.stack ?? String(error)
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await heapSampler?.dispose().catch((error) => {
    failure ??= error
  })
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(
    join(OUTPUT_DIRECTORY, 'report.json'),
    `${JSON.stringify({ ...report, failure: failure?.stack }, null, 2)}\n`
  )
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(
    `✓ native Prime long history: ${TOOL_COUNT} tools; ` +
      `${report.measurements.length} timing gates passed`
  )
}
