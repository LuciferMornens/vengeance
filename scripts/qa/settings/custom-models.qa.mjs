// Settings → Custom models (models.json): add a provider and a model with headers, compatibility and
// sampling parameters through the visual editor, then check the file written and what the fake LLM
// receives; edit, delete, validation errors and modelOverrides.
//
//   node scripts/qa/settings/custom-models.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { FAKE_API_KEY, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  closeSettings,
  dismissToasts,
  LAUNCH,
  newSessionIn,
  openSettings,
  readJsonOrNull,
  sendAndCapture,
  softSteps,
  toastWith,
  waitFor
} from './settings-ui.mjs'

const PROVIDER = 'qa2'
const MODEL = 'qa2-model'
const SECRET = 'qa-test-value'

/** The provider card (a settings Group), found by its "Remove <id>" button. */
function providerCard(app, id) {
  return app.page.locator('section', { has: app.page.locator(`button[aria-label="Remove ${id}"]`) })
}

/** Commit a TextField / NumberField: fill, then Enter (blur commits). */
async function commit(input, value) {
  await input.fill(String(value))
  await input.press('Enter')
}

/** Add one key/value row (headers or sampling) by its add button and fill it. */
async function addKeyValue(scope, addLabel, name, value) {
  await scope.getByRole('button', { name: addLabel }).last().click()
  await scope.getByRole('textbox', { name: 'Name', exact: true }).last().fill(name)
  await scope.getByRole('textbox', { name: `Value of ${name}` }).fill(value)
}

async function save(app) {
  await dismissToasts(app)
  await app.page.getByRole('button', { name: 'Save', exact: true }).click()
  await toastWith(app, 'Custom models saved').waitFor()
}

