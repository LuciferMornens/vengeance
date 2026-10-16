// Settings → Agent behavior: queued-message delivery (live settings) and the retry settings, verified
// through the real controls, the JSON on disk, RPC get_state and the requests the fake LLM receives.
//
//   node scripts/qa/settings/agent-queue-retry.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  choose,
  closeSettings,
  dismissToasts,
  fill,
  LAUNCH,
  openSettings,
  restartFromToast,
  setSwitch,
  settingRow,
  toastWith,
  waitFor,
  waitForJsonValue
} from './settings-ui.mjs'

/** A slow text turn: ~1.5 s of streaming, time to queue messages behind it. */
const SLOW = { chunkSize: 2, delayMs: 50 }
const SLOW_TEXT = 'Working through the first request slowly, chunk by chunk.'

/** Type into the composer while the agent runs: Enter steers, Alt+Enter queues a follow-up. */
async function queueMessage(app, text, key = 'Enter') {
  const composer = app.page.getByRole('textbox', { name: 'Message' })
  await composer.fill(text)
  await composer.press(key)
}

/** User texts of every request from `from` on, in order. */
function userTexts(server, from) {
  return server.requests.slice(from).map((request) => inspectRequest(request).lastUserText)
}

await runSuite(
  'settings-agent-queue-retry',
  async ({ server, agentDir, app, step }) => {
    const settingsPath = agentDir.path('settings.json')
    let agentId

    await step('open a session (Engine defaults: one-at-a-time queues)', async () => {
      ;({ agentId } = await app.openWorkspace())
      const state = await app.rpc({ type: 'get_state' })
      assert.equal(state.steeringMode, 'one-at-a-time')
      assert.equal(state.followUpMode, 'one-at-a-time')
    })

    await step(
      'Steering "All at once" writes steeringMode and applies live to the Engine',
      async () => {
        await openSettings(app, 'Agent behavior')
        await choose(app, 'steeringMode', 'All at once')
        await waitForJsonValue(settingsPath, 'steeringMode', 'all')
        await toastWith(app, 'Applied to open sessions').waitFor()
        await waitFor(
          async () => (await app.rpc({ type: 'get_state' })).steeringMode === 'all',
          'get_state.steeringMode = all'
        )
      }
    )

    await step('Follow-up "All at once" writes followUpMode and applies live', async () => {
      await choose(app, 'followUpMode', 'All at once')
      await waitForJsonValue(settingsPath, 'followUpMode', 'all')
      await waitFor(
        async () => (await app.rpc({ type: 'get_state' })).followUpMode === 'all',
        'get_state.followUpMode = all'
      )
      await closeSettings(app)
    })

    await step('with "all", two steering messages reach the model in ONE request', async () => {
      const from = server.requests.length
      server.queue(turn.text(SLOW_TEXT, SLOW), turn.text('Both steers seen.'))
      await app.send('start slow work')
      await queueMessage(app, 'steer one')
      await queueMessage(app, 'steer two')
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 2, `requests: ${userTexts(server, from)}`)
      const second = inspectRequest(server.requests[from + 1])
      const texts = second.messages.filter((m) => m.role === 'user').map((m) => m.text)
      assert.ok(texts.includes('steer one') && texts.includes('steer two'), texts.join(' | '))
    })

    await step('with "all", two Alt+Enter follow-ups reach the model in ONE request', async () => {
      const from = server.requests.length
      server.queue(turn.text(SLOW_TEXT, SLOW), turn.text('Both follow-ups seen.'))
      await app.send('start slow work for follow-ups')
      await queueMessage(app, 'follow one', 'Alt+Enter')
      await queueMessage(app, 'follow two', 'Alt+Enter')
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 2, `requests: ${userTexts(server, from)}`)
      const second = inspectRequest(server.requests[from + 1])
      const texts = second.messages.filter((m) => m.role === 'user').map((m) => m.text)
      assert.ok(texts.includes('follow one') && texts.includes('follow two'), texts.join(' | '))
    })

    await step(
      'back to "One at a time": the Engine delivers one steering message per turn',
      async () => {
        await openSettings(app, 'Agent behavior')
        await choose(app, 'steeringMode', 'One at a time')
        await waitForJsonValue(settingsPath, 'steeringMode', 'one-at-a-time')
        await waitFor(
          async () => (await app.rpc({ type: 'get_state' })).steeringMode === 'one-at-a-time',
          'get_state.steeringMode = one-at-a-time'
        )
        await closeSettings(app)
        const from = server.requests.length
        server.queue(
          turn.text(SLOW_TEXT, SLOW),
          turn.text('First steer.'),
          turn.text('Second steer.')
        )
        await app.send('start slow work again')
        await queueMessage(app, 'steer A')
        await queueMessage(app, 'steer B')
        await app.waitForSettle()
        assert.deepEqual(userTexts(server, from), ['start slow work again', 'steer A', 'steer B'])
      }
    )

    await step('Retry switch off: written, applied live, a 503 is not retried', async () => {
      await openSettings(app, 'Agent behavior')
      await dismissToasts(app)
      await setSwitch(app, 'retry.enabled', false)
      await waitForJsonValue(settingsPath, 'retry', { enabled: false })
      await toastWith(app, 'Applied to open sessions').waitFor()
      await closeSettings(app)
      const from = server.requests.length
      server.queue(turn.error(503, { message: 'Service unavailable' }))
      await app.send('fail once')
      await app.waitForSettle()
      await app.page.waitForTimeout(600)
      assert.equal(server.requests.length - from, 1, 'no automatic retry')
    })

    await step(
      'Retry on + Maximum attempts 1 + Initial delay 100 ms: exactly one retry',
      async () => {
        await openSettings(app, 'Agent behavior')
        await setSwitch(app, 'retry.enabled', true)
        await fill(app, 'retry.maxRetries', 1)
        await fill(app, 'retry.baseDelayMs', 100)
        await waitForJsonValue(settingsPath, 'retry', {
          enabled: true,
          maxRetries: 1,
          baseDelayMs: 100
        })
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const from = server.requests.length
        server.queue(
          turn.error(503, { message: 'Service unavailable' }),
          turn.error(503, { message: 'Service unavailable' }),
          turn.text('should never be requested')
        )
        await app.send('fail twice')
        await app.waitForSettle()
        await app.page.waitForTimeout(800)
        assert.equal(server.requests.length - from, 2, 'one try + one retry')
        server.reset()
      }
    )

    await step(
      'Provider retries 1 (agent retry off): the SDK retries inside the same turn',
      async () => {
        await openSettings(app, 'Agent behavior')
        await setSwitch(app, 'retry.enabled', false)
        await fill(app, 'retry.provider.maxRetries', 1)
        await waitForJsonValue(settingsPath, 'retry.provider', { maxRetries: 1 })
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const from = server.requests.length
        server.queue(
          turn.error(503, { message: 'Service unavailable', retryAfter: 0 }),
          turn.text('Recovered.')
        )
        await app.send('provider retry')
        await app.waitForSettle()
        await app.page.getByText('Recovered.').waitFor()
        assert.equal(server.requests.length - from, 2)
        const events = (await app.agentState()).retry
        assert.equal(events, null, 'no agent-level auto-retry')
      }
    )

    await step('Maximum delay / max server delay / request timeout write their keys', async () => {
      await openSettings(app, 'Agent behavior')
      await fill(app, 'retry.maxAgentDelayMs', 5000)
      await fill(app, 'retry.provider.maxRetryDelayMs', 7000)
      await fill(app, 'retry.provider.timeoutMs', 90000)
      await waitForJsonValue(settingsPath, 'retry', {
        enabled: false,
        maxRetries: 1,
        baseDelayMs: 100,
        provider: { maxRetries: 1, maxRetryDelayMs: 7000, timeoutMs: 90000 },
        maxAgentDelayMs: 5000
      })
      const input = settingRow(app, 'retry.provider.timeoutMs').locator('input')
      assert.equal(await input.inputValue(), '90000')
      await app.screenshot('settings-agent-retry')
    })
  },
  { launch: LAUNCH }
)
