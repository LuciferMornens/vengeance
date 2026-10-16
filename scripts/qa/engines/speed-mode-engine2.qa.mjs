// Engine 2: response speed maps onto the native service tier (src/main/engine/prime/speed.ts). The
// isolated native fixture (integration-fixture.mjs: temp Engine 2 agent + session roots, its own
// daemon shut down at the end) gets `openai` (openai-responses) and `anthropic` providers pointed at
// its fake LLM:
//   - OpenRouter (openai-completions): the pill offers Fast without a price; Fast sends
//     `service_tier: "priority"`, Standard does not; `/fast` drives the same native tier;
//   - OpenAI Responses: Fast reaches the provider; eligible models also send Ultrafast;
//   - ChatGPT: account catalog gates Ultrafast; speed survives model changes and restart;
//   - claude-opus-5-5: disabled, "Engine 2 doesn't support Claude fast mode".
//
//   npm run build && node scripts/qa/engines/speed-mode-engine2.qa.mjs
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { createEngineFixture } from './integration-fixture.mjs'
import {
  anthropicModel,
  assertTurnCost,
  chooseSpeed,
  closeMenu,
  openSpeedMenu,
  pickModel,
  responsesModel,
  slash,
  speedPill,
  TURN_USAGE,
  sessionCost,
  waitForPill,
  waitForSpeed
} from './speed-mode-helpers.mjs'

const SUITE = 'engines-speed-mode-engine2'
const PRIME_KEY = 'qa-prime-speed-key'
const OPENROUTER_MODEL = 'openai/gpt-5.5'
const ACCOUNT_ID = 'acct-engine2-speed'
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const CHATGPT_TOKEN = `${encode({ alg: 'none' })}.${encode({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID }
})}.qa-signature`
const CHATGPT_MODELS = {
  'gpt-6.1-sol': [{ id: 'priority' }, { id: 'ultrafast', description: '4x speed' }],
  'gpt-6-astra': [{ id: 'priority', description: 'Faster responses' }],
  'gpt-6-sol': []
}

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

function nativeCommand(application, agentId, command, payload = {}) {
  return application.invoke('prime:command', agentId, command, payload)
}

console.log(`▶ ${SUITE} (native Engine 2, fake providers)`)
const fixture = await createEngineFixture()
const server = fixture.primeServer
let app = null
let failure = null
const checks = softSteps(step, { app: () => app, name: SUITE })

/** Send through the composer; returns the turn's first model request. */
async function sendTurn(prompt, serviceTier = true) {
  const from = server.requests.length
  server.queue(turn.text('ok', { serviceTier, usage: TURN_USAGE }))
  await app.send(prompt)
  const request = await server.waitForRequest((request) => request.method === 'POST', { from })
  await app.waitForSettle()
  console.log(
    `      wire: ${request.path} ${JSON.stringify({ model: request.body.model, service_tier: request.body.service_tier })}`
  )
  return request
}

async function assertUnavailable(reason) {
  // The previous model may have been unavailable too: wait for this model's reason.
  const speed = await waitForSpeed(app, (s) => s.unavailableReason === reason, reason)
  await waitForPill(app, 'Unavailable')
  assert.deepEqual(speed.options, [])
  const pill = speedPill(app)
  assert.equal(await pill.getAttribute('aria-disabled'), 'true')
  await pill.hover()
  await app.page.getByRole('tooltip').filter({ hasText: reason }).first().waitFor()
  await app.page.mouse.move(0, 0)
}

