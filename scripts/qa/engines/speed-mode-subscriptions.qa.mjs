// Engine: response speed on subscriptions. The temp agent dir stores fake OAuth credentials (never
// the user's): a Sign in with ChatGPT token (a JWT with a `chatgpt_account_id` claim) for the
// built-in `openai` provider and a Claude subscription token (`sk-ant-oat…`) for `anthropic`, both
// far from expiry so nothing refreshes, with the providers' baseUrl pointed at the fake LLM.
//   - ChatGPT: the account's model catalog (`GET <baseUrl>/models`, served by the fake with
//     `service_tiers`) decides the options and their wording; Fast goes out as
//     `service_tier: "priority"`, never `"fast"`; ChatGPT's useless `default` echo leaves the
//     response unconfirmed and it is billed at the requested speed; a ChatGPT refusal turns it off.
//   - Claude subscription: Fast on claude-opus-5-5 is shown disabled with the API-key reason and
//     no `speed` / fast-mode beta is ever sent.
//
//   npm run build && node scripts/qa/engines/speed-mode-subscriptions.qa.mjs
import assert from 'node:assert/strict'
import { until } from '../chat/helpers.mjs'
import { reportShotsDir } from '../lib/app.mjs'
import { describeRequest, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  anthropicBetas,
  anthropicModel,
  assertTurnCost,
  chooseSpeed,
  closeMenu,
  FAST_BETA,
  hasServiceTier,
  openSpeedMenu,
  pickModel,
  pillLabel,
  recordToasts,
  responsesModel,
  sendTurn,
  sessionCost,
  slash,
  speedPill,
  speedState,
  toastCount,
  toastsSince,
  TURN_USAGE,
  waitForPill,
  waitForSpeed
} from './speed-mode-helpers.mjs'

const ACCOUNT_ID = 'acct-qa-speed'
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const CHATGPT_TOKEN = [
  base64url({ alg: 'none', typ: 'JWT' }),
  base64url({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } }),
  'qa-signature'
].join('.')
const FAR_FUTURE = Date.now() + 10 * 365 * 86_400_000

