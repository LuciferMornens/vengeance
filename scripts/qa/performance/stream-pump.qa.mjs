import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { isAlive } from '../lib/processes.mjs'
import { runSuite } from '../lib/suite.mjs'
import { SessionBuilder, workspaceSessionDir } from '../sessions/lib/session-files.mjs'

const HISTORY_TURNS = 1000
const STREAM_CHUNK_SIZE = 8
const STREAM_DELAY_MS = 8
const OBSERVATION_MS = 1500
const MIN_PROGRESS_SAMPLES = 12
const MAX_REVEAL_GAP_MS = 250
const CALLBACK_SETTLE_MS = 1200
const REPORT_DIR = reportShotsDir('performance')
const HISTORY_NAME = 'Streaming over a long history'
const STREAM_SENTENCE_COUNT = 100
const BURST_THINKING_SENTENCE_COUNT = 30
const BURST_TEXT_SENTENCE_COUNT = 40
const WRITTEN_LINE_COUNT = 50
const MIN_ABORTED_TEXT_LENGTH = 100
const STREAM_TEXT = 'Visible text grows on every animation frame. '.repeat(STREAM_SENTENCE_COUNT)
const BURST_THINKING = 'Think Ω 😀 \u2028with separators\u2029 and JSON "escapes". '.repeat(
  BURST_THINKING_SENTENCE_COUNT
)
const BURST_TEXT = 'Burst text Ω 😀 \u2028is exact\u2029 after thousands of deltas. '.repeat(
  BURST_TEXT_SENTENCE_COUNT
)
const WRITTEN_CONTENT = 'First line Ω 😀\r\n"quoted" \\ path\n'.repeat(WRITTEN_LINE_COUNT)
const WRITTEN_PATH = join('nested folder', 'burst Ω.txt')
const BURST_TOOL_ID = 'perf-burst-write'
const ERROR_TOOL_ID = 'perf-burst-error'

async function historicalKeys(app) {
  return app.page.evaluate((historyLength) => {
    const agent = window.__vengeanceTest.agentState()
    return agent.entries.slice(0, historyLength).map((entry) => entry.key)
  }, HISTORY_TURNS * 2)
}

async function observeLiveReveal(page) {
  return page.evaluate(
    ({ observationMs }) =>
      new Promise((resolveSamples) => {
        const samples = []
        const started = performance.now()
        let priorLength = -1
        const sample = () => {
          const length = document.querySelector('.md-live')?.textContent?.length ?? 0
          const running = document.querySelector('[data-composer][data-running]') !== null
          if (length !== priorLength) {
            samples.push({ length, running, elapsedMs: performance.now() - started })
            priorLength = length
          }
          if (performance.now() - started < observationMs) requestAnimationFrame(sample)
          else resolveSamples(samples)
        }
        requestAnimationFrame(sample)
      }),
    { observationMs: OBSERVATION_MS }
  )
}

async function finalAssistantBlocks(app, text) {
  const state = await app.agentState()
  const assistant = state.entries.find(
    (entry) =>
      entry.message.role === 'assistant' &&
      entry.message.content.some((block) => block.type === 'text' && block.text === text)
  )
  assert.ok(assistant, 'the renderer holds the exact final assistant text')
  return assistant.message.content
}

