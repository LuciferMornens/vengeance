// Chat: automatic retry on 429/503 with the countdown banner and Cancel, retries running out,
// non-retryable errors, and provider error bodies (JSON, HTML) never shown raw.
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  SHOTS_DIR,
  assertCleanUiText,
  pickModelInFooter,
  softSteps,
  transcriptText,
  until
} from './helpers.mjs'

const BASE_DELAY_MS = 1500
const MAX_RETRIES = 2

/** An Anthropic-shaped error body (the fake's default type is always api_error). */
const anthropicError = (type, message) => ({ type: 'error', error: { type, message } })

/** The last turn's visible text (from the last user bubble on). */
async function lastTurnText(app, prompt) {
  const text = await transcriptText(app)
  return text.slice(text.lastIndexOf(prompt))
}

await runSuite(
  'chat-retry-errors',
  async ({ server, app, step }) => {
    const checks = softSteps(step, app)

    await step('open on qa-reasoning', async () => {
      await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
      })
    })

    await step('503 → countdown banner "Retrying in Ns · attempt 1/2", then success', async () => {
      const from = server.requests.length
      server.queue(turn.error(503, { message: 'Service temporarily unavailable' }))
      server.queue(turn.text('Recovered after a retry.'))
      await app.send('Retry on 503')
      const banner = app.page.locator('[data-retry-banner]')
      await banner.waitFor({ timeout: 10_000 })
      const text = await banner.innerText()
      assert.match(text, /Retrying in \d+s/)
      assert.match(text, /attempt 1\/2/)
      // The fake body says error.type "api_error": its code title wins over the 503 status title.
      assert.match(text, /The provider (is unavailable|had an internal error)/)
      assert.doesNotMatch(text, /\{|"type"/, 'banner has no raw JSON')
      await app.screenshot('retry-countdown')
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 2, 'one retry')
      await app.page.getByText('Recovered after a retry.').waitFor()
      await app.page.getByText('retried automatically').waitFor()
      assert.equal(await banner.count(), 0, 'banner gone')
      await app.screenshot('retry-recovered')
    })

    await step('429 is retried the same way', async () => {
      const from = server.requests.length
      server.queue(
        turn.error(429, {
          retryAfter: 1,
          body: {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Number of request tokens has exceeded your per-minute rate limit'
            }
          }
        })
      )
      server.queue(turn.text('Recovered from 429.'))
      await app.send('Retry on 429')
      await app.page.locator('[data-retry-banner]').waitFor({ timeout: 10_000 })
      assert.match(await app.page.locator('[data-retry-banner]').innerText(), /Rate limit reached/)
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 2)
      await app.page.getByText('Recovered from 429.').waitFor()
    })

    await step(
      'Cancel in the banner stops the retry (abort_retry): no second request',
      async () => {
        const from = server.requests.length
        server.queue(turn.error(503, { message: 'Down for maintenance' }))
        server.queue(turn.text('must not be requested'))
        await app.send('Cancel the retry')
        const banner = app.page.locator('[data-retry-banner]')
        await banner.waitFor({ timeout: 10_000 })
        await banner.getByRole('button', { name: 'Cancel' }).click()
        await app.waitForSettle()
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS + 500))
        assert.equal(server.requests.length - from, 1, 'no retry request after Cancel')
        assert.equal((await app.agentState()).retry, null)
        assert.equal(await banner.count(), 0)
        const turnText = await lastTurnText(app, 'Cancel the retry')
        assert.match(
          turnText,
          /The provider (is unavailable|had an internal error)/,
          'failure shown'
        )
        server.reset()
        await app.screenshot('retry-cancelled')
      }
    )

    await step('retries run out → "Gave up retrying" card, 1 + maxRetries requests', async () => {
      const from = server.requests.length
      for (let i = 0; i <= MAX_RETRIES; i++)
        server.queue(turn.error(503, { message: 'Still down' }))
      await app.send('Retries run out')
      await app.waitForSettle({ timeoutMs: 30_000 })
      assert.equal(server.requests.length - from, 1 + MAX_RETRIES)
      const turnText = await lastTurnText(app, 'Retries run out')
      assert.match(turnText, /Gave up retrying/)
      assertCleanUiText(turnText, { allow: [/Retries run out/] })
      await app.screenshot('retry-gave-up')
    })

    await checks.check('the given-up turn shows one error card, not two', async () => {
      const turnText = await lastTurnText(app, 'Retries run out')
      const cards = turnText.match(/Still down/g) ?? []
      assert.equal(cards.length, 1, `"Still down" appears ${cards.length}×`)
    })

    await step('400 is not retried; title + provider message, no raw JSON', async () => {
      const from = server.requests.length
      server.queue(
        turn.error(400, {
          body: anthropicError('invalid_request_error', 'max_tokens: must be a positive integer')
        })
      )
      await app.send('Non retryable 400')
      await app.waitForSettle()
      assert.equal(server.requests.length - from, 1)
      const turnText = await lastTurnText(app, 'Non retryable 400')
      assert.match(turnText, /The request was rejected/)
      assert.match(turnText, /max_tokens: must be a positive integer/)
      assertCleanUiText(turnText, { allow: [/Non retryable 400/] })
      // The raw provider string stays behind "Details".
      const details = app.page.getByRole('button', { name: 'Details' }).last()
      await details.click()
      await app.page.locator('pre', { hasText: '"type"' }).last().waitFor()
      await app.screenshot('error-400-details')
      await details.click()
    })

    await step('401 reads as a sign-in problem', async () => {
      server.queue(
        turn.error(401, { body: anthropicError('authentication_error', 'invalid x-api-key') })
      )
      await app.send('Auth failure')
      await app.waitForSettle()
      const turnText = await lastTurnText(app, 'Auth failure')
      assert.match(turnText, /Not signed in to this provider/)
      assertCleanUiText(turnText, { allow: [/Auth failure/] })
    })

    await checks.check('an HTML error page (proxy 400) is not dumped into the card', async () => {
      server.queue(
        turn.error(400, {
          body: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>nginx</center></body></html>',
          headers: { 'content-type': 'text/html' }
        })
      )
      await app.send('HTML error body')
      await app.waitForSettle()
      const turnText = await lastTurnText(app, 'HTML error body')
      await app.screenshot('error-html-body')
      assert.doesNotMatch(turnText, /<html|<\/|<center>/i, 'no raw HTML in the visible card')
    })

    await step('openai-completions error body: message shown, not the JSON', async () => {
      await pickModelInFooter(app, FAKE_PROVIDER, FAKE_MODELS.openai)
      server.queue(turn.error(400, { message: "Unsupported value: 'temperature'" }))
      await app.send('OpenAI 400')
      await app.waitForSettle()
      const turnText = await lastTurnText(app, 'OpenAI 400')
      assert.match(turnText, /Unsupported value: 'temperature'/)
      assertCleanUiText(turnText, { allow: [/OpenAI 400/] })
    })

    await step('Settings → retry off (set_auto_retry): a 503 is not retried', async () => {
      await app.page.keyboard.press('ControlOrMeta+,')
      await app.page.getByText('Agent behavior', { exact: true }).first().click()
      const label = app.page.getByText('Retry transient failures', { exact: true })
      await label.waitFor()
      const row = label.locator('xpath=ancestor::*[.//*[@role="switch"]][1]')
      await row.getByRole('switch').click()
      await app.page.keyboard.press('Escape')
      const from = server.requests.length
      server.queue(turn.error(503, { message: 'No retry please' }))
      server.queue(turn.text('must not be requested'))
      await app.send('Retry disabled')
      await app.waitForSettle()
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS + 500))
      assert.equal(server.requests.length - from, 1, 'no retry with retry.enabled=false')
      server.reset()
    })

    await checks.check('no app errors', async () => app.assertNoErrors())
    checks.assertAll()
  },
  {
    launch: { outDir: SHOTS_DIR },
    agentDir: { settings: { retry: { baseDelayMs: BASE_DELAY_MS, maxRetries: MAX_RETRIES } } }
  }
)
