// API-key sign-in end to end, in a temp agent dir: Settings → Providers → OpenRouter → API key.
// The built-in openrouter provider is pointed at the fake LLM through models.json (a provider-level
// baseUrl override), so the key the user typed is proven by the Authorization header the engine
// sends, not just by what the UI shows.
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  LAUNCH,
  engineModelKeys,
  openAnotherWorkspace,
  openComposerPicker,
  openSettings,
  providerRow,
  readTempAuth,
  realAuthStat,
  routeProviderToFake,
  sendVisible,
  settleVisible,
  softSteps,
  waitUntil
} from './helpers.mjs'

const PROVIDER = 'openrouter'
/** Synthetic provider key used only by isolated QA. */
const KEY = 'qa-test-value'

await runSuite(
  'auth-api-key',
  async ({ server, agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    const realAuthBefore = await realAuthStat()
    let agentId
    let openrouterChatModel
    const restartFromToast = async () => {
      const toast = page.locator('[role=status]', { hasText: 'Restart to apply' }).first()
      await toast.getByRole('button', { name: 'Restart engines' }).click()
    }

    await step('point the built-in openrouter provider at the fake LLM', async () => {
      await routeProviderToFake(agentDir, server, PROVIDER)
    })

    await step('open a workspace on the fake provider', async () => {
      ;({ agentId } = await app.openWorkspace())
      const keys = await engineModelKeys(app, agentId)
      assert.ok(
        !keys.some((key) => key.startsWith(`${PROVIDER}/`)),
        'no OpenRouter models before sign-in'
      )
      const catalog = await app.invoke('settings:catalog')
      const provider = catalog.providers.find((p) => p.id === PROVIDER)
      assert.equal(provider.status.configured, false)
      openrouterChatModel = catalog.models.find(
        (m) => m.provider === PROVIDER && m.api === 'openai-completions' && !m.reasoning
      )
      assert.ok(openrouterChatModel, 'an openai-completions OpenRouter model to talk to')
    })

    await step('Providers lists OpenRouter with both sign-in methods', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      const row = providerRow(page, PROVIDER)
      await row.waitFor()
      await row.getByRole('button', { name: 'API key' }).waitFor()
      await row.getByRole('button', { name: 'Sign in with OpenRouter' }).waitFor()
      await app.screenshot('api-key-01-providers')
    })

    await soft.step('whitespace-only key cannot be saved', async () => {
      await providerRow(page, PROVIDER).getByRole('button', { name: 'API key' }).click()
      const dialog = page.getByRole('dialog', { name: 'OpenRouter API key' })
      await dialog.waitFor()
      const input = dialog.locator('input[type="password"]')
      await input.waitFor()
      await input.fill('    ')
      assert.equal(await dialog.getByRole('button', { name: 'Save key' }).isDisabled(), true)
      await input.press('Enter')
      await page.waitForTimeout(300)
      const auth = await readTempAuth(agentDir)
      assert.ok(!auth?.[PROVIDER], 'nothing stored for a blank key')
      await app.screenshot('api-key-02-dialog')
    })

    await step(
      'save a key (pasted with surrounding spaces) → engine-format auth.json',
      async () => {
        const dialog = page.getByRole('dialog', { name: 'OpenRouter API key' })
        await dialog.locator('input').first().fill(`  ${KEY}  `)
        await dialog.getByRole('button', { name: 'Show key' }).click()
        assert.equal(await dialog.locator('input').first().getAttribute('type'), 'text')
        await dialog.getByRole('button', { name: 'Save key' }).click()
        await dialog.getByText('Connected').waitFor()
        await app.screenshot('api-key-03-connected')
        const auth = await waitUntil(() => readTempAuth(agentDir), { label: 'auth.json' })
        // Engine format (providers.md): { "<provider>": { "type": "api_key", "key": "..." } }.
        assert.deepEqual(auth, { [PROVIDER]: { type: 'api_key', key: KEY } })
        await dialog.waitFor({ state: 'detached' })
      }
    )

    await step('the real auth.json was not touched', async () => {
      assert.deepEqual(await realAuthStat(), realAuthBefore)
    })

    await step('OpenRouter moves to Connected with a masked key and its model count', async () => {
      const row = providerRow(page, PROVIDER)
      await row.getByText(`API key ${KEY.slice(0, 4)}…${KEY.slice(-4)}`).waitFor()
      const catalog = await app.invoke('settings:catalog')
      const provider = catalog.providers.find((p) => p.id === PROVIDER)
      assert.equal(provider.status.configured, true)
      assert.equal(provider.status.source, 'stored')
      await row.getByText(`${provider.availableCount} models`).waitFor()
      assert.ok(!(await page.locator('body').innerText()).includes(KEY), 'full key never rendered')
      await row.getByRole('button', { name: 'Replace key' }).waitFor()
      await row.getByRole('button', { name: 'Remove key' }).waitFor()
      await app.screenshot('api-key-04-connected-row')
    })

    // auth-1: the engine keeps its availability snapshot from startup (rpc-mode get_available_models /
    // set_model read getAvailableSnapshot()), so a sign-in reaches open sessions through the restart
    // policy. Under the default policy ('ask') that is the "Restart to apply" toast.
    await soft.step('the open session lists OpenRouter models after sign-in', async () => {
      await app.test('closeSettings')
      await restartFromToast()
      // The agent is unknown for a moment while its engine restarts.
      await waitUntil(
        async () =>
          (await engineModelKeys(app, agentId).catch(() => [])).some((key) =>
            key.startsWith(`${PROVIDER}/`)
          ),
        { timeoutMs: 20_000, label: 'OpenRouter models in the open session (get_available_models)' }
      )
    })

    let secondId
    await step(
      'a new session lists OpenRouter in the engine and in the composer picker',
      async () => {
        secondId = await openAnotherWorkspace(app)
        const engineKeys = await engineModelKeys(app, secondId)
        const engineOpenRouter = engineKeys.filter((key) => key.startsWith(`${PROVIDER}/`))
        assert.ok(engineOpenRouter.length > 0, 'engine offers OpenRouter models')
        const pickerKeys = await openComposerPicker(app)
        assert.deepEqual(
          pickerKeys.filter((key) => key.startsWith(`${PROVIDER}/`)).sort(),
          engineOpenRouter.sort(),
          'picker shows exactly the OpenRouter models the engine offers'
        )
        await page.locator('[cmdk-group-heading]', { hasText: 'OpenRouter' }).first().waitFor()
        await app.screenshot('api-key-05-picker')
      }
    )

    await step('picking an OpenRouter model and prompting sends the stored key', async () => {
      await page.getByPlaceholder('Search models…').fill(openrouterChatModel.id)
      await page.locator(`[cmdk-item][data-value="${PROVIDER}/${openrouterChatModel.id}"]`).click()
      await waitUntil(
        async () => (await app.agentState(secondId))?.model?.id === openrouterChatModel.id,
        {
          label: 'model switch'
        }
      )
      const from = server.requests.length
      server.queue(turn.text('Hello through OpenRouter.'))
      await sendVisible(app, 'Say hello')
      await settleVisible(app)
      const request = await server.waitForRequest(undefined, { from })
      assert.equal(request.path, '/v1/chat/completions')
      assert.equal(inspectRequest(request).model, openrouterChatModel.id)
      assert.equal(request.headers.authorization, `Bearer ${KEY}`)
      await page.getByText('Hello through OpenRouter.').waitFor()
    })

    await step('Remove key deletes the credential from auth.json', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      await providerRow(page, PROVIDER).getByRole('button', { name: 'Remove key' }).click()
      await page.getByText('Signed out of OpenRouter').waitFor()
      const auth = await readTempAuth(agentDir)
      assert.ok(!auth || !(PROVIDER in auth), `auth.json no longer holds ${PROVIDER}`)
      await providerRow(page, PROVIDER).getByRole('button', { name: 'API key' }).waitFor()
      await app.screenshot('api-key-06-removed')
      await app.test('closeSettings')
    })

    // auth-1 (other direction): a sign-out reaches open sessions the same way.
    await soft.step('the open session drops OpenRouter after sign-out', async () => {
      await restartFromToast()
      await waitUntil(
        async () => {
          const keys = await engineModelKeys(app, secondId).catch(() => null)
          return keys !== null && !keys.some((key) => key.startsWith(`${PROVIDER}/`))
        },
        { timeoutMs: 20_000, label: 'OpenRouter gone from the open session (get_available_models)' }
      )
    })

    await step('a new session after sign-out no longer offers OpenRouter', async () => {
      const thirdId = await openAnotherWorkspace(app)
      const keys = await engineModelKeys(app, thirdId)
      assert.ok(!keys.some((key) => key.startsWith(`${PROVIDER}/`)), 'engine')
      const pickerKeys = await openComposerPicker(app)
      assert.ok(!pickerKeys.some((key) => key.startsWith(`${PROVIDER}/`)), 'picker')
      await page.keyboard.press('Escape')
    })

    soft.finish()
  },
  { launch: { ...LAUNCH, env: { OPENROUTER_API_KEY: undefined } }, agentDir: {} }
)