await runSuite(
  'settings-custom-models',
  async (context) => {
    const { server, agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-custom-models')
    const modelsPath = agentDir.path('models.json')
    const readModels = () => readJsonOrNull(modelsPath)
    let cwd

    await step('Custom models lists the existing provider with its key masked', async () => {
      ;({ cwd } = await app.openWorkspace())
      await openSettings(app, 'Custom models')
      const card = providerCard(app, FAKE_PROVIDER)
      await card.getByText('4 models').waitFor()
      const key = card.getByPlaceholder('OLLAMA_API_KEY')
      assert.notEqual(await key.inputValue(), FAKE_API_KEY, 'API key reaches the UI masked')
    })

    await step('add provider qa2 with base URL, literal key and a provider header', async () => {
      await app.page.getByPlaceholder('Provider id, e.g. ollama').fill(PROVIDER)
      await app.page.getByRole('button', { name: 'Add provider' }).click()
      const card = providerCard(app, PROVIDER)
      await card.waitFor()
      await commit(card.getByPlaceholder('http://localhost:11434/v1'), server.openaiBaseUrl)
      await commit(card.getByPlaceholder('OLLAMA_API_KEY'), SECRET)
      await card.getByRole('button', { name: 'Headers and compatibility' }).click()
      await addKeyValue(card, 'Add header', 'X-QA-Provider', 'provider-header')
    })

    await step(
      'add model qa2-model with a header, max-tokens compat and sampling params',
      async () => {
        const card = providerCard(app, PROVIDER)
        await card.getByRole('button', { name: 'Add model' }).click()
        await commit(card.getByPlaceholder('model-id'), MODEL)
        await commit(card.getByPlaceholder('Display name'), 'QA2 Model')
        await card
          .getByRole('button', { name: `Headers, compatibility and sampling of ${MODEL}` })
          .click()
        await addKeyValue(card, 'Add header', 'X-QA-Model', 'model-header')
        await card.getByRole('button', { name: 'Add setting' }).last().click()
        await app.page.getByRole('menuitem', { name: 'Max tokens field' }).click()
        await card.getByRole('combobox').last().click()
        await app.page.getByRole('option', { name: 'max_tokens', exact: true }).click()
        await addKeyValue(card, 'Add parameter', 'temperature', '0.3')
        await addKeyValue(card, 'Add parameter', 'top_p', '0.9')
        await app.page.getByText('Unsaved changes to models.json').waitFor()
        await app.screenshot('settings-custom-models-draft')
      }
    )

    await step(
      'Save writes exactly the provider, the literal key and the model fields',
      async () => {
        await save(app)
        const qa2 = (await readModels()).providers[PROVIDER]
        assert.deepEqual(qa2, {
          baseUrl: server.openaiBaseUrl,
          api: 'openai-completions',
          apiKey: SECRET,
          models: [
            {
              id: MODEL,
              name: 'QA2 Model',
              headers: { 'X-QA-Model': 'model-header' },
              compat: { maxTokensField: 'max_tokens' },
              samplingParams: { temperature: 0.3, top_p: 0.9 }
            }
          ],
          headers: { 'X-QA-Provider': 'provider-header' }
        })
        assert.equal(
          (await readModels()).providers[FAKE_PROVIDER].apiKey,
          FAKE_API_KEY,
          'other key untouched'
        )
      }
    )

    await step(
      'a session on qa2/qa2-model sends the key, both headers, sampling and max_tokens',
      async () => {
        await closeSettings(app)
        await newSessionIn(app, cwd, { model: `${PROVIDER}/${MODEL}` })
        const request = await sendAndCapture(app, server, 'custom model', turn.text('ok'))
        assert.equal(request.api, 'openai-completions')
        assert.equal(request.body.model, MODEL)
        assert.equal(request.headers.authorization, `Bearer ${SECRET}`)
        assert.equal(request.headers['x-qa-provider'], 'provider-header')
        assert.equal(request.headers['x-qa-model'], 'model-header')
        assert.equal(request.body.temperature, 0.3)
        assert.equal(request.body.top_p, 0.9)
        assert.ok('max_tokens' in request.body, `body keys: ${Object.keys(request.body)}`)
        assert.ok(!('max_completion_tokens' in request.body))
      }
    )

    await step('edit: renaming the model keeps the stored (masked) key on save', async () => {
      await openSettings(app, 'Custom models')
      const card = providerCard(app, PROVIDER)
      const key = card.getByPlaceholder('OLLAMA_API_KEY')
      assert.ok((await key.inputValue()).startsWith('\u2022'), 'key shown masked')
      await commit(card.getByPlaceholder('Display name'), 'QA2 Renamed')
      await save(app)
      const qa2 = (await readModels()).providers[PROVIDER]
      assert.equal(qa2.models[0].name, 'QA2 Renamed')
      assert.equal(qa2.apiKey, SECRET)
      assert.deepEqual(
        qa2.headers,
        { 'X-QA-Provider': 'provider-header' },
        'masked header restored'
      )
    })

    await step(
      'a custom model’s header values reach the UI masked like provider headers',
      async () => {
        const card = providerCard(app, PROVIDER)
        const providerValue = card.getByRole('textbox', { name: 'Value of X-QA-Provider' })
        if (!(await providerValue.isVisible())) {
          await card.getByRole('button', { name: 'Headers and compatibility' }).click()
        }
        assert.ok((await providerValue.inputValue()).startsWith('\u2022'), 'provider header masked')
        await card
          .getByRole('button', { name: `Headers, compatibility and sampling of ${MODEL}` })
          .click()
        const modelValue = card.getByRole('textbox', { name: 'Value of X-QA-Model' })
        await modelValue.waitFor()
        await app.screenshot('settings-custom-models-headers')
        // BUG settings-9 (P1): models.ts mapModelsSecrets() masks provider and modelOverrides headers
        // but not `models[].headers`, so a custom model's header secrets reach the renderer in clear.
        assert.ok(
          (await modelValue.inputValue()).startsWith('\u2022'),
          'model header shown in clear'
        )
      }
    )

    await step('validation: an empty model id and a bad base URL block saving', async () => {
      const card = providerCard(app, PROVIDER)
      await card.getByRole('button', { name: 'Add model' }).click()
      await commit(card.getByPlaceholder('http://localhost:11434/v1'), 'localhost:1234')
      await card.getByText('qa2: model #2 needs an id.').waitFor()
      await card.getByText('qa2: base URL must start with http:// or https://.').waitFor()
      await app.page.getByText('2 problems to fix before saving').waitFor()
      assert.equal(
        await app.page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
        true
      )
      await app.screenshot('settings-custom-models-invalid')
      await app.page.getByRole('button', { name: 'Discard' }).click()
      await app.page.getByText('Unsaved changes to models.json').waitFor({ state: 'detached' })
    })

    await step('validation: a duplicate model id is reported', async () => {
      const card = providerCard(app, PROVIDER)
      await card.getByRole('button', { name: 'Add model' }).click()
      await commit(card.getByPlaceholder('model-id').last(), MODEL)
      await card.getByText(`qa2: duplicate model id "${MODEL}".`).waitFor()
      await app.page.getByRole('button', { name: 'Discard' }).click()
    })

    await step(
      'modelOverrides: a built-in model override is written and the Engine applies it',
      async () => {
        await app.page.getByPlaceholder('Provider id, e.g. ollama').fill('anthropic')
        await app.page.getByRole('button', { name: 'Add provider' }).click()
        const card = providerCard(app, 'anthropic')
        await card.getByText('Overrides built-in').waitFor()
        // A dummy key makes the built-in models "available" to the Engine; nothing is ever sent to it.
        await commit(
          card.getByPlaceholder('Signed-in account or key'),
          'qa-dummy-anthropic-key-000'
        )
        const { models } = await app.invoke('settings:catalog')
        const target = models.find((m) => m.provider === 'anthropic')
        assert.ok(target, 'a built-in anthropic model')
        await card.getByPlaceholder('Model id to override').fill(target.id)
        await card.getByRole('button', { name: 'Add override' }).click()
        await commit(card.getByRole('textbox', { name: `Context window of ${target.id}` }), 123456)
        await save(app)
        const anthropic = (await readModels()).providers.anthropic
        assert.deepEqual(anthropic.modelOverrides, { [target.id]: { contextWindow: 123456 } })
        await closeSettings(app)
        const fresh = await newSessionIn(app, cwd)
        const available = await app.rpc({ type: 'get_available_models' }, fresh)
        const seen = available.models.find((m) => m.provider === 'anthropic' && m.id === target.id)
        assert.equal(seen?.contextWindow, 123456)
      }
    )

    await step(
      'delete: removing the model and the providers drops them from models.json',
      async () => {
        await openSettings(app, 'Custom models')
        await providerCard(app, PROVIDER).getByRole('button', { name: 'Remove model' }).click()
        await save(app)
        assert.equal((await readModels()).providers[PROVIDER].models, undefined)
        await providerCard(app, PROVIDER)
          .getByRole('button', { name: `Remove ${PROVIDER}` })
          .click()
        await providerCard(app, 'anthropic')
          .getByRole('button', { name: 'Remove anthropic' })
          .click()
        await save(app)
        const providers = (await readModels()).providers
        assert.deepEqual(Object.keys(providers), [FAKE_PROVIDER])
        assert.equal(providers[FAKE_PROVIDER].apiKey, FAKE_API_KEY)
        await waitFor(async () => {
          const { models } = await app.invoke('settings:catalog')
          return !models.some((m) => m.provider === PROVIDER)
        }, 'catalog without qa2')
      }
    )

    finish()
  },
  { launch: LAUNCH }
)
