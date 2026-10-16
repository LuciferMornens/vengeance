// Settings → Models in a temp agent dir: the default model, per-model thinking levels and the
// enabled-models cycle (settings.md "Model and thinking"). Each control is set through the UI,
// checked in settings.json, and then proven on a NEW session (get_state + the request the engine
// sends to the fake LLM, or the engine's own cycle_model through Ctrl+P).
import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  LAUNCH,
  openAnotherWorkspace,
  openSettings,
  sendVisible,
  settleVisible,
  softSteps,
  waitUntil
} from './helpers.mjs'

const key = (id) => `${FAKE_PROVIDER}/${id}`

await runSuite(
  'auth-default-model',
  async ({ server, agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    const settingRow = (name) => page.locator(`[id="setting-${name}"]`)
    const settingsJson = () => agentDir.readJson('settings.json')

    /** Pick a model in a settings ModelPicker popover (search, then click the row). */
    async function pickInPopover(name) {
      const search = page.getByPlaceholder('Search models…').filter({ visible: true })
      await search.fill(name)
      await page
        .getByRole('option', { name: new RegExp(`^${name}`) })
        .first()
        .click()
    }

    /** New session (no --model): what the engine starts with, and what it sends. */
    async function newSessionSends() {
      const agentId = await openAnotherWorkspace(app)
      const state = await app.rpc({ type: 'get_state' }, agentId)
      const from = server.requests.length
      server.queue(turn.text('ok'))
      await sendVisible(app, 'Reply with ok')
      await settleVisible(app)
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      return { agentId, state, sent }
    }

    await step('open a workspace; Settings → Models shows the current default', async () => {
      await app.openWorkspace()
      await openSettings(app, 'models', 'Models')
      await settingRow('defaultModel').getByText('QA Reasoning').waitFor()
      await app.screenshot('models-01-section')
    })

    await step('Default model → QA Vision writes defaultProvider/defaultModel', async () => {
      await settingRow('defaultModel')
        .getByRole('button', { name: /QA Reasoning/ })
        .click()
      await pickInPopover('QA Vision')
      await waitUntil(async () => (await settingsJson()).defaultModel === FAKE_MODELS.vision, {
        label: 'settings.json defaultModel'
      })
      const settings = await settingsJson()
      assert.equal(settings.defaultProvider, FAKE_PROVIDER)
      assert.equal(settings.defaultModel, FAKE_MODELS.vision)
      await settingRow('defaultModel').getByText('QA Vision').waitFor()
    })

    await step('a new session starts on the new default and sends to it', async () => {
      await app.test('closeSettings')
      const { state, sent } = await newSessionSends()
      assert.equal(state.model.id, FAKE_MODELS.vision)
      assert.equal(sent.model, FAKE_MODELS.vision)
    })

    await step('Per-model thinking: add QA OpenAI at Low → modelThinkingLevels', async () => {
      await openSettings(app, 'models', 'Models')
      const row = settingRow('modelThinkingLevels')
      await row.getByRole('button', { name: 'Add model' }).click()
      await pickInPopover('QA OpenAI')
      await waitUntil(
        async () => (await settingsJson()).modelThinkingLevels?.[key(FAKE_MODELS.openai)],
        { label: 'modelThinkingLevels entry' }
      )
      assert.equal((await settingsJson()).modelThinkingLevels[key(FAKE_MODELS.openai)], 'high')
      await row.getByRole('combobox').click()
      const levels = await page.getByRole('option').allInnerTexts()
      const engineLevels = (await app.invoke('settings:catalog')).models.find(
        (m) => m.provider === FAKE_PROVIDER && m.id === FAKE_MODELS.openai
      ).thinkingLevels
      assert.equal(levels.length, engineLevels.length, `offered: ${levels.join(', ')}`)
      await page.getByRole('option', { name: 'Low', exact: true }).click()
      await waitUntil(
        async () => (await settingsJson()).modelThinkingLevels?.[key(FAKE_MODELS.openai)] === 'low',
        { label: 'modelThinkingLevels = low' }
      )
      await app.screenshot('models-02-per-model-thinking')
    })

    await step('switching a session to QA OpenAI applies its remembered level (low)', async () => {
      await app.test('closeSettings')
      const agentId = await openAnotherWorkspace(app, { model: key(FAKE_MODELS.reasoning) })
      assert.equal((await app.rpc({ type: 'get_state' }, agentId)).thinkingLevel, 'medium')
      await page
        .getByRole('button', { name: /^Model: / })
        .filter({ visible: true })
        .click()
      await page
        .locator(`[cmdk-item][data-value="${key(FAKE_MODELS.openai)}"]`)
        .filter({ visible: true })
        .click()
      await waitUntil(
        async () => (await app.agentState(agentId))?.model?.id === FAKE_MODELS.openai,
        {
          label: 'model switch'
        }
      )
      const state = await app.rpc({ type: 'get_state' }, agentId)
      assert.equal(state.thinkingLevel, 'low')
      await page
        .getByRole('button', { name: /^Thinking level:/ })
        .filter({ visible: true })
        .waitFor()
      assert.equal((await app.agentState(agentId)).thinkingLevel, 'low', 'UI shows low')
      const from = server.requests.length
      server.queue(turn.text('ok'))
      await sendVisible(app, 'Reply with ok')
      await settleVisible(app)
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      assert.equal(sent.reasoningEffort, 'low')
    })

    await soft.step('composer picker opens with the current model highlighted', async () => {
      await page
        .getByRole('button', { name: /^Model: / })
        .filter({ visible: true })
        .click()
      const list = page.locator('[cmdk-list]').filter({ visible: true }).last()
      await list.locator('[cmdk-item]').first().waitFor()
      await page.waitForTimeout(300)
      const highlighted = await list
        .locator('[cmdk-item][data-selected="true"]')
        .getAttribute('data-value')
      await page.keyboard.press('Escape')
      assert.equal(highlighted, key(FAKE_MODELS.openai))
    })

    await step('Enabled models: add QA Reasoning + QA Small → enabledModels', async () => {
      await openSettings(app, 'models', 'Models')
      const row = settingRow('enabledModels')
      await row.getByText('Cycling uses every available model.').waitFor()
      await row.getByRole('button', { name: 'Add model' }).click()
      await pickInPopover('QA Reasoning')
      await row.getByRole('button', { name: 'Add model' }).click()
      await pickInPopover('QA Small Context')
      await waitUntil(async () => (await settingsJson()).enabledModels?.length === 2, {
        label: 'enabledModels'
      })
      assert.deepEqual((await settingsJson()).enabledModels, [
        key(FAKE_MODELS.reasoning),
        key(FAKE_MODELS.small)
      ])
      await row.getByText('available models in the cycle').waitFor()
      await app.screenshot('models-03-enabled-models')
    })

    await soft.step('Ctrl+P in a new session cycles only the enabled models', async () => {
      await app.test('closeSettings')
      const agentId = await openAnotherWorkspace(app, { model: key(FAKE_MODELS.reasoning) })
      const seen = []
      for (let press = 0; press < 3; press++) {
        const before = (await app.rpc({ type: 'get_state' }, agentId)).model.id
        await page.keyboard.press('Control+p')
        const after = await waitUntil(
          async () => {
            const id = (await app.rpc({ type: 'get_state' }, agentId)).model.id
            return id !== before && id
          },
          { label: `cycle #${press + 1}` }
        )
        seen.push(after)
      }
      assert.deepEqual(seen, [FAKE_MODELS.small, FAKE_MODELS.reasoning, FAKE_MODELS.small])
      await waitUntil(
        async () => (await app.agentState(agentId))?.model?.id === FAKE_MODELS.small,
        {
          label: 'UI follows model cycle'
        }
      )
      assert.equal((await app.agentState(agentId)).model.id, FAKE_MODELS.small, 'UI follows')
    })

    await step(
      'Enabled models: a typed "qa-openai:high" pattern is saved and counted',
      async () => {
        await openSettings(app, 'models', 'Models')
        const row = settingRow('enabledModels')
        const input = row.locator('input:not([type])').first()
        await input.fill('qa-openai:high')
        await input.press('Enter')
        await waitUntil(async () => (await settingsJson()).enabledModels?.length === 3, {
          label: 'third enabledModels pattern'
        })
        assert.equal((await settingsJson()).enabledModels[2], 'qa-openai:high')
        await row.getByText('3', { exact: true }).waitFor()
        await app.screenshot('models-04-enabled-pattern')
      }
    )

    await soft.step(
      'Ctrl+P reaches QA OpenAI with the pattern level (high wins over low)',
      async () => {
        await app.test('closeSettings')
        const agentId = await openAnotherWorkspace(app, { model: key(FAKE_MODELS.reasoning) })
        for (const expected of [FAKE_MODELS.small, FAKE_MODELS.openai]) {
          await page.keyboard.press('Control+p')
          await waitUntil(
            async () => (await app.rpc({ type: 'get_state' }, agentId)).model.id === expected,
            { label: `cycle to ${expected}` }
          )
        }
        assert.equal((await app.rpc({ type: 'get_state' }, agentId)).thinkingLevel, 'high')
        await waitUntil(async () => (await app.agentState(agentId)).thinkingLevel === 'high', {
          label: 'UI thinking level high'
        })
      }
    )

    soft.finish()
  },
  { launch: LAUNCH }
)