await runSuite(
  'performance-stream-pump',
  async ({ server, agentDir, app, step }) => {
    const { cwd } = await step('seed and resume a long settled transcript', async () => {
      const cwd = await app.createWorkspace()
      const builder = new SessionBuilder({ cwd, stepMs: 1 })
      builder.modelChange()
      for (let index = 0; index < HISTORY_TURNS; index += 1) {
        builder.user(`Historical prompt ${index}`)
        builder.assistant(`Historical response ${index}`)
      }
      builder.name(HISTORY_NAME)
      const sessionFile = await builder.write(workspaceSessionDir(agentDir, cwd))
      await app.openWorkspace({ cwd, args: { sessionPath: sessionFile, thinking: 'low' } })
      return { cwd }
    })
    const initialKeys = await historicalKeys(app)
    assert.equal(initialKeys.length, HISTORY_TURNS * 2, 'the full settled fixture was resumed')

    await step('sustained deltas reveal visible text continuously before settling', async () => {
      const from = server.requests.length
      server.queue(
        turn.text(STREAM_TEXT, { chunkSize: STREAM_CHUNK_SIZE, delayMs: STREAM_DELAY_MS })
      )
      await app.send('Stream continuously over the settled history')
      const request = await server.waitForRequest(undefined, { from })
      const samples = await observeLiveReveal(app.page)
      assert.equal(request.outcome, 'streaming', 'the observations happen during the live request')
      const visible = samples.filter((sample) => sample.running && sample.length > 0)
      assert.ok(visible.length >= MIN_PROGRESS_SAMPLES, `${visible.length} live growth samples`)
      let longestGapMs = 0
      for (let index = 1; index < visible.length; index += 1) {
        assert.ok(visible[index].length > visible[index - 1].length, 'reveal grows monotonically')
        longestGapMs = Math.max(
          longestGapMs,
          visible[index].elapsedMs - visible[index - 1].elapsedMs
        )
      }
      assert.ok(
        longestGapMs < MAX_REVEAL_GAP_MS,
        `reveal stalled for ${longestGapMs.toFixed(0)} ms`
      )
      console.log(
        `      ${visible.length} live growth samples; longest gap ${longestGapMs.toFixed(0)} ms`
      )
      await app.screenshot('stream-pump-progressive', { settleMs: 0 })
      await app.waitForSettle()
      await finalAssistantBlocks(app, STREAM_TEXT)
      assert.deepEqual(
        await historicalKeys(app),
        initialKeys,
        'settled message identities stay stable'
      )
    })

    await step(
      'burst thinking, text and argument deltas keep end boundaries and exact results',
      async () => {
        const from = server.requests.length
        server.queue(
          {
            thinking: BURST_THINKING,
            text: BURST_TEXT,
            chunkSize: 1,
            toolCalls: [
              {
                id: BURST_TOOL_ID,
                name: 'write',
                args: { path: WRITTEN_PATH, content: WRITTEN_CONTENT }
              },
              { id: ERROR_TOOL_ID, name: 'read', args: { path: 'missing-pump-file.txt' } }
            ]
          },
          turn.text('Burst calls completed exactly.')
        )
        await app.send('Exercise thousands of mixed streaming deltas')
        await app.waitForSettle()
        const blocks = await finalAssistantBlocks(app, BURST_TEXT)
        const thinking = blocks.find((block) => block.type === 'thinking')
        assert.equal(thinking.thinking, BURST_THINKING)
        assert.ok(thinking.thinkingSignature, 'the final thinking signature survives the end event')
        const call = blocks.find((block) => block.type === 'toolCall' && block.id === BURST_TOOL_ID)
        assert.deepEqual(call.arguments, { path: WRITTEN_PATH, content: WRITTEN_CONTENT })
        assert.equal(await readFile(join(cwd, WRITTEN_PATH), 'utf8'), WRITTEN_CONTENT)
        const request = await server.waitForRequest(
          (candidate) =>
            inspectRequest(candidate).toolResults.some(
              (result) => result.toolCallId === BURST_TOOL_ID
            ),
          { from }
        )
        const results = inspectRequest(request).toolResults
        assert.equal(results.find((result) => result.toolCallId === BURST_TOOL_ID).isError, false)
        assert.equal(results.find((result) => result.toolCallId === ERROR_TOOL_ID).isError, true)
        const state = await app.agentState()
        assert.equal(state.tools[BURST_TOOL_ID].status, 'done')
        assert.equal(state.tools[ERROR_TOOL_ID].status, 'error')
        assert.deepEqual(await historicalKeys(app), initialKeys)
        assert.equal(state.streaming, null, 'the terminal message flush clears the live tail')
      }
    )

    await step('abort flushes partial deltas and the next response has no late text', async () => {
      const from = server.requests.length
      server.queue(
        turn.hang({ text: STREAM_TEXT, chunkSize: STREAM_CHUNK_SIZE, delayMs: STREAM_DELAY_MS })
      )
      await app.send('Abort this streamed answer early')
      const request = await server.waitForRequest(undefined, { from })
      await app.page.waitForFunction(
        (minimumLength) =>
          (document.querySelector('.md-live')?.textContent?.length ?? 0) > minimumLength,
        MIN_ABORTED_TEXT_LENGTH
      )
      await app.page.getByRole('button', { name: 'Stop', exact: true }).click()
      assert.equal(await server.waitForOutcome(request), 'aborted')
      await app.waitForSettle()
      const aborted = (await app.agentState()).entries.at(-1).message
      assert.equal(aborted.stopReason, 'aborted')
      const partial = aborted.content.find((block) => block.type === 'text').text
      assert.ok(partial.length > 0 && partial.length < STREAM_TEXT.length)
      assert.ok(STREAM_TEXT.startsWith(partial), 'partial deltas stay in their original order')
      server.queue(turn.text('New response after abort.'))
      await app.send('Respond after the abort')
      await app.waitForSettle()
      await app.page.waitForTimeout(CALLBACK_SETTLE_MS)
      const state = await app.agentState()
      assert.equal(state.streaming, null)
      assert.equal(state.entries.at(-1).message.content[0].text, 'New response after abort.')
      assert.deepEqual(await historicalKeys(app), initialKeys)
    })

    await step(
      'closing mid-stream removes the engine and ignores late refresh callbacks',
      async () => {
        const from = server.requests.length
        server.queue(
          turn.hang({ text: STREAM_TEXT, chunkSize: STREAM_CHUNK_SIZE, delayMs: STREAM_DELAY_MS })
        )
        await app.send('Close this session while it streams')
        const request = await server.waitForRequest(undefined, { from })
        const agentId = await app.activeAgentId()
        const engine = (await app.invoke('engine:list')).find(
          (candidate) => candidate.agentId === agentId
        )
        const row = app.page
          .locator('section[aria-label="Open sessions"] [data-session-row]', {
            hasText: HISTORY_NAME
          })
          .first()
        await row.hover()
        await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
        await app.page.getByRole('dialog').getByRole('button', { name: 'Stop and close' }).click()
        await app.page.waitForFunction(
          (closedId) => window.__vengeanceTest.agentState(closedId) === null,
          agentId
        )
        assert.equal(await server.waitForOutcome(request), 'aborted')
        await app.page.waitForTimeout(CALLBACK_SETTLE_MS)
        assert.equal(await app.agentState(agentId), null)
        assert.ok(!engine.pid || !isAlive(engine.pid), 'the closed engine process exited')
        assert.equal((await app.invoke('engine:list')).length, 0)
        app.assertNoErrors()
        await app.screenshot('stream-pump-closed')
      }
    )
  },
  { launch: { outDir: REPORT_DIR } }
)
