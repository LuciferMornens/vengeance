import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { reportShotsDir } from '../lib/app.mjs'
import { isAlive } from '../lib/processes.mjs'
import { runSuite } from '../lib/suite.mjs'
import { assertToolHistory, writeToolHistory } from './long-tool-history.mjs'

const TOOL_COUNTS = [1000, 3000, 10_000]
const REOPEN_COUNT = 3
const MAX_OPEN_MS = 8000
const MAX_FAILURE_STDERR_CHARACTERS = 4000
const MAX_SWITCH_MS = 2000
const MAX_MOUNTED_SEGMENTS = 80
const BYTES_PER_MIB = 1024 * 1024
const MAX_RETAINED_HEAP_BYTES = 16 * BYTES_PER_MIB
const PROCESS_EXIT_TIMEOUT_MS = 10_000
const PROCESS_POLL_INTERVAL_MS = 100
const REPORT_DIR = reportShotsDir('performance')

async function rendererHeap(debuggerSession) {
  await debuggerSession.send('HeapProfiler.collectGarbage')
  const usage = await debuggerSession.send('Runtime.getHeapUsage')
  return usage.usedSize
}

async function closeSession(app, name, agentId) {
  const row = app.page
    .locator('section[aria-label="Open sessions"] [data-session-row]', { hasText: name })
    .first()
  const engines = await app.invoke('engine:list')
  const engine = engines.find((candidate) => candidate.agentId === agentId)
  assert.ok(engine, `the ${name} engine is live before closing`)
  await row.hover()
  await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
  await app.page.waitForFunction(
    (closedId) => window.__vengeanceTest.agentState(closedId) === null,
    agentId
  )
  const deadline = performance.now() + PROCESS_EXIT_TIMEOUT_MS
  while (engine.pid && isAlive(engine.pid) && performance.now() < deadline) {
    await app.page.waitForTimeout(PROCESS_POLL_INTERVAL_MS)
  }
  assert.ok(!engine.pid || !isAlive(engine.pid), `closed engine ${engine.pid} exited`)
  assert.equal(
    (await app.invoke('engine:list')).some((candidate) => candidate.agentId === agentId),
    false,
    'the engine manager drops closed sessions'
  )
}

