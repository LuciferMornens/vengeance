import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { turn } from '../lib/fake-llm.mjs'
import { isAlive } from '../lib/processes.mjs'
import { waitFor } from '../settings/settings-ui.mjs'

const FIXED_CORPUS_CYCLES = 24
const EXTENDED_CORPUS_CYCLES = 36
const FIXED_WARMUP_CYCLES = 12
const CONTROL_SAMPLE_COUNT = 12
const FIXED_LATE_SAMPLE_COUNT = 6
const FIXED_UI_SETTLE_MS = 750
const CONTROL_CADENCE_MS = 2800
const MAX_FIXED_SLOPE_BYTES = 32 * 1024
const MIN_CODE_FRACTION = 0.8
const BYTES_PER_MIB = 1024 * 1024

function heapSlope(samples, member) {
  const meanIndex = (samples.length - 1) / 2
  const meanBytes = samples.reduce((total, sample) => total + sample[member], 0) / samples.length
  const numerator = samples.reduce(
    (total, sample, index) => total + (index - meanIndex) * (sample[member] - meanBytes),
    0
  )
  const denominator = Array.from(samples.keys()).reduce(
    (total, index) => total + (index - meanIndex) ** 2,
    0
  )
  return numerator / denominator
}

async function sampleFixedCorpus(application, workspace, scratchId, sampleHeap, label) {
  await application.page.waitForFunction(
    () =>
      document.querySelectorAll('[data-tool-row], [data-row-detail]').length === 0 &&
      document.querySelectorAll('[data-composer]').length === 1
  )
  await application.page.mouse.move(1200, 100)
  await application.page.waitForTimeout(FIXED_UI_SETTLE_MS)
  await application.page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.effect?.getComputedTiming().iterations === Infinity ||
          animation.playState !== 'running'
      )
  )
  const lists = await Promise.all(
    ['pi', 'prime'].map((engine) =>
      application.invoke('sessions:list', {
        cwd: workspace,
        engine
      })
    )
  )
  const listingSizes = lists.map((listing) => ({
    count: listing.sessions.length,
    characters: JSON.stringify(listing.sessions).length
  }))
  assert.deepEqual(
    listingSizes.map((listing) => listing.count),
    [1, 1]
  )
  const mountedHistoryRows = await application.page
    .locator('[data-session-list] section:not([aria-label="Open sessions"]) [data-session-row]')
    .count()
  assert.equal(mountedHistoryRows, 1, 'the saved resident is shown as background work')
  const agents = await application.invoke('engine:list')
  assert.deepEqual(
    agents.map((agent) => agent.agentId),
    [scratchId]
  )
  assert.equal((await application.invoke('engine:background-list', 'prime')).length, 1)
  const sample = await sampleHeap(label)
  return { ...sample, mountedHistoryRows, listingSizes, liveWorkers: agents.length }
}

