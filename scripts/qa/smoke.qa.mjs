// Harness smoke test: the BUILT app + the real engine + the fake LLM, driven through the real
// composer. A text turn, a thinking turn at "low" and a bash tool round trip.
//
//   npm run qa:smoke        (npm run build first)
import assert from 'node:assert/strict'
import { FAKE_API_KEY, FAKE_MODELS, FAKE_PROVIDER } from './lib/agent-dir.mjs'
import { inspectRequest, turn } from './lib/fake-llm.mjs'
import { runSuite } from './lib/suite.mjs'

/** pi-ai's default "low" budget (DEFAULT_THINKING_BUDGETS in api/simple-options.js). */
const LOW_THINKING_BUDGET_TOKENS = 2048

await runSuite('smoke', async ({ server, app, step }) => {
  await step('open a workspace on the fake reasoning model, thinking off', async () => {
    await app.openWorkspace({
      args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
    })
    const state = await app.agentState()
    assert.equal(state.model?.id, FAKE_MODELS.reasoning)
    assert.equal(state.thinkingLevel, 'off')
  })

  await step('text turn streams in chunks and renders', async () => {
    const from = server.requests.length
    server.queue(turn.text('Hello from the fake model.', { chunkSize: 4, delayMs: 15 }))
    await app.send('Say hello')
    await app.waitForSettle()
    const request = await server.waitForRequest(undefined, { from })
    const sent = inspectRequest(request)
    assert.equal(sent.model, FAKE_MODELS.reasoning)
    assert.equal(sent.lastUserText, 'Say hello')
    assert.deepEqual(sent.thinking, { type: 'disabled' })
    assert.ok(sent.tools.includes('bash'), `bash tool declared (tools: ${sent.tools.join(', ')})`)
    assert.equal(request.headers['x-api-key'], FAKE_API_KEY)
    await app.page.getByText('Hello from the fake model.').waitFor()
  })

  await step('thinking turn at "low" sends the low budget and renders the thought', async () => {
    await app.page.getByRole('button', { name: /^Thinking level:/ }).click()
    await app.page.getByRole('menuitemradio', { name: /^Low/ }).click()
    assert.equal((await app.agentState()).thinkingLevel, 'low')

    const from = server.requests.length
    server.queue(turn.thinking('Weighing the options carefully.', 'Thought it through.'))
    await app.send('Think, then answer')
    await app.waitForSettle()
    const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
    assert.equal(sent.thinking?.type, 'enabled')
    assert.equal(sent.thinking?.budget_tokens, LOW_THINKING_BUDGET_TOKENS)
    await app.page.getByText('Thought it through.').waitFor()
    await app.page
      .getByRole('button', { name: /^Thought/ })
      .first()
      .waitFor()
  })

  await step('tool turn: bash `echo hi` runs and its result goes back to the model', async () => {
    const from = server.requests.length
    const callId = 'toolu_smoke_echo'
    server.queue(
      turn.toolCalls([{ id: callId, name: 'bash', args: { command: 'echo hi' } }]),
      turn.text('The command printed hi.')
    )
    await app.send('Run echo hi')
    await app.waitForSettle()

    const followUp = await server.waitForRequest(
      (request) =>
        inspectRequest(request).toolResults.some((result) => result.toolCallId === callId),
      { from }
    )
    const result = inspectRequest(followUp).toolResults.find((entry) => entry.toolCallId === callId)
    assert.equal(result.isError, false)
    assert.match(result.text, /\bhi\b/)
    assert.equal(server.requests.length - from, 2, 'one request for the call, one with its result')

    const state = await app.agentState()
    assert.equal(state.tools[callId]?.status, 'done')
    await app.page.getByText('The command printed hi.').waitFor()
    await app.page.locator('[data-tool-row]', { hasText: 'echo hi' }).first().waitFor()
  })

  await app.screenshot('smoke')
})