await runSuite(
  'performance-long-tools',
  async ({ agentDir, app, step }) => {
    const metrics = []
    const debuggerSession = await app.page.context().newCDPSession(app.page)
    const { agentId: scratchAgent, cwd } = await step('open an isolated workspace', () =>
      app.openWorkspace()
    )
    const scratchName = await app.page.getByRole('button', { name: 'Rename session' }).innerText()
    const baselineHeapBytes = await rendererHeap(debuggerSession)

    try {
      for (const count of TOOL_COUNTS) {
        const name = `Performance tools ${count}`
        await step(`write ${count} tool calls with success, error and interrupted results`, () =>
          writeToolHistory(agentDir, cwd, count)
        )
        const row = app.page.locator('[data-session-row]', { hasText: name }).first()
        await row.waitFor()

        let activeAgent
        await step(`resume ${count} tools and verify every pairing`, async () => {
          const started = performance.now()
          await row.click()
          try {
            await app.page
              .locator('[data-transcript-scroll]')
              .getByText(`Long tool history ${count} is ready.`, { exact: true })
              .waitFor({ timeout: MAX_OPEN_MS })
          } catch (error) {
            const selectedAgentId = await app.activeAgentId()
            const selectedAgent = await app.agentState(selectedAgentId)
            const engines = await app.invoke('engine:list')
            const diagnostics = await Promise.all(
              engines
                .filter(
                  (engine) => engine.status === 'crashed' || engine.agentId === selectedAgentId
                )
                .map(async (engine) => ({
                  agentId: engine.agentId,
                  engine: engine.engine,
                  status: engine.status,
                  error: engine.error,
                  pid: engine.pid,
                  sessionPath: engine.args.sessionPath,
                  stderr: (await app.invoke('engine:stderr', engine.agentId)).slice(
                    -MAX_FAILURE_STDERR_CHARACTERS
                  )
                }))
            )
            console.error(
              `      resume diagnostics: ${JSON.stringify({
                selectedAgentId,
                status: selectedAgent?.status,
                error: selectedAgent?.error,
                entries: selectedAgent?.entries.length,
                engines: diagnostics
              })}`
            )
            throw error
          }
          const openMs = performance.now() - started
          activeAgent = await app.activeAgentId()
          assert.notEqual(activeAgent, scratchAgent)
          await assertToolHistory(app, count)
          const mountedSegments = await app.page.locator('[data-segment]').count()
          assert.ok(mountedSegments < MAX_MOUNTED_SEGMENTS, `${mountedSegments} mounted segments`)
          assert.ok(openMs < MAX_OPEN_MS, `resume took ${openMs.toFixed(0)} ms`)
          const heapBytes = await rendererHeap(debuggerSession)
          metrics.push({ count, openMs, mountedSegments, heapBytes })
          console.log(
            `      ${count} tools: ${openMs.toFixed(0)} ms, ${mountedSegments} segments, ` +
              `${(heapBytes / BYTES_PER_MIB).toFixed(1)} MiB renderer heap`
          )
        })

        await step(`switch away from and back to ${count} tools`, async () => {
          const openRows = app.page.locator('section[aria-label="Open sessions"]')
          await openRows.locator('[data-session-row]', { hasText: scratchName }).first().click()
          await app.page.waitForFunction(
            (expected) => window.__vengeanceTest.activeAgentId() === expected,
            scratchAgent
          )
          const started = performance.now()
          await openRows.locator('[data-session-row]', { hasText: name }).first().click()
          await app.page
            .locator('[data-transcript-scroll]')
            .getByText(`Long tool history ${count} is ready.`, { exact: true })
            .waitFor()
          const switchMs = performance.now() - started
          metrics.at(-1).switchMs = switchMs
          assert.ok(switchMs < MAX_SWITCH_MS, `switch took ${switchMs.toFixed(0)} ms`)
          await assertToolHistory(app, count)
          console.log(`      cached switch: ${switchMs.toFixed(0)} ms`)
        })

        await app.screenshot(`long-tools-${count}`)
        await step(`close ${count} tools and release engine and renderer state`, () =>
          closeSession(app, name, activeAgent)
        )
      }

      const largestCount = TOOL_COUNTS.at(-1)
      const largestName = `Performance tools ${largestCount}`
      await step(`reopen and close the largest history ${REOPEN_COUNT} times`, async () => {
        for (let cycle = 0; cycle < REOPEN_COUNT; cycle += 1) {
          await app.page.locator('[data-session-row]', { hasText: largestName }).first().click()
          await app.page
            .locator('[data-transcript-scroll]')
            .getByText(`Long tool history ${largestCount} is ready.`, { exact: true })
            .waitFor({ timeout: MAX_OPEN_MS })
          const agentId = await app.activeAgentId()
          await assertToolHistory(app, largestCount)
          await closeSession(app, largestName, agentId)
        }
      })

      await step(
        'closed histories leave bounded renderer heap and only the scratch engine',
        async () => {
          const finalHeapBytes = await rendererHeap(debuggerSession)
          const retainedHeapBytes = finalHeapBytes - baselineHeapBytes
          assert.ok(
            retainedHeapBytes < MAX_RETAINED_HEAP_BYTES,
            `${(retainedHeapBytes / BYTES_PER_MIB).toFixed(1)} MiB retained after closing`
          )
          const engines = await app.invoke('engine:list')
          assert.deepEqual(
            engines.map((engine) => engine.agentId),
            [scratchAgent]
          )
          await mkdir(REPORT_DIR, { recursive: true })
          await writeFile(
            join(REPORT_DIR, 'long-tools-metrics.json'),
            JSON.stringify(
              { baselineHeapBytes, finalHeapBytes, retainedHeapBytes, metrics },
              null,
              2
            )
          )
          console.log(`      retained heap: ${(retainedHeapBytes / BYTES_PER_MIB).toFixed(1)} MiB`)
        }
      )
    } finally {
      await debuggerSession.detach()
    }
  },
  { launch: { outDir: REPORT_DIR } }
)