export async function runFixedCorpus(
  application,
  fixture,
  workspace,
  scratch,
  heapSampler,
  actions,
  reportDirectory
) {
  const { launchArguments, runNativeTool, closeSession, activateSession, step, scratchName } =
    actions
  const corpus = []
  const closedAgentIds = []
  for (const engine of ['pi', 'prime']) {
    const name = `Fixed corpus ${engine}`
    const args = launchArguments(engine, name)
    if (engine === 'pi') args.launch = { env: { CHURN_NAME: name } }
    const opened = await application.openWorkspace({ cwd: workspace, args })
    const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
    server.queue(turn.text(`${name} warmed.`))
    await application.send('Seed this fixed saved history once')
    await application.waitForSettle()
    await runNativeTool(application, fixture, engine, name, `fixed-tool-${engine}`)
    const state = await application.rpc({ type: 'get_state' }, opened.agentId)
    const native = await closeSession(application, name, opened.agentId)
    closedAgentIds.push(opened.agentId)
    const digest = createHash('sha256')
      .update(await readFile(state.sessionFile))
      .digest('hex')
    corpus.push({ engine, name, path: state.sessionFile, state, native, digest })
  }
  const requestCounts = [fixture.piServer.requests.length, fixture.primeServer.requests.length]
  const samples = []
  const idleSamples = []
  let targetCycles = FIXED_CORPUS_CYCLES
  let initialSummary
  let checkpointSummary
  let finalSummary
  await step('same-cadence sampling-only idle control', async () => {
    for (let cycle = 0; cycle < CONTROL_SAMPLE_COUNT; cycle += 1) {
      await application.page.waitForTimeout(CONTROL_CADENCE_MS - FIXED_UI_SETTLE_MS)
      idleSamples.push(
        await sampleFixedCorpus(
          application,
          workspace,
          scratch.agentId,
          heapSampler.sample,
          `idle-cycle-${cycle + 1}`
        )
      )
    }
  })
  for (let cycle = 0; cycle < targetCycles; cycle += 1) {
    await step(`fixed corpus reopen and close cycle ${cycle + 1}`, async () => {
      const cycleStarted = performance.now()
      for (const history of corpus) {
        const opened = await application.openWorkspace({
          cwd: workspace,
          args: { engine: history.engine, sessionPath: history.path }
        })
        const state = await application.rpc({ type: 'get_state' }, opened.agentId)
        assert.equal(state.sessionId, history.state.sessionId)
        assert.equal(state.messageCount, history.state.messageCount)
        await application.page
          .getByText(`${history.name} answer after native output.`, {
            exact: true
          })
          .waitFor()
        const toggle = application.page.locator('[data-tool-row] button[aria-expanded]').last()
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
        await toggle.click()
        await application.page.locator('[data-row-detail]').waitFor()
        await activateSession(application, scratchName, scratch.agentId)
        await activateSession(application, history.name, opened.agentId)
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
        const native = await closeSession(application, history.name, opened.agentId)
        closedAgentIds.push(opened.agentId)
        if (history.engine === 'prime') {
          assert.equal(native.nativeAgentId, history.native.nativeAgentId)
          assert.equal(native.pid, history.native.pid)
        }
        const digest = createHash('sha256')
          .update(await readFile(history.path))
          .digest('hex')
        assert.equal(digest, history.digest, 'reopen never adds archive content')
      }
      await application.page.waitForTimeout(
        Math.max(0, CONTROL_CADENCE_MS - FIXED_UI_SETTLE_MS - (performance.now() - cycleStarted))
      )
      const sample = await sampleFixedCorpus(
        application,
        workspace,
        scratch.agentId,
        heapSampler.sample,
        `fixed-cycle-${cycle + 1}`
      )
      const { listingSizes, mountedHistoryRows } = sample
      if (samples.length) {
        assert.deepEqual(listingSizes, samples[0].listingSizes, 'cached listings stay constant')
      }
      samples.push(sample)
      if (samples.length === FIXED_WARMUP_CYCLES) {
        initialSummary = await heapSampler.snapshot(
          join(reportDirectory, 'session-fixed-corpus-initial.heapsnapshot'),
          closedAgentIds
        )
      }
      console.log(
        `      fixed corpus: renderer ${(sample.rendererBytes / BYTES_PER_MIB).toFixed(3)} ` +
          `MiB; main ${(sample.mainBytes / BYTES_PER_MIB).toFixed(3)} MiB; ${mountedHistoryRows} rows`
      )
      if (samples.length === FIXED_CORPUS_CYCLES) {
        checkpointSummary = await heapSampler.snapshot(
          join(reportDirectory, 'session-fixed-corpus-cycle-24.heapsnapshot'),
          closedAgentIds
        )
        const late = samples.slice(-FIXED_LATE_SAMPLE_COUNT)
        const rendererFailed = heapSlope(late, 'rendererBytes') >= MAX_FIXED_SLOPE_BYTES
        const mainFailed = heapSlope(late, 'mainBytes') >= MAX_FIXED_SLOPE_BYTES
        const warmed = samples[FIXED_WARMUP_CYCLES - 1]
        const rendererGrowth = sample.rendererBytes - warmed.rendererBytes
        const codeGrowth = checkpointSummary.codeBytes - initialSummary.codeBytes
        const dataGrowth =
          checkpointSummary.objectAndArrayBytes - initialSummary.objectAndArrayBytes
        const mainGrowth = sample.mainBytes - warmed.mainBytes
        const mainCodeGrowth = sample.mainCodeBytes - warmed.mainCodeBytes
        const codeDominates = rendererGrowth > 0 && codeGrowth / rendererGrowth >= MIN_CODE_FRACTION
        const mainCodeDominates = mainGrowth > 0 && mainCodeGrowth / mainGrowth >= MIN_CODE_FRACTION
        const boundedData =
          dataGrowth <= MAX_FIXED_SLOPE_BYTES &&
          checkpointSummary.closureCount <= initialSummary.closureCount &&
          checkpointSummary.closedAgentIdsPresent.length <= 1
        if (
          (rendererFailed || mainFailed) &&
          boundedData &&
          (!rendererFailed || codeDominates) &&
          (!mainFailed || mainCodeDominates)
        ) {
          targetCycles = EXTENDED_CORPUS_CYCLES
          console.log('      compiled-code warmup dominates; continue the same corpus to 36 cycles')
        }
      }
    })
  }
  assert.deepEqual(
    [fixture.piServer.requests.length, fixture.primeServer.requests.length],
    requestCounts,
    'fixed reopen cycles never call a model'
  )
  const lateSamples = samples.slice(-FIXED_LATE_SAMPLE_COUNT)
  const rendererSlope = heapSlope(lateSamples, 'rendererBytes')
  const mainSlope = heapSlope(lateSamples, 'mainBytes')
  finalSummary = await heapSampler.snapshot(
    join(reportDirectory, 'session-fixed-corpus-final.heapsnapshot'),
    closedAgentIds
  )
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(
    join(reportDirectory, 'session-fixed-corpus-metrics.json'),
    JSON.stringify(
      {
        samples,
        idleSamples,
        idleRendererSlope: heapSlope(idleSamples.slice(-FIXED_LATE_SAMPLE_COUNT), 'rendererBytes'),
        idleMainSlope: heapSlope(idleSamples.slice(-FIXED_LATE_SAMPLE_COUNT), 'mainBytes'),
        warmupCycles: FIXED_WARMUP_CYCLES,
        requestCounts,
        scratchAgentId: scratch.agentId,
        closedAgentIds,
        initialSummary,
        checkpointSummary,
        finalSummary,
        rendererSlope,
        mainSlope,
        rendererGrowth:
          samples.at(-1).rendererBytes - samples[FIXED_WARMUP_CYCLES - 1].rendererBytes,
        mainGrowth: samples.at(-1).mainBytes - samples[FIXED_WARMUP_CYCLES - 1].mainBytes
      },
      null,
      2
    )
  )
  assert.ok(rendererSlope < MAX_FIXED_SLOPE_BYTES, `${rendererSlope} renderer bytes/cycle late`)
  assert.ok(mainSlope < MAX_FIXED_SLOPE_BYTES, `${mainSlope} main bytes/cycle late`)
  const prime = corpus.find((history) => history.engine === 'prime')
  await application.invoke('engine:background-stop', 'prime', prime.native.nativeAgentId)
  await waitFor(() => !isAlive(prime.native.pid), 'fixed corpus native resident stopped')
  await application.screenshot('churn-fixed-corpus-final')
  application.assertNoErrors()
}