/** The account catalog: Fast only on gpt-6.1-sol, Fast + Ultrafast on gpt-6-astra, none on gpt-6-sol. */
const SERVICE_TIERS = {
  'gpt-6.1-sol': [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
  'gpt-6-astra': [
    { id: 'priority', name: 'Fast', description: '1.5x speed' },
    { id: 'ultrafast', name: 'Ultrafast', description: '4x speed' }
  ],
  'gpt-6-sol': []
}
/** ChatGPT echoes the default tier whatever it applied. */
const CHATGPT_ANSWER = { serviceTier: 'default', usage: TURN_USAGE }

/** Fake OAuth credentials, far from expiry so the Engine never refreshes them. */
const AUTH = {
  openai: {
    type: 'oauth',
    access: CHATGPT_TOKEN,
    refresh: 'qa-refresh',
    expires: FAR_FUTURE,
    accountId: ACCOUNT_ID
  },
  anthropic: {
    type: 'oauth',
    access: 'sk-ant-oat01-qa-fake-subscription-token',
    refresh: 'sk-ant-ort01-qa-fake-refresh',
    expires: FAR_FUTURE
  }
}

const catalogRequests = (server) =>
  server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/models')

await runSuite(
  'engines-speed-mode-subscriptions',
  async ({ server, agentDir, app, step }) => {
    const checks = softSteps(step, { app, name: 'speed-subscriptions' })
    app.allowError(/service_tier/i)
    server.setAccountModels(Object.keys(SERVICE_TIERS), { serviceTiers: SERVICE_TIERS })
    const fakeProvider = (await agentDir.readJson('models.json')).providers
    await agentDir.writeText('models.json', {
      providers: {
        ...fakeProvider,
        openai: {
          baseUrl: server.openaiBaseUrl,
          models: Object.keys(SERVICE_TIERS).map((id) => responsesModel(server, id))
        },
        anthropic: {
          baseUrl: server.anthropicBaseUrl,
          models: [anthropicModel(server, 'claude-opus-5-5', 'Claude Opus 5.5')]
        }
      }
    })
    // Credentials only once both providers point at the fake: main reads the account's models at once.
    await agentDir.writeText('auth.json', AUTH)

    await step('ChatGPT session on gpt-6.1-sol fetches the account catalog', async () => {
      await app.openWorkspace({ args: { model: 'openai/gpt-6.1-sol' } })
      await recordToasts(app)
      // Main reads the same list for the account's models; the bridge's request has Codex's originator.
      const request = await until(
        () => catalogRequests(server).find((r) => r.headers.originator === 'codex_cli_rs'),
        { label: 'the bridge catalog request' }
      )
      assert.equal(request.headers.authorization, `Bearer ${CHATGPT_TOKEN}`)
      assert.equal(request.headers['chatgpt-account-id'], ACCOUNT_ID)
    })

    await checks.check(
      'gpt-6.1-sol: Standard + Fast with the catalog wording, no Ultrafast',
      async () => {
        await waitForPill(app, 'Standard')
        const items = await openSpeedMenu(app)
        await app.screenshot('speed-chatgpt-menu')
        await closeMenu(app)
        assert.equal(items.length, 2, JSON.stringify(items))
        assert.match(items[1], /^Fast[\s\S]*2x speed, increased usage[\s\S]*2× price/)
      }
    )

    await checks.check('Fast: "priority" on the wire, unconfirmed, billed 2×', async () => {
      await chooseSpeed(app, 'fast')
      await waitForPill(app, 'Fast')
      const before = await sessionCost(app)
      const { request } = await sendTurn(
        app,
        server,
        'chatgpt fast',
        turn.text('ok', CHATGPT_ANSWER)
      )
      console.log(
        `      wire: ${JSON.stringify({ model: request.body.model, service_tier: request.body.service_tier })}`
      )
      assert.equal(request.body.service_tier, 'priority')
      await assertTurnCost(app, 2, before)
      const speed = await waitForSpeed(app, (s) => !!s.lastResponse, 'lastResponse')
      assert.deepEqual(speed.lastResponse, { mode: 'fast', confirmed: false })
    })

    await checks.check(
      'gpt-6-sol: the catalog lists no tier, so no pill (the built-in list would offer Fast)',
      async () => {
        await pickModel(app, 'openai', 'gpt-6-sol')
        await waitForPill(app, null)
        assert.equal((await speedState(app)).requested, 'fast')
        const { request } = await sendTurn(
          app,
          server,
          'chatgpt sol',
          turn.text('ok', CHATGPT_ANSWER)
        )
        assert.equal(hasServiceTier(request), false)
      }
    )

    await checks.check(
      'gpt-6-astra: the catalog adds Ultrafast; it goes out as "ultrafast"',
      async () => {
        await pickModel(app, 'openai', 'gpt-6-astra')
        await waitForPill(app, 'Fast')
        const items = await openSpeedMenu(app)
        await closeMenu(app)
        assert.equal(items.length, 3, JSON.stringify(items))
        assert.match(items[1], /^Fast[\s\S]*1\.5x speed/)
        assert.match(items[2], /^Ultrafast[\s\S]*4x speed[\s\S]*6× price/)
        await chooseSpeed(app, 'ultrafast')
        const before = await sessionCost(app)
        const { request } = await sendTurn(
          app,
          server,
          'astra ultrafast',
          turn.text('ok', CHATGPT_ANSWER)
        )
        assert.equal(request.body.service_tier, 'ultrafast')
        await assertTurnCost(app, 6, before)
      }
    )

    await checks.check('no request ever carried the literal service_tier "fast"', async () => {
      const tiers = server.requests.filter((r) => r.api).map((r) => r.body?.service_tier)
      console.log(`      service tiers sent: ${JSON.stringify(tiers)}`)
      assert.equal(tiers.includes('fast'), false)
    })

    await checks.check(
      'ChatGPT refusal (param service_tier) turns Fast off once; next request plain',
      async () => {
        await pickModel(app, 'openai', 'gpt-6.1-sol')
        await waitForPill(app, 'Fast')
        const from = await toastCount(app)
        const refusal = turn.error(400, {
          body: {
            error: {
              message: 'This capability is not available for shared subscriptions.',
              type: 'invalid_request_error',
              param: 'service_tier',
              code: 'subscription_sharing_unsupported_capability'
            }
          }
        })
        const { request } = await sendTurn(app, server, 'chatgpt refused', refusal)
        assert.equal(request.body.service_tier, 'priority')
        await waitForPill(app, 'Standard')
        await until(async () => (await toastsSince(app, from, /Fast mode turned off/)).length, {
          label: 'refusal toast'
        })
        const { request: next } = await sendTurn(
          app,
          server,
          'after',
          turn.text('ok', CHATGPT_ANSWER)
        )
        assert.equal(hasServiceTier(next), false)
        assert.equal((await toastsSince(app, from, /Fast mode turned off/)).length, 1)
      }
    )

    await checks.check(
      'Claude subscription: claude-opus-5-5 pill disabled with the API-key reason',
      async () => {
        await chooseSpeed(app, 'fast')
        await pickModel(app, 'anthropic', 'claude-opus-5-5')
        await waitForPill(app, 'Unavailable')
        const speed = await speedState(app)
        assert.equal(speed.unavailableReason, 'Claude fast mode needs an Anthropic API key')
        assert.deepEqual(speed.options, [])
        assert.equal(speed.requested, 'fast', 'the request survives')
        assert.equal(speed.effective, 'standard')
        const pill = speedPill(app)
        assert.equal(await pill.getAttribute('aria-disabled'), 'true')
        await pill.hover()
        await app.page
          .getByRole('tooltip')
          .filter({ hasText: 'Claude fast mode needs an Anthropic API key' })
          .first()
          .waitFor()
        await app.screenshot('speed-claude-subscription')
        // aria-disabled: Playwright refuses a normal click, a user's click still lands.
        await pill.click({ force: true })
        assert.equal(await app.page.getByRole('menu').count(), 0, 'a disabled pill opens no menu')
        await app.page.mouse.move(0, 0)
      }
    )

    await checks.check(
      'Claude subscription: no speed and no fast-mode beta on the wire',
      async () => {
        const { request } = await sendTurn(
          app,
          server,
          'claude subscription',
          turn.text('ok', { speed: true, usage: TURN_USAGE })
        )
        const { headers } = describeRequest(request)
        console.log(
          `      wire: ${JSON.stringify({ speed: request.body.speed, 'anthropic-beta': headers['anthropic-beta'] })}`
        )
        assert.match(
          String(request.headers.authorization ?? ''),
          /^Bearer sk-ant-oat/,
          'the OAuth path'
        )
        assert.equal('speed' in request.body, false)
        assert.equal(anthropicBetas(request).includes(FAST_BETA), false)
      }
    )

    await checks.check('/fast on the Claude subscription explains why', async () => {
      const from = await toastCount(app)
      await slash(app, '/fast on')
      const toasts = await until(
        async () => {
          const found = await toastsSince(app, from, /Fast is unavailable for this model/)
          return found.length ? found : null
        },
        { label: 'unavailable toast' }
      )
      assert.match(toasts[0], /Claude fast mode needs an Anthropic API key/)
      assert.equal(await pillLabel(app), 'Unavailable')
    })

    checks.finish()
  },
  {
    agentDir: {
      settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 } }
    },
    launch: {
      outDir: reportShotsDir('speed-mode'),
      // The bridge fetches the ChatGPT catalog only online (PI_OFFLINE stops it, like pi's catalogs).
      env: { PI_OFFLINE: undefined }
    }
  }
)
