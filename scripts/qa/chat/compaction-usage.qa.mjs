// Chat: token usage and cost shown versus what the fake LLM reported, the context ring versus the
// engine's contextUsage, manual /compact with instructions, auto-compaction past the threshold
// (qa-small), the transcript's compaction divider, and overflow recovery.
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  sendAndCapture,
  softSteps,
  submitCommand,
  transcriptText,
  until
} from './helpers.mjs'

/** defaultFakeModels() prices in $ per million tokens. */
const PRICE = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
const SMALL_WINDOW = 32_000

/** Compaction summary requests: the history summary and, for a split turn, the turn-prefix one. */
const isSummaryRequest = (request) => {
  const text = inspectRequest(request).lastUserText
  return (
    text.includes('<conversation>') || text.includes('earlier context from an ongoing conversation')
  )
}

/** Both possible summary answers; leftovers are dropped with server.reset() after the step. */
const summaryTurns = (label) => [
  turn.text(
    `## Goal
${label}: the user asked numbered questions.`,
    { when: isSummaryRequest }
  ),
  turn.text(`${label} (turn prefix)`, { when: isSummaryRequest })
]

const costOf = ({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) =>
  (input * PRICE.input +
    output * PRICE.output +
    cacheRead * PRICE.cacheRead +
    cacheWrite * PRICE.cacheWrite) /
  1_000_000

/** lib/format.ts formatCost / contextPercentLabel. */
const formatCost = (usd) => (usd === 0 ? '$0.00' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)
const percentLabel = (percent) => `${Math.min(100, Math.max(0, Math.round(percent)))}%`

async function footerPercent(app) {
  const meter = app.page.locator('[data-composer] .tabular').filter({ hasText: /%|—/ }).first()
  return (await meter.innerText()).trim()
}

async function headerUsage(app) {
  return app.page.locator('[data-context-usage]').getAttribute('aria-label')
}

await runSuite(
  'chat-compaction-usage',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)
    const reported = []

    await step('open on qa-small (32k window)', async () => {
      await app.openWorkspace({ args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.small}` } })
    })

    await step(
      'two turns with known usage: engine totals and cost match the fake report',
      async () => {
        const usages = [
          { input: 9000, output: 1000, cacheRead: 2000, cacheWrite: 500 },
          { input: 9500, output: 1200, cacheRead: 0, cacheWrite: 0 }
        ]
        for (const [i, usage] of usages.entries()) {
          server.queue(turn.text(`Answer number ${i + 1}.`, { usage }))
          await sendAndCapture(app, server, `Question number ${i + 1}`)
          reported.push(usage)
        }
        const stats = await app.rpc({ type: 'get_session_stats' })
        const sum = (key) => reported.reduce((total, usage) => total + usage[key], 0)
        assert.equal(stats.tokens.input, sum('input'))
        assert.equal(stats.tokens.output, sum('output'))
        assert.equal(stats.tokens.cacheRead, sum('cacheRead'))
        assert.equal(stats.tokens.cacheWrite, sum('cacheWrite'))
        const expectedCost = reported.reduce((total, usage) => total + costOf(usage), 0)
        assert.ok(
          Math.abs(stats.cost - expectedCost) < 1e-9,
          `cost ${stats.cost} vs ${expectedCost}`
        )
      }
    )

    await step('header shows the same cost; hover card lists the same token totals', async () => {
      const stats = await app.rpc({ type: 'get_session_stats' })
      await until(async () => (await headerUsage(app))?.includes(formatCost(stats.cost)), {
        label: `header cost ${formatCost(stats.cost)}`
      })
      await app.page.locator('[data-context-usage]').hover()
      const card = app.page.getByText('This session').locator('xpath=..')
      await card.waitFor()
      const text = await card.innerText()
      assert.match(text, /Input\s+19k/)
      assert.match(text, /Output\s+2\.2k/)
      assert.match(text, /Cache read\s+2\.0k/)
      assert.match(text, /Cache write\s+500/)
      assert.match(text, new RegExp(`Cost\\s+\\${formatCost(stats.cost)}`))
      await app.screenshot('usage-hover-card')
      await app.page.mouse.move(10, 400)
    })

    await step(
      'context ring = engine contextUsage (last response: input + output + cache)',
      async () => {
        const { contextUsage } = await app.rpc({ type: 'get_session_stats' })
        const last = reported.at(-1)
        const expectedTokens = last.input + last.output + last.cacheRead + last.cacheWrite
        assert.equal(contextUsage.tokens, expectedTokens, 'engine counts the last usage')
        assert.equal(contextUsage.contextWindow, SMALL_WINDOW)
        const label = percentLabel(contextUsage.percent)
        assert.equal(label, percentLabel((expectedTokens / SMALL_WINDOW) * 100))
        assert.equal(await footerPercent(app), label, 'footer ring label')
        assert.match(await headerUsage(app), new RegExp(`Context ${label}`), 'header ring label')
      }
    )

    await step(
      '/compact <instructions>: the summary request carries them; divider + toast',
      async () => {
        const from = server.requests.length
        server.queue(summaryTurns('SUMMARY-MANUAL'))
        await submitCommand(app, '/compact Keep the question numbers')
        const summaryRequest = await server.waitForRequest(isSummaryRequest, { from })
        const prompt = inspectRequest(summaryRequest).lastUserText
        assert.match(
          prompt,
          /Keep the question numbers/,
          'custom instructions in the summary prompt'
        )
        assert.match(prompt, /Question number 1/, 'conversation in the summary prompt')
        await app.page.getByText('Context compacted', { exact: true }).waitFor()
        await app.waitForSettle()
        const state = await app.agentState()
        assert.equal(state.lastCompaction?.reason, 'manual')
        assert.equal(state.lastCompaction?.aborted, false)
        const divider = app.page.getByText(/Context compacted · .* tokens summarized/)
        await divider.first().waitFor()
        await divider.first().click()
        await app.page
          .getByText(/SUMMARY-MANUAL/)
          .first()
          .waitFor()
        await app.screenshot('compaction-manual')
        server.reset()
      }
    )

    await checks.check(
      'after compaction the ring shows "—" like the engine (tokens unknown)',
      async () => {
        const { contextUsage } = await app.rpc({ type: 'get_session_stats' })
        const expected = contextUsage.percent === null ? '—' : percentLabel(contextUsage.percent)
        assert.equal(await footerPercent(app), expected)
      }
    )

    await step('the next request carries the summary instead of the old turns', async () => {
      const { sent } = await sendAndCapture(app, server, 'After the manual compaction')
      const all = sent.messages.map((m) => m.text).join('\n')
      assert.match(all, /SUMMARY-MANUAL/)
      assert.doesNotMatch(all, /Answer number 1/, 'old assistant turns were summarized away')
    })

    await step('auto-compaction past the threshold (usage 20000 > 32000 - 15616)', async () => {
      const from = server.requests.length
      server.queue(
        turn.text('Big answer.', { usage: { input: 20_000, output: 100 } }),
        summaryTurns('SUMMARY-AUTO')
      )
      await app.send('Make the context big')
      await until(async () => (await app.agentState()).lastCompaction?.reason === 'threshold', {
        label: 'threshold compaction',
        timeoutMs: 30_000
      })
      await app.waitForSettle()
      assert.ok(
        server.requests.slice(from).some(isSummaryRequest),
        'auto-compaction sent a summary request'
      )
      const dividers = await app.page.getByText(/Context compacted · .* tokens summarized/).count()
      assert.ok(dividers >= 2, `two compaction dividers (got ${dividers})`)
      await app.screenshot('compaction-auto')
      server.reset()
    })

    await step(
      'overflow ("prompt is too long") → compaction, then the turn is retried',
      async () => {
        const from = server.requests.length
        server.queue(
          turn.error(400, {
            body: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'prompt is too long: 40000 tokens > 32000 maximum'
              }
            }
          }),
          summaryTurns('SUMMARY-OVERFLOW'),
          turn.text('Recovered after overflow.')
        )
        await app.send('This one overflows')
        await until(async () => (await app.agentState()).lastCompaction?.reason === 'overflow', {
          label: 'overflow compaction',
          timeoutMs: 30_000
        })
        await app.waitForSettle({ timeoutMs: 30_000 })
        await app.page.getByText('Recovered after overflow.').waitFor()
        assert.ok(server.requests.slice(from).some(isSummaryRequest), 'summary request')
        await app.screenshot('compaction-overflow')
      }
    )

    await checks.check(
      'a recovered overflow reads as compaction, not as a rejected request',
      async () => {
        const text = await transcriptText(app)
        const turnText = text.slice(text.lastIndexOf('This one overflows'))
        assert.doesNotMatch(turnText, /prompt is too long/, 'no raw provider text')
        assert.doesNotMatch(turnText, /The request was rejected/, turnText)
      }
    )

    await checks.check('no app errors', async () => app.assertNoErrors())
    checks.assertAll()
  },
  {
    launch: { outDir: SHOTS_DIR },
    agentDir: { settings: { compaction: { keepRecentTokens: 1 }, retry: { baseDelayMs: 100 } } }
  }
)