try {
  const modelsFile = join(fixture.primeDirectory, 'models.json')
  const models = JSON.parse(await readFile(modelsFile, 'utf8'))
  await writeFile(
    modelsFile,
    `${JSON.stringify(
      {
        providers: {
          ...models.providers,
          openai: {
            baseUrl: server.openaiBaseUrl,
            api: 'openai-responses',
            apiKey: PRIME_KEY,
            models: [
              responsesModel(server, 'gpt-5.5', 'GPT-5.5'),
              responsesModel(server, 'gpt-6.1-sol', 'GPT-6.1 Sol')
            ]
          },
          openrouter: {
            baseUrl: server.openaiBaseUrl,
            api: 'openai-completions',
            apiKey: PRIME_KEY,
            models: [{ ...responsesModel(server, OPENROUTER_MODEL), api: 'openai-completions' }]
          },
          'openai-codex': {
            baseUrl: server.openaiBaseUrl,
            api: 'openai-codex-responses',
            models: Object.keys(CHATGPT_MODELS).map((id) => ({
              ...responsesModel(server, id),
              api: 'openai-codex-responses'
            }))
          },
          anthropic: {
            baseUrl: server.anthropicBaseUrl,
            api: 'anthropic-messages',
            apiKey: PRIME_KEY,
            models: [anthropicModel(server, 'claude-opus-5-5', 'Claude Opus 5.5')]
          }
        }
      },
      null,
      2
    )}\n`
  )
  server.setAccountModels(Object.keys(CHATGPT_MODELS), { serviceTiers: CHATGPT_MODELS })
  await writeFile(
    join(fixture.primeDirectory, 'auth.json'),
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: CHATGPT_TOKEN,
        refresh: 'qa-refresh',
        expires: Date.now() + 365 * 86_400_000,
        accountId: ACCOUNT_ID
      }
    })
  )
  app = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('speed-mode')
  })
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Engine 2 speed\n' })
  let agentId

  await step('Engine 2 session on OpenRouter', async () => {
    ;({ agentId } = await app.openWorkspace({
      cwd: workspace,
      args: { engine: 'prime', provider: 'openrouter', model: OPENROUTER_MODEL, thinking: 'off' }
    }))
    await until(async () => (await app.agentState(agentId))?.status === 'ready', {
      label: 'Engine 2 ready',
      timeoutMs: 60_000
    })
  })

  await checks.check(
    'OpenRouter: pill at Standard; menu offers Fast without a price, no Ultrafast',
    async () => {
      await waitForPill(app, 'Standard')
      const items = await openSpeedMenu(app)
      await app.screenshot('speed-engine2-menu')
      await closeMenu(app)
      assert.equal(items.length, 2, JSON.stringify(items))
      assert.match(items[1], /^Fast/)
      assert.doesNotMatch(items[1], /price/, 'OpenRouter publishes no priority price')
    }
  )

  await checks.check('Standard: no priority tier on the wire', async () => {
    const request = await sendTurn('engine2 standard')
    assert.notEqual(request.body.service_tier, 'priority')
  })

  await checks.check(
    'Fast: native tier priority, service_tier "priority" on the wire',
    async () => {
      await chooseSpeed(app, 'fast')
      await waitForPill(app, 'Fast')
      const native = await nativeCommand(app, agentId, 'get_connection_state')
      assert.equal(native.serviceTier, 'priority')
      const request = await sendTurn('engine2 fast')
      assert.equal(request.body.service_tier, 'priority')
    }
  )

  await checks.check('/fast off and /fast drive the same native tier', async () => {
    await slash(app, '/fast off')
    await waitForPill(app, 'Standard')
    const off = await sendTurn('engine2 slash off')
    assert.notEqual(off.body.service_tier, 'priority')
    await slash(app, '/fast')
    await waitForPill(app, 'Fast')
    const on = await sendTurn('engine2 slash on')
    assert.equal(on.body.service_tier, 'priority')
  })

  for (const [id, label] of [
    ['gpt-5.5', 'speed-engine2-openai-fast'],
    ['gpt-6.1-sol', undefined]
  ]) {
    await checks.check(`${id}: Fast reaches OpenAI Responses`, async () => {
      await pickModel(app, 'openai', id)
      await waitForPill(app, 'Fast')
      if (label) await app.screenshot(label)
      const native = await nativeCommand(app, agentId, 'get_session_context')
      assert.equal(native.context?.serviceTier, 'priority', 'the native preference stays Fast')
      const request = await sendTurn(`engine2 ${id}`)
      assert.equal(request.body.service_tier, 'priority')
    })
  }

  await checks.check('OpenAI API Ultrafast keeps the chosen model and thinking level', async () => {
    await chooseSpeed(app, 'ultrafast')
    await waitForPill(app, 'Ultrafast')
    const request = await sendTurn('engine2 API ultrafast')
    assert.equal(request.body.service_tier, 'ultrafast')
    assert.equal(request.body.model, 'gpt-6.1-sol')
    assert.equal((await app.rpc({ type: 'get_state' }, agentId)).thinkingLevel, 'off')
  })

  await checks.check(
    'ChatGPT catalog grants Ultrafast and native billing follows the request',
    async () => {
      await pickModel(app, 'openai-codex', 'gpt-6.1-sol')
      await waitForSpeed(
        app,
        (speed) => speed.options.some((option) => option.description === '4x speed'),
        'account catalog'
      )
      const catalog = server.requests.find((request) =>
        request.path.startsWith('/v1/codex/models?')
      )
      assert.equal(catalog.headers.authorization, `Bearer ${CHATGPT_TOKEN}`)
      assert.equal(catalog.headers['chatgpt-account-id'], ACCOUNT_ID)
      await waitForPill(app, 'Ultrafast')
      await openSpeedMenu(app)
      await app.screenshot('speed-engine2-chatgpt-ultrafast')
      await closeMenu(app)
      const before = await sessionCost(app)
      const request = await sendTurn('engine2 subscription ultrafast', 'default')
      assert.equal(request.body.service_tier, 'ultrafast')
      assert.equal(request.body.model, 'gpt-6.1-sol')
      await assertTurnCost(app, 6, before)
    }
  )

  await checks.check(
    'Account without Ultrafast falls back to Fast; no tier means Standard',
    async () => {
      await pickModel(app, 'openai-codex', 'gpt-6-astra')
      await waitForPill(app, 'Fast')
      const faster = await sendTurn('engine2 account fast', 'default')
      assert.equal(faster.body.service_tier, 'priority')
      await pickModel(app, 'openai-codex', 'gpt-6-sol')
      await waitForSpeed(
        app,
        (speed) => speed.effective === 'standard' && speed.options.length === 0,
        'no account tier'
      )
      const standard = await sendTurn('engine2 account standard', 'default')
      assert.equal(standard.body.service_tier, 'default')
    }
  )

  await checks.check(
    'Ultrafast preference survives model changes, restart, and slash controls',
    async () => {
      await pickModel(app, 'openai-codex', 'gpt-6.1-sol')
      await waitForPill(app, 'Ultrafast')
      const before = await nativeCommand(app, agentId, 'get_session_context')
      await app.invoke('engine:restart', agentId, undefined)
      await until(async () => (await app.agentState(agentId))?.status === 'ready', {
        label: 'restarted Engine 2'
      })
      const state = await app.rpc({ type: 'get_state' }, agentId)
      assert.equal(state.model.provider, 'openai-codex')
      assert.equal(state.model.id, 'gpt-6.1-sol')
      assert.equal(state.thinkingLevel, 'off')
      await waitForPill(app, 'Ultrafast')
      const after = await nativeCommand(app, agentId, 'get_session_context')
      assert.equal(after.context.serviceTier, 'ultrafast')
      assert.equal(after.context.messages.length, before.context.messages.length)
      await slash(app, '/fast off')
      await waitForPill(app, 'Standard')
      await slash(app, '/fast ultrafast')
      await waitForPill(app, 'Ultrafast')
      assert.equal(
        (await sendTurn('engine2 restarted ultrafast', 'default')).body.service_tier,
        'ultrafast'
      )
    }
  )

  await checks.check('Saved-session branching keeps the native Ultrafast tier', async () => {
    const state = await app.rpc({ type: 'get_state' }, agentId)
    const tree = await app.rpc({ type: 'get_tree' }, agentId)
    const source = await readFile(state.sessionFile, 'utf8')
    const branch = await app.invoke('sessions:branch', {
      engine: 'prime',
      sessionPath: state.sessionFile,
      entryId: tree.leafId
    })
    const entries = (await readFile(branch, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(
      entries.findLast((entry) => entry.type === 'service_tier_change')?.serviceTier,
      'ultrafast'
    )
    assert.equal(await readFile(state.sessionFile, 'utf8'), source)
  })

  await checks.check('A provider tier refusal saves Standard before the next request', async () => {
    app.allowError(/service_tier/i)
    const from = server.requests.length
    server.queue(
      turn.error(400, {
        body: { error: { message: 'Unsupported service_tier: ultrafast', param: 'service_tier' } }
      })
    )
    await app.send('engine2 refused tier')
    const refused = await server.waitForRequest((request) => request.method === 'POST', { from })
    assert.equal(refused.body.service_tier, 'ultrafast')
    await app.waitForSettle()
    await waitForSpeed(
      app,
      (speed) => speed.requested === 'standard' && !!speed.notice,
      'tier refusal'
    )
    await waitForPill(app, 'Standard')
    assert.equal((await sendTurn('engine2 after refusal', 'default')).body.service_tier, 'default')
    await chooseSpeed(app, 'fast')
  })

  await checks.check('claude-opus-5-5: disabled, Engine 2 has no Claude fast mode', async () => {
    await pickModel(app, 'anthropic', 'claude-opus-5-5')
    await assertUnavailable("Engine 2 doesn't support Claude fast mode")
    const request = await sendTurn('engine2 claude')
    assert.equal('speed' in (request.body ?? {}), false)
  })

  await checks.check('back on OpenRouter the native preference still asks for Fast', async () => {
    await pickModel(app, 'openrouter', OPENROUTER_MODEL)
    await waitForSpeed(app, (speed) => speed.options.length > 0, 'OpenRouter offer')
    await waitForPill(app, 'Fast')
    const request = await sendTurn('engine2 back')
    assert.equal(request.body.service_tier, 'priority')
  })

  await checks.check('no unexpected app errors', async () => app.assertNoErrors())
  checks.finish()
} catch (error) {
  failure = error
  await app?.screenshot(`${SUITE}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await app
    ?.close({ beforeCleanup: fixture.stopNativeDaemon })
    .catch((error) => (failure ??= error))
  await fixture.cleanup().catch((error) => (failure ??= error))
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE} passed`)
}
