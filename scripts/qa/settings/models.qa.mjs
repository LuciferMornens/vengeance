// Settings → Models, verified three ways: the real control, the JSON written to the temp agent dir's
// settings.json, and what the Engine does with it (RPC get_state, cycle_model and the fake LLM request).
//
//   node scripts/qa/settings/models.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  addListItems,
  choose,
  closeSettings,
  dismissToasts,
  fill,
  LAUNCH,
  newSessionIn,
  openSettings,
  pickModel,
  readJsonOrNull,
  restartFromToast,
  sendAndCapture,
  setSwitch,
  settingRow,
  toastWith,
  waitForJsonValue
} from './settings-ui.mjs'

/** pi-ai DEFAULT_THINKING_BUDGETS (api/simple-options.js). */
const BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }

await runSuite(
  'settings-models',
  async ({ server, agentDir, app, step }) => {
    const settingsPath = agentDir.path('settings.json')
    let cwd
    let agentId

    await step(
      'a session started with no flags uses the Engine defaults (medium, qa-reasoning)',
      async () => {
        ;({ agentId, cwd } = await app.openWorkspace())
        const state = await app.rpc({ type: 'get_state' })
        assert.equal(state.model?.id, FAKE_MODELS.reasoning)
        assert.equal(state.thinkingLevel, 'medium')
        const request = await sendAndCapture(app, server, 'hello', turn.text('hi'))
        assert.equal(inspectRequest(request).thinking?.budget_tokens, BUDGET.medium)
      }
    )

    await step('Default thinking level shows the Engine default "Medium"', async () => {
      await openSettings(app, 'Models')
      const combo = settingRow(app, 'defaultThinkingLevel').getByRole('combobox')
      assert.equal((await combo.innerText()).trim(), 'Medium')
    })

    await step('Default thinking level → Low writes {"defaultThinkingLevel":"low"}', async () => {
      await choose(app, 'defaultThinkingLevel', 'Low')
      const data = await waitForJsonValue(settingsPath, 'defaultThinkingLevel', 'low')
      assert.equal(data.defaultProvider, FAKE_PROVIDER, 'unrelated keys are preserved')
      // Saved sessions resume their own thinking level, so a restart would change nothing.
      await app.page.waitForTimeout(800)
      assert.equal(
        await toastWith(app, 'Restart to apply').isVisible(),
        false,
        'a new default offers no restart'
      )
    })

    await step('a new session starts at "low" and sends the low budget', async () => {
      await closeSettings(app)
      const fresh = await newSessionIn(app, cwd)
      assert.equal((await app.rpc({ type: 'get_state' }, fresh)).thinkingLevel, 'low')
      const request = await sendAndCapture(app, server, 'hello low', turn.text('ok'))
      assert.equal(inspectRequest(request).thinking?.budget_tokens, BUDGET.low)
      agentId = fresh
    })

    await step(
      'Low budget = 3000 writes thinkingBudgets.low and applies after "Restart engines"',
      async () => {
        await openSettings(app, 'Models')
        const input = settingRow(app, 'thinkingBudgets.low').locator('input')
        assert.equal(
          await input.getAttribute('placeholder'),
          String(BUDGET.low),
          'placeholder = Engine default'
        )
        await fill(app, 'thinkingBudgets.low', 3000)
        const data = await waitForJsonValue(settingsPath, 'thinkingBudgets', { low: 3000 })
        assert.equal(data.defaultThinkingLevel, 'low')
        await restartFromToast(app, agentId)
        await closeSettings(app)
        const request = await sendAndCapture(app, server, 'after restart', turn.text('ok'))
        assert.equal(inspectRequest(request).thinking?.budget_tokens, 3000)
        assert.equal((await app.rpc({ type: 'get_state' })).thinkingLevel, 'low', 'resumed session')
      }
    )

    await step(
      'Default model → QA Vision writes defaultProvider/defaultModel; a new session uses it',
      async () => {
        await openSettings(app, 'Models')
        await pickModel(
          app,
          settingRow(app, 'defaultModel').locator('button[aria-haspopup="dialog"]'),
          'QA Vision'
        )
        await waitForJsonValue(settingsPath, 'defaultModel', FAKE_MODELS.vision)
        const data = await readJsonOrNull(settingsPath)
        assert.equal(data.defaultProvider, FAKE_PROVIDER)
        await closeSettings(app)
        const fresh = await newSessionIn(app, cwd)
        const state = await app.rpc({ type: 'get_state' }, fresh)
        assert.equal(state.model?.id, FAKE_MODELS.vision)
        const request = await sendAndCapture(app, server, 'vision default', turn.text('ok'))
        assert.equal(inspectRequest(request).model, FAKE_MODELS.vision)
      }
    )

    await step(
      'Per-model thinking: qa/qa-reasoning → Minimal wins over the default level',
      async () => {
        await openSettings(app, 'Models')
        await pickModel(
          app,
          settingRow(app, 'defaultModel').locator('button[aria-haspopup="dialog"]'),
          'QA Reasoning'
        )
        await waitForJsonValue(settingsPath, 'defaultModel', FAKE_MODELS.reasoning)
        const row = settingRow(app, 'modelThinkingLevels')
        await pickModel(app, row.getByRole('button', { name: 'Add model' }), 'QA Reasoning')
        await waitForJsonValue(settingsPath, 'modelThinkingLevels', { 'qa/qa-reasoning': 'high' })
        await row.getByRole('combobox').click()
        await app.page.getByRole('option', { name: 'Minimal', exact: true }).click()
        await waitForJsonValue(settingsPath, 'modelThinkingLevels', {
          'qa/qa-reasoning': 'minimal'
        })
        await closeSettings(app)
        const fresh = await newSessionIn(app, cwd)
        assert.equal((await app.rpc({ type: 'get_state' }, fresh)).thinkingLevel, 'minimal')
        const request = await sendAndCapture(app, server, 'per model', turn.text('ok'))
        assert.equal(inspectRequest(request).thinking?.budget_tokens, BUDGET.minimal)
      }
    )

    await step(
      'Enabled models: two patterns written; the Engine cycles only through them',
      async () => {
        await openSettings(app, 'Models')
        await addListItems(app, 'enabledModels', ['qa/qa-reasoning', 'qa/qa-small'])
        await waitForJsonValue(settingsPath, 'enabledModels', ['qa/qa-reasoning', 'qa/qa-small'])
        await settingRow(app, 'enabledModels')
          .getByText('2 available models in the cycle')
          .waitFor()
        await closeSettings(app)
        const fresh = await newSessionIn(app, cwd)
        const seen = new Set()
        for (let i = 0; i < 4; i++) {
          const cycled = await app.rpc({ type: 'cycle_model' }, fresh)
          seen.add(cycled.model.id)
        }
        assert.deepEqual([...seen].sort(), [FAKE_MODELS.reasoning, FAKE_MODELS.small])
      }
    )

    await step('Hide thinking blocks applies live to the transcript (no restart)', async () => {
      await app.rpc({ type: 'set_model', provider: FAKE_PROVIDER, modelId: FAKE_MODELS.reasoning })
      await app.rpc({ type: 'set_thinking_level', level: 'low' })
      await sendAndCapture(
        app,
        server,
        'think visibly',
        turn.thinking('Visible reasoning.', 'Shown.')
      )
      const thought = app.page.getByRole('button', { name: /^Thought/ })
      await thought.first().waitFor()
      await openSettings(app, 'Models')
      await dismissToasts(app)
      await setSwitch(app, 'hideThinkingBlock', true)
      await waitForJsonValue(settingsPath, 'hideThinkingBlock', true)
      assert.equal(
        await toastWith(app, 'Restart to apply').isVisible(),
        false,
        'GUI setting needs no restart'
      )
      await closeSettings(app)
      await app.page.getByText('Shown.').waitFor()
      // Hidden = the chip stays, marked hidden, and no longer expands to the reasoning.
      await app.page.locator('[data-thinking-hidden]').first().waitFor()
      await thought.first().click({ force: true })
      assert.equal(await app.page.getByText('Visible reasoning.').isVisible(), false)
      await openSettings(app, 'Models')
      await setSwitch(app, 'hideThinkingBlock', false)
      await waitForJsonValue(settingsPath, 'hideThinkingBlock', false)
      await closeSettings(app)
      await app.page.locator('[data-thinking-hidden]').waitFor({ state: 'detached' })
      await thought.first().click()
      await app.page.getByText('Visible reasoning.').waitFor()
    })

    await step('Cache notices and cache warming round-trip to settings.json', async () => {
      await openSettings(app, 'Models')
      await setSwitch(app, 'showCacheMissNotices', true)
      await waitForJsonValue(settingsPath, 'showCacheMissNotices', true)
      await choose(app, 'cacheWarming', 'Off')
      await waitForJsonValue(settingsPath, 'cacheWarming', 'off')
      await app.screenshot('settings-models')
    })
  },
  { launch: LAUNCH }
)
