// Engine: response speed (Fast / Ultrafast) end to end, API keys. The real built app and the real
// Engine with the Vengeance bridge (resources/bridge/speed-mode.ts) talk to the fake LLM through the
// built-in `openai` (openai-responses) and `anthropic` (anthropic-messages) providers, both with an
// API key and their baseUrl pointed at the fake server. Every check drives the UI and asserts on the
// request the Engine sent:
//   - the composer's speed pill shows only for eligible models; its menu lists what the model offers;
//   - Fast → `service_tier: "priority"`, Ultrafast → `"ultrafast"`, Standard → no field; Claude Fast →
//     `speed: "fast"` + the `fast-mode-2026-02-01` beta; ineligible models send nothing;
//   - the requested speed survives model switches (the effective one falls back);
//   - message cost, session cost and the inspector reflect the price multiplier;
//   - a provider refusal (OpenAI 400, Anthropic 429) toasts once, returns to Standard, resets the
//     default for new sessions to Standard, and the following request has no tier;
//   - the native compaction checkpoint runs at the session's speed; pi's own summary at standard;
//   - `/fast`, `/fast ultrafast`, `/fast off` and the palette toggle drive the same state and wire;
//   - the choice persists in the session (relaunch + resume) and new sessions start at the saved
//     default (Settings → Models → Response speed for new sessions).
//
//   npm run build && node scripts/qa/engines/speed-mode.qa.mjs
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { until } from '../chat/helpers.mjs'
import { createAgentDir, FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { describeRequest, startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { choose, closeSettings, openSettings, settingRow } from '../settings/settings-ui.mjs'
import {
  anthropicBetas,
  anthropicModel,
  assertTurnCost,
  chooseSpeed,
  closeMenu,
  ECHO,
  FAST_BETA,
  hasServiceTier,
  lastAssistantMessage,
  openSpeedMenu,
  paletteFastToggle,
  pickModel,
  pillLabel,
  recordToasts,
  responsesModel,
  sendTurn,
  sessionCost,
  slash,
  speedState,
  toastCount,
  toastsSince,
  TURN_USAGE,
  waitForPill,
  waitForSpeed
} from './speed-mode-helpers.mjs'

const SUITE = 'engines-speed-mode'
const SHOTS = reportShotsDir('speed-mode')
const SESSION_NAME = 'Speed persistence session'

const isNativeCompaction = (request) => Array.isArray(request.body?.context_management)

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

/** Print what reached the wire for the report (auth headers redacted). */
function logWire(label, requests) {
  for (const request of requests) {
    const { path, body, headers } = describeRequest(request)
    const fields = {
      model: body?.model,
      service_tier: body?.service_tier,
      speed: body?.speed,
      'anthropic-beta': headers['anthropic-beta']
    }
    console.log(`      wire ${label}: ${path} ${JSON.stringify(fields)}`)
  }
}

console.log(`▶ ${SUITE} (fake)`)
const server = await startFakeLlm()
const agentDir = await createAgentDir({
  server,
  settings: {
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
    // Tiny QA turns are summarized at all only when no recent tokens are kept.
    compaction: { keepRecentTokens: 1 }
  }
})
await agentDir.writeText('models.json', {
  providers: {
    [FAKE_PROVIDER]: (await agentDir.readJson('models.json')).providers[FAKE_PROVIDER],
    openai: {
      baseUrl: server.openaiBaseUrl,
      apiKey: 'sk-qa-fake-openai',
      models: [
        responsesModel(server, 'gpt-6.1-sol', 'GPT-6.1 Sol'),
        responsesModel(server, 'gpt-6-sol', 'GPT-6 Sol'),
        responsesModel(server, 'gpt-5.5', 'GPT-5.5'),
        responsesModel(server, 'gpt-4.1', 'GPT-4.1'),
        responsesModel(server, 'gpt-4', 'GPT-4')
      ]
    },
    anthropic: {
      baseUrl: server.anthropicBaseUrl,
      apiKey: 'sk-ant-qa-fake-key',
      models: [
        anthropicModel(server, 'claude-opus-5-5', 'Claude Opus 5.5'),
        anthropicModel(server, 'claude-sonnet-5-5', 'Claude Sonnet 5.5')
      ]
    }
  }
})

let app = null
let failure = null
const checks = softSteps(step, { app: () => app, name: SUITE })

try {
  app = await launchApp({ agentDir: agentDir.dir, outDir: SHOTS })
  // The refusals end a turn with a provider error; the renderer may log it.
  app.allowError(/service_tier|fast mode|Usage credits/i)
  const workspace = await app.createWorkspace()

  await step('a non-OpenAI/Claude model has no speed pill', async () => {
    await app.openWorkspace({
      cwd: workspace,
      args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, name: SESSION_NAME }
    })
    await recordToasts(app)
    await waitForSpeed(app, (speed) => speed.options.length === 0, 'the speed state')
    assert.equal(await pillLabel(app), null)
  })

  // ─── 1. OpenAI API key ─────────────────────────────────────────────────────────────────────────

  await checks.check(
    'gpt-6.1-sol: pill at Standard; menu offers Fast (2×) and Ultrafast (6×)',
    async () => {
      await pickModel(app, 'openai', 'gpt-6.1-sol')
      await waitForPill(app, 'Standard')
      const items = await openSpeedMenu(app)
      await app.screenshot('speed-menu-gpt-6.1-sol')
      await closeMenu(app)
      assert.equal(items.length, 3, JSON.stringify(items))
      assert.match(items[0], /^Standard/)
      assert.match(items[1], /^Fast[\s\S]*2× price/)
      assert.match(items[2], /^Ultrafast[\s\S]*6× price/)
    }
  )

  await checks.check('Standard: no service_tier on the wire, cost at 1×', async () => {
    const before = await sessionCost(app)
    const { request } = await sendTurn(app, server, 'standard turn')
    logWire('standard', [request])
    assert.equal(request.body.model, 'gpt-6.1-sol')
    assert.equal(hasServiceTier(request), false, JSON.stringify(request.body.service_tier))
    await assertTurnCost(app, 1, before)
  })

  await checks.check(
    'Fast: service_tier "priority", 2× cost, inspector says Fast · 2× price',
    async () => {
      await chooseSpeed(app, 'fast')
      await waitForPill(app, 'Fast')
      assert.equal((await app.appState()).prefs.features.settings?.speedDefault, 'fast')
      const before = await sessionCost(app)
      const { request } = await sendTurn(app, server, 'fast turn')
      logWire('fast', [request])
      assert.equal(request.body.service_tier, 'priority')
      await assertTurnCost(app, 2, before)
      const speed = await waitForSpeed(app, (s) => !!s.lastResponse, 'lastResponse')
      assert.deepEqual(speed.lastResponse, { mode: 'fast', confirmed: true })
      await app.test('setPrefs', { inspector: { open: true, width: 340, tab: 'overview' } })
      const row = app.page.getByText('Speed', { exact: true }).locator('..')
      await until(async () => /Fast · 2× price/.test(await row.innerText().catch(() => '')), {
        label: 'inspector speed row'
      })
      await app.screenshot('speed-fast-inspector')
      await app.test('setPrefs', { inspector: { open: false, width: 340, tab: 'overview' } })
    }
  )

  await checks.check('Ultrafast: service_tier "ultrafast", 6× cost', async () => {
    await chooseSpeed(app, 'ultrafast')
    await waitForPill(app, 'Ultrafast')
    const before = await sessionCost(app)
    const { request } = await sendTurn(app, server, 'ultrafast turn')
    logWire('ultrafast', [request])
    assert.equal(request.body.service_tier, 'ultrafast')
    await assertTurnCost(app, 6, before)
  })

  await checks.check('switch to gpt-6-sol: Ultrafast stays requested, Fast is sent', async () => {
    await pickModel(app, 'openai', 'gpt-6-sol')
    await waitForPill(app, 'Fast')
    const speed = await speedState(app)
    assert.equal(speed.requested, 'ultrafast')
    assert.equal(speed.effective, 'fast')
    const { request } = await sendTurn(app, server, 'fallback turn')
    logWire('gpt-6-sol fallback', [request])
    assert.equal(request.body.service_tier, 'priority')
  })

  await checks.check('switch to gpt-4 (no Priority): pill hidden, no service_tier', async () => {
    await pickModel(app, 'openai', 'gpt-4')
    await waitForPill(app, null)
    const speed = await speedState(app)
    assert.equal(speed.requested, 'ultrafast', 'the request survives')
    assert.equal(speed.effective, 'standard')
    const before = await sessionCost(app)
    const { request } = await sendTurn(app, server, 'ineligible turn')
    logWire('gpt-4', [request])
    assert.equal(hasServiceTier(request), false)
    await assertTurnCost(app, 1, before)
  })

  await checks.check('back to gpt-6.1-sol: Ultrafast again', async () => {
    await pickModel(app, 'openai', 'gpt-6.1-sol')
    await waitForPill(app, 'Ultrafast')
    const { request } = await sendTurn(app, server, 'ultrafast again')
    assert.equal(request.body.service_tier, 'ultrafast')
  })

  await checks.check('gpt-5.5: Fast is priced 2.5×, no Ultrafast', async () => {
    await pickModel(app, 'openai', 'gpt-5.5')
    await waitForPill(app, 'Fast')
    const items = await openSpeedMenu(app)
    await closeMenu(app)
    assert.equal(items.length, 2, JSON.stringify(items))
    assert.match(items[1], /^Fast[\s\S]*2\.5× price/)
    const before = await sessionCost(app)
    const { request } = await sendTurn(app, server, 'gpt-5.5 fast')
    assert.equal(request.body.service_tier, 'priority')
    await assertTurnCost(app, 2.5, before)
  })

  await checks.check('gpt-4.1: Fast is priced 1.75× (its pricing-page rates)', async () => {
    await pickModel(app, 'openai', 'gpt-4.1')
    await waitForPill(app, 'Fast')
    const items = await openSpeedMenu(app)
    await closeMenu(app)
    assert.equal(items.length, 2, JSON.stringify(items))
    assert.match(items[1], /^Fast[\s\S]*1\.75× price/)
    const before = await sessionCost(app)
    const { request } = await sendTurn(app, server, 'gpt-4.1 fast')
    assert.equal(request.body.service_tier, 'priority')
    await assertTurnCost(app, 1.75, before)
    await pickModel(app, 'openai', 'gpt-5.5')
  })

  await checks.check('an API echo of "default" (silently downgraded) is billed at 1×', async () => {
    const before = await sessionCost(app)
    const downgraded = turn.text('ok', { serviceTier: 'default', usage: TURN_USAGE })
    const { request } = await sendTurn(app, server, 'downgraded', downgraded)
    assert.equal(request.body.service_tier, 'priority')
    await assertTurnCost(app, 1, before)
    const speed = await waitForSpeed(
      app,
      (s) => s.lastResponse?.mode === 'standard',
      'lastResponse standard'
    )
    assert.deepEqual(speed.lastResponse, { mode: 'standard', confirmed: true })
  })

  await checks.check('Standard from the menu: no service_tier', async () => {
    await pickModel(app, 'openai', 'gpt-6.1-sol')
    await chooseSpeed(app, 'standard')
    await waitForPill(app, 'Standard')
    const { request } = await sendTurn(app, server, 'back to standard')
    assert.equal(hasServiceTier(request), false)
  })

  // ─── 2. Anthropic API key ──────────────────────────────────────────────────────────────────────

  await checks.check(
    'claude-opus-5-5: menu Standard + Fast; Fast sends speed + beta, 2× cost',
    async () => {
      await pickModel(app, 'anthropic', 'claude-opus-5-5')
      await waitForPill(app, 'Standard')
      const items = await openSpeedMenu(app)
      await closeMenu(app)
      assert.equal(items.length, 2, JSON.stringify(items))
      assert.match(items[1], /^Fast[\s\S]*2× price/)
      await chooseSpeed(app, 'fast')
      await waitForPill(app, 'Fast')
      const before = await sessionCost(app)
      const { request } = await sendTurn(app, server, 'claude fast')
      logWire('claude-opus-5-5 fast', [request])
      assert.equal(request.body.speed, 'fast')
      assert.ok(anthropicBetas(request).includes(FAST_BETA), anthropicBetas(request).join(','))
      assert.equal('betas' in request.body, false, 'betas travel as a header, not in the body')
      await assertTurnCost(app, 2, before)
      const speed = await waitForSpeed(app, (s) => !!s.lastResponse, 'lastResponse')
      assert.deepEqual(speed.lastResponse, { mode: 'fast', confirmed: true })
    }
  )

  await checks.check(
    'Claude usage.speed "standard" (not served fast) is billed at 1×',
    async () => {
      const before = await sessionCost(app)
      const standard = turn.text('ok', { speed: 'standard', usage: TURN_USAGE })
      const { request } = await sendTurn(app, server, 'claude not fast', standard)
      assert.equal(request.body.speed, 'fast')
      await assertTurnCost(app, 1, before)
      const speed = await waitForSpeed(app, (s) => s.lastResponse?.mode === 'standard', 'standard')
      assert.deepEqual(speed.lastResponse, { mode: 'standard', confirmed: true })
    }
  )

  await checks.check(
    'a model switch while a Claude Fast answer streams keeps its 2× cost',
    async () => {
      const before = await sessionCost(app)
      const from = server.requests.length
      server.queue(turn.text('answer still streaming', { ...ECHO, chunkSize: 2, delayMs: 300 }))
      await app.send('claude fast, switched mid-stream')
      const request = await server.waitForRequest(undefined, { from })
      assert.equal(request.body.speed, 'fast')
      // `rpc` throws when the Engine refuses the switch and answers the selected model otherwise.
      const switched = await app.rpc({
        type: 'set_model',
        provider: 'anthropic',
        modelId: 'claude-sonnet-5-5'
      })
      assert.equal(switched.id, 'claude-sonnet-5-5')
      assert.equal(request.outcome, 'streaming', 'the switch lands before the answer ends')
      await server.waitForOutcome(request)
      await app.waitForSettle()
      const message = await lastAssistantMessage(app)
      assert.equal(message.model, 'claude-opus-5-5')
      await assertTurnCost(app, 2, before)
    }
  )

  await checks.check('claude-sonnet-5-5: no pill, no speed, no beta', async () => {
    await pickModel(app, 'anthropic', 'claude-sonnet-5-5')
    await waitForPill(app, null)
    assert.equal((await speedState(app)).requested, 'fast')
    const { request } = await sendTurn(app, server, 'sonnet turn')
    logWire('claude-sonnet-5-5', [request])
    assert.equal('speed' in request.body, false)
    assert.equal(anthropicBetas(request).includes(FAST_BETA), false)
  })

  // ─── 4. Refusals ───────────────────────────────────────────────────────────────────────────────

  await checks.check(
    'OpenAI 400 Unsupported service_tier: one toast, Standard, next request plain',
    async () => {
      await pickModel(app, 'openai', 'gpt-6.1-sol')
      await waitForPill(app, 'Fast')
      assert.equal((await app.appState()).prefs.features.settings?.speedDefault, 'fast')
      const toastsFrom = await toastCount(app)
      const refusal = turn.error(400, {
        body: {
          error: {
            message: 'Unsupported service_tier: priority',
            type: 'invalid_request_error',
            param: 'service_tier',
            code: null
          }
        }
      })
      const { request } = await sendTurn(app, server, 'refused turn', refusal)
      logWire('refused', [request])
      assert.equal(request.body.service_tier, 'priority')
      await waitForPill(app, 'Standard')
      const speed = await speedState(app)
      assert.equal(speed.requested, 'standard')
      assert.match(
        speed.notice?.text ?? '',
        /^Fast mode turned off: Unsupported service_tier: priority/
      )
      await until(async () => (await toastsSince(app, toastsFrom, /Fast mode turned off/)).length, {
        label: 'refusal toast'
      })
      await app.screenshot('speed-refused-openai')
      // A refusal concerns the account: new sessions start at Standard instead of failing again.
      await until(
        async () => (await app.appState()).prefs.features.settings?.speedDefault === 'standard',
        { label: 'default reset to Standard' }
      )
      const { request: next } = await sendTurn(app, server, 'after the refusal')
      logWire('after refusal', [next])
      assert.equal(hasServiceTier(next), false)
      const toasts = await toastsSince(app, toastsFrom, /Fast mode turned off/)
      assert.equal(toasts.length, 1, JSON.stringify(toasts))
    }
  )

  await checks.check(
    'Anthropic 429 credits: the retry goes out at standard speed, one toast',
    async () => {
      await pickModel(app, 'anthropic', 'claude-opus-5-5')
      await chooseSpeed(app, 'fast')
      await waitForPill(app, 'Fast')
      assert.equal((await app.appState()).prefs.features.settings?.speedDefault, 'fast')
      const toastsFrom = await toastCount(app)
      const from = server.requests.length
      server.queue(
        turn.error(429, {
          body: {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Usage credits are required for fast mode.'
            }
          }
        }),
        turn.text('retried at standard', ECHO)
      )
      await app.send('credits turn')
      await until(() => server.requests.slice(from).filter((r) => r.api).length >= 2, {
        label: 'the retry request',
        timeoutMs: 30_000
      })
      await app.waitForSettle()
      const [refused, retry] = server.requests.slice(from).filter((r) => r.api)
      logWire('429 + retry', [refused, retry])
      assert.equal(refused.body.speed, 'fast')
      assert.equal('speed' in retry.body, false, 'the retry is standard')
      assert.equal(anthropicBetas(retry).includes(FAST_BETA), false)
      await waitForPill(app, 'Standard')
      assert.equal((await lastAssistantMessage(app))?.stopReason, 'stop')
      await until(async () => (await toastsSince(app, toastsFrom, /Fast mode turned off/)).length, {
        label: 'refusal toast'
      })
      const { request: next } = await sendTurn(app, server, 'after credits')
      assert.equal('speed' in next.body, false)
      const toasts = await toastsSince(app, toastsFrom, /Fast mode turned off/)
      assert.equal(toasts.length, 1, JSON.stringify(toasts))
      assert.match(toasts[0], /Usage credits are required for fast mode/)
      assert.match(toasts[0], /Speed set to Standard/)
      await until(
        async () => (await app.appState()).prefs.features.settings?.speedDefault === 'standard',
        { label: 'default reset to Standard' }
      )
    }
  )

  // ─── 6. /fast and the palette ──────────────────────────────────────────────────────────────────

  await checks.check('/fast toggles Fast on: pill Fast, priority on the wire', async () => {
    await pickModel(app, 'openai', 'gpt-6.1-sol')
    await waitForPill(app, 'Standard')
    const from = await toastCount(app)
    await slash(app, '/fast')
    await waitForPill(app, 'Fast')
    assert.ok((await toastsSince(app, from, /Fast mode on/)).length, 'a "Fast mode on" toast')
    const { request } = await sendTurn(app, server, 'slash fast')
    assert.equal(request.body.service_tier, 'priority')
  })

  await checks.check('/fast ultrafast: ultrafast on the wire', async () => {
    await slash(app, '/fast ultrafast')
    await waitForPill(app, 'Ultrafast')
    const { request } = await sendTurn(app, server, 'slash ultrafast')
    assert.equal(request.body.service_tier, 'ultrafast')
  })

  await checks.check('/fast off: Standard, no service_tier', async () => {
    await slash(app, '/fast off')
    await waitForPill(app, 'Standard')
    assert.equal((await speedState(app)).requested, 'standard')
    const { request } = await sendTurn(app, server, 'slash off')
    assert.equal(hasServiceTier(request), false)
  })

  await checks.check('/fast ultrafast on Claude: refused in the UI, nothing changes', async () => {
    await pickModel(app, 'anthropic', 'claude-opus-5-5')
    const from = await toastCount(app)
    await slash(app, '/fast ultrafast')
    await until(async () => (await toastsSince(app, from, /Ultrafast is unavailable/)).length, {
      label: 'unavailable toast'
    })
    assert.equal((await speedState(app)).requested, 'standard')
    await slash(app, '/fast bogus')
    await until(async () => (await toastsSince(app, from, /Use \/fast on/)).length, {
      label: 'usage toast'
    })
    await pickModel(app, 'openai', 'gpt-6.1-sol')
  })

  await checks.check('palette: Turn on Fast mode → priority; Turn off → standard', async () => {
    await paletteFastToggle(app, 'Turn on Fast mode')
    await waitForPill(app, 'Fast')
    const { request } = await sendTurn(app, server, 'palette on')
    assert.equal(request.body.service_tier, 'priority')
    await paletteFastToggle(app, 'Turn off Fast mode')
    await waitForPill(app, 'Standard')
    const { request: off } = await sendTurn(app, server, 'palette off')
    assert.equal(hasServiceTier(off), false)
  })

  await checks.check('Fast on every request of a turn: tool follow-up and auto-retry', async () => {
    await chooseSpeed(app, 'fast')
    const from = server.requests.length
    server.queue(
      turn.toolCall('read', { path: 'README.md' }),
      turn.error(503, { message: 'Service unavailable' }),
      turn.text('done', ECHO)
    )
    await app.send('read the readme')
    await until(() => server.requests.slice(from).filter((r) => r.api).length >= 3, {
      label: 'tool follow-up and retry',
      timeoutMs: 30_000
    })
    await app.waitForSettle()
    const requests = server.requests.slice(from).filter((r) => r.api)
    logWire('tool + retry', requests)
    assert.equal(requests.length, 3)
    for (const request of requests) assert.equal(request.body.service_tier, 'priority')
    assert.equal((await lastAssistantMessage(app))?.stopReason, 'stop')
  })

  // The bridge's native compaction checkpoint carries the session's speed (withSessionSpeed).
  // Known limitation (speed-mode.ts, UPSTREAM.md): pi's own summary call (core/compaction
  // completeSummarization) goes through the agent's streamFn without onPayload, so
  // before_provider_request never fires and the summary runs at standard speed.
  let compaction = []
  await step('/compact at Fast (summary + native compaction requests)', async () => {
    await chooseSpeed(app, 'fast')
    const from = server.requests.length
    await slash(app, '/compact')
    // OpenAI models compact twice: the Engine's summary and the native server-side compaction.
    await server.waitForRequest(isNativeCompaction, { from })
    await app.page.getByText('Context compacted', { exact: true }).first().waitFor()
    await app.waitForSettle()
    compaction = server.requests.slice(from).filter((r) => r.api)
    logWire('compaction', compaction)
  })

  await checks.check('the compaction summary request runs at standard (documented)', async () => {
    const summaries = compaction.filter((r) => !isNativeCompaction(r))
    assert.ok(summaries.length >= 1, 'a summary request')
    for (const request of summaries) assert.equal(hasServiceTier(request), false)
  })

  await checks.check('Fast applies to the native compaction request', async () => {
    const native = compaction.find(isNativeCompaction)
    assert.equal(native?.body.service_tier, 'priority')
  })

  // ─── 5. Persistence ────────────────────────────────────────────────────────────────────────────

  let sessionFile
  await checks.check(
    'choose Fast in the session, then make Standard the default in Settings',
    async () => {
      await chooseSpeed(app, 'fast')
      sessionFile = (await app.rpc({ type: 'get_state' })).sessionFile
      assert.ok(sessionFile, 'a saved session')
      const { entries } = await app.rpc({ type: 'get_entries' })
      const saved = entries.filter((e) => e.type === 'custom' && e.customType === 'vengeance-speed')
      assert.equal(saved.at(-1)?.data?.mode, 'fast', 'the choice is a session entry')
      assert.equal((await app.appState()).prefs.features.settings?.speedDefault, 'fast')
      await openSettings(app, 'Models')
      const row = settingRow(app, 'app.speedDefault')
      await row.scrollIntoViewIfNeeded()
      await choose(app, 'app.speedDefault', 'Standard')
      await until(
        async () => (await app.appState()).prefs.features.settings?.speedDefault === 'standard',
        { label: 'default saved' }
      )
      await app.screenshot('speed-default-setting')
      await closeSettings(app)
    }
  )

  await checks.check('a new session starts at the default (Standard)', async () => {
    await app.openWorkspace({ cwd: workspace, args: { model: 'openai/gpt-6.1-sol' } })
    await waitForPill(app, 'Standard')
    const { request } = await sendTurn(app, server, 'new session standard')
    assert.equal(hasServiceTier(request), false)
  })

  await checks.check(
    'default Ultrafast in Settings → the next new session sends ultrafast',
    async () => {
      await openSettings(app, 'Models')
      await choose(app, 'app.speedDefault', 'Ultrafast')
      await until(
        async () => (await app.appState()).prefs.features.settings?.speedDefault === 'ultrafast',
        { label: 'default saved' }
      )
      await closeSettings(app)
      await app.openWorkspace({ cwd: workspace, args: { model: 'openai/gpt-6.1-sol' } })
      await waitForPill(app, 'Ultrafast')
      const { request } = await sendTurn(app, server, 'new session ultrafast')
      assert.equal(request.body.service_tier, 'ultrafast')
    }
  )

  await checks.check(
    'relaunch and resume the Fast session: still Fast (its own entry wins)',
    async () => {
      assert.ok(sessionFile, 'the Fast session was saved')
      app = await app.relaunch()
      app.allowError(/service_tier|fast mode|Usage credits/i)
      // The session row (open or saved) brings the session to the front, resuming it if needed.
      const row = app.page.locator('[data-session-row]', { hasText: SESSION_NAME }).first()
      await row.waitFor({ timeout: 60_000 })
      await row.click()
      await until(
        async () => {
          const state = await app.rpc({ type: 'get_state' }).catch(() => null)
          return state?.sessionFile?.toLowerCase() === sessionFile.toLowerCase()
        },
        { label: 'the Fast session in front', timeoutMs: 60_000 }
      )
      await waitForPill(app, 'Fast')
      assert.equal((await speedState(app)).requested, 'fast')
      await app.screenshot('speed-resumed-fast')
      const { request } = await sendTurn(app, server, 'resumed fast')
      logWire('resumed', [request])
      assert.equal(request.body.service_tier, 'priority')
    }
  )

  await checks.check('no unexpected app errors', async () => app.assertNoErrors())
  checks.finish()
} catch (error) {
  failure = error
  await app?.screenshot(`${SUITE}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await app?.close().catch((error) => (failure ??= error))
  await server.close().catch((error) => (failure ??= error))
  await agentDir.cleanup().catch((error) => (failure ??= error))
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE} passed`)
}
