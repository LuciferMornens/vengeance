// Settings → Providers against the engine's own provider list (ModelRuntime.getProviders() from
// the installed engine, read in this process against the same temp agent dir):
//   - every provider has a row, a unique name and the right auth methods (API key / OAuth);
//   - no dead buttons: every "Add key" / "API key" / "Sign in" starts the engine's flow (network
//     stubbed in the main process; every flow is cancelled);
//   - a models.json provider without a key appears, takes a key and works end to end;
//   - extension providers (pi.registerProvider) show up where the engine shows them.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FAKE_API_KEY } from '../lib/agent-dir.mjs'
import { API, inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { enginePackageDir } from '../settings/engine-sdk.mjs'
import {
  LAUNCH,
  engineModelKeys,
  openAnotherWorkspace,
  openComposerPicker,
  openSettings,
  providerRow,
  readTempAuth,
  sendVisible,
  settleVisible,
  softSteps,
  stubMainNetwork,
  waitUntil
} from './helpers.mjs'

const ENGINE_SDK = pathToFileURL(join(enginePackageDir(), 'dist', 'index.js')).href
const LOCAL = 'local-llm'
/** The fixture extension's subscription sign-in (not in the extension-free engine ground truth). */
const EXTENSION_SUBSCRIPTION = 'qa-ext-oauth'
const LOCAL_KEY = 'local-key-000000000000000000loc4'

/** Extension with two providers: one keyed (works at once), one OAuth-only (needs /login). */
function extensionSource(server) {
  const model = (id, name) => ({
    id,
    name,
    reasoning: false,
    input: ['text'],
    contextWindow: 100000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  })
  return `export default function (pi) {
  pi.registerProvider('qa-ext', {
    name: 'QA Extension',
    baseUrl: ${JSON.stringify(server.anthropicBaseUrl)},
    api: 'anthropic-messages',
    apiKey: ${JSON.stringify(FAKE_API_KEY)},
    models: [${JSON.stringify(model('qa-ext-model', 'QA Extension Model'))}]
  })
  pi.registerProvider('qa-ext-oauth', {
    name: 'QA Extension OAuth',
    baseUrl: ${JSON.stringify(server.anthropicBaseUrl)},
    api: 'anthropic-messages',
    oauth: {
      name: 'QA Extension OAuth (subscription)',
      isSubscription: true,
      async login() { throw new Error('QA: never completes') },
      async refreshToken(credentials) { return credentials },
      getApiKey(credentials) { return credentials.access }
    },
    models: [${JSON.stringify(model('qa-ext-oauth-model', 'QA Extension OAuth Model'))}]
  })
}
`
}

await runSuite(
  'auth-providers-list',
  async ({ server, agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    // Every https request of a login flow fails fast; no browser opens.
    const network = await stubMainNetwork(app, [
      { prefix: 'https://', status: 503, json: { error: 'qa: network disabled' } }
    ])
    let engineProviders
    let rowIds

    await step('fixtures: an unkeyed models.json provider and a provider extension', async () => {
      const models = await agentDir.readJson('models.json')
      models.providers[LOCAL] = {
        baseUrl: server.anthropicBaseUrl,
        api: API.anthropic,
        models: [{ id: 'local-coder', name: 'Local Coder', input: ['text'] }]
      }
      await agentDir.writeText('models.json', models)
      await agentDir.writeText('extensions/qa-ext-provider.js', extensionSource(server))
    })

    await step(
      'engine ground truth: ModelRuntime.getProviders() on the temp agent dir',
      async () => {
        process.env.PI_OFFLINE = '1'
        const sdk = await import(ENGINE_SDK)
        const runtime = await sdk.ModelRuntime.create({
          authPath: join(agentDir.dir, 'auth.json'),
          modelsPath: join(agentDir.dir, 'models.json'),
          allowModelNetwork: false
        })
        engineProviders = runtime.getProviders().map((p) => ({
          id: p.id,
          name: p.name,
          oauth: p.auth.oauth
            ? {
                name: p.auth.oauth.name,
                label: p.auth.oauth.loginLabel,
                sub: !!p.auth.oauth.isSubscription
              }
            : null,
          apiKey: !!p.auth.apiKey,
          configured: runtime.getProviderAuthStatus(p.id).configured
        }))
        assert.ok(engineProviders.length > 30)
      }
    )

    await step('open a workspace (loads the extension) and Settings → Providers', async () => {
      await app.openWorkspace()
      await openSettings(app, 'providers', 'Providers & accounts')
      await page.getByRole('button', { name: /^Show all \d+ providers$/ }).click()
      await page.getByRole('button', { name: 'Show fewer' }).waitFor()
      rowIds = await page
        .locator('[id^="setting-provider."]')
        .evaluateAll((rows) => rows.map((row) => row.id.replace('setting-provider.', '')))
      await app.screenshot('providers-01-all', { settleMs: 600 })
    })

    await step('every engine provider has exactly one row', async () => {
      const expected = engineProviders.map((p) => p.id).sort()
      assert.deepEqual([...rowIds].filter((id) => !id.startsWith('qa-ext')).sort(), expected)
    })

    await step('each row offers the auth methods the engine supports', async () => {
      const problems = []
      for (const provider of engineProviders) {
        const row = providerRow(page, provider.id)
        const has = async (name) =>
          (await row.getByRole('button', { name, exact: true }).count()) > 0
        if (provider.configured) {
          if (!(await has('Test'))) problems.push(`${provider.id}: connected row without Test`)
          continue
        }
        if (provider.oauth && !(await has(provider.oauth.label ?? 'Sign in'))) {
          problems.push(`${provider.id}: no "${provider.oauth.label ?? 'Sign in'}"`)
        }
        if (provider.apiKey && !(await has(provider.oauth ? 'API key' : 'Add key'))) {
          problems.push(`${provider.id}: no API-key button`)
        }
        if (!provider.apiKey && ((await has('API key')) || (await has('Add key')))) {
          problems.push(`${provider.id}: offers an API key the engine does not take`)
        }
      }
      assert.deepEqual(problems, [])
    })

    // auth-9: "openai" and "openai-codex" are titled with the engine names ("OpenAI" and "OpenAI
    // Codex (legacy)"), not the OAuth names' shared prefix "OpenAI".
    await soft.step('provider names on the page are unique', async () => {
      const titles = await page
        .locator('[id^="setting-provider."]')
        .evaluateAll((rows) =>
          rows.map(
            (row) => row.querySelector('span.gap-3 > span:last-child')?.textContent?.trim() ?? ''
          )
        )
      const seen = new Map()
      for (const title of titles) seen.set(title, (seen.get(title) ?? 0) + 1)
      const duplicates = [...seen].filter(([, count]) => count > 1).map(([title]) => title)
      assert.deepEqual(duplicates, [])
    })

    // auth-10: OAuth providers that are not subscriptions (OpenRouter, Radius) are not listed
    // under "Subscriptions — Sign in with an existing plan".
    await soft.step('the Subscriptions group only lists subscription sign-ins', async () => {
      const group = page.locator('section', {
        has: page.getByRole('heading', { name: 'Subscriptions' })
      })
      const ids = await group
        .locator('[id^="setting-provider."]')
        .evaluateAll((rows) => rows.map((row) => row.id.replace('setting-provider.', '')))
      const notSubscriptions = ids.filter(
        (id) =>
          id !== EXTENSION_SUBSCRIPTION && !engineProviders.find((p) => p.id === id)?.oauth?.sub
      )
      assert.deepEqual(notSubscriptions, [])
    })

    await soft.step(
      'no dead API-key buttons: each opens the engine prompt (then cancel)',
      async () => {
        const dead = []
        for (const provider of engineProviders.filter((p) => p.apiKey && !p.configured)) {
          const button = providerRow(page, provider.id).getByRole('button', {
            name: provider.oauth ? 'API key' : 'Add key',
            exact: true
          })
          await button.scrollIntoViewIfNeeded()
          await button.click()
          const dialog = page.getByRole('dialog', { name: / API key$/ })
          const ready = await dialog
            .locator('input, button:not([aria-label="Close"]):not([aria-label="Show key"])')
            .first()
            .waitFor({ timeout: 5_000 })
            .then(
              () => true,
              () => false
            )
          if (!ready) dead.push(provider.id)
          await page.keyboard.press('Escape')
          await dialog.waitFor({ state: 'detached' })
        }
        assert.deepEqual(dead, [])
        const auth = await readTempAuth(agentDir)
        assert.ok(!auth || Object.keys(auth).length === 0, 'nothing stored')
      }
    )

    await soft.step('no dead Sign-in buttons: each OAuth flow responds (then cancel)', async () => {
      const outcomes = {}
      for (const provider of engineProviders.filter((p) => p.oauth && !p.configured)) {
        const label = provider.oauth.label ?? 'Sign in'
        const button = providerRow(page, provider.id).getByRole('button', {
          name: label,
          exact: true
        })
        await button.scrollIntoViewIfNeeded()
        await button.click()
        const dialog = page.getByRole('dialog', { name: /^Sign in to / })
        await dialog.waitFor()
        const responded = await waitUntil(
          async () => {
            // What the flow put in the dialog body: a notice, a prompt, or an error.
            if (await dialog.getByText('Sign-in failed').count()) return 'error'
            if (await dialog.getByText('Enter this code at').count()) return 'device code'
            if (await dialog.locator('code').count()) return 'browser URL'
            if (await dialog.locator('input').count()) return 'input prompt'
            const choices = dialog.locator('button.flex-col')
            if (await choices.count()) {
              const labels = await choices.locator('span.font-medium').allInnerTexts()
              return 'select (' + labels.join(' / ') + ')'
            }
            return null
          },
          { timeoutMs: 10_000, label: `${provider.id} sign-in to respond` }
        ).catch(() => null)
        outcomes[provider.id] = responded ?? 'NO RESPONSE'
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
      }
      console.log(`      sign-in responses: ${JSON.stringify(outcomes)}`)
      console.log(
        `      stubbed fetches: ${(await network.fetched()).length}, browser opens: ${(await network.opened()).length}`
      )
      const dead = Object.entries(outcomes).filter(([, text]) => text === 'NO RESPONSE')
      assert.deepEqual(dead, [])
      // Every https request is stubbed to fail, so a device code can only come from the real network: the
      // flow ran somewhere the main-process stub does not reach.
      const reachedNetwork = Object.entries(outcomes).filter(([, text]) => text === 'device code')
      assert.deepEqual(reachedNetwork, [], 'a sign-in flow reached the real network')
      // The flows that fail here fail on the stubbed 503; fewer stubbed requests than failures means some
      // flow's request went around the stub.
      const failed = Object.values(outcomes).filter((text) => text === 'error').length
      assert.ok((await network.fetched()).length >= failed, 'a failing sign-in bypassed the stub')
      const auth = await readTempAuth(agentDir)
      assert.ok(!auth || Object.keys(auth).length === 0, 'nothing stored')
    })

    await step(
      'models.json provider without a key: listed with Add key, key works end to end',
      async () => {
        const row = providerRow(page, LOCAL)
        await row.getByText('Local LLM', { exact: true }).waitFor()
        await row.getByRole('button', { name: 'Add key' }).click()
        const dialog = page.getByRole('dialog', { name: 'Local LLM API key' })
        await dialog.locator('input').first().fill(LOCAL_KEY)
        await dialog.getByRole('button', { name: 'Save key' }).click()
        await dialog.getByText('Connected').waitFor()
        assert.deepEqual((await readTempAuth(agentDir))[LOCAL], { type: 'api_key', key: LOCAL_KEY })
        await dialog.waitFor({ state: 'detached' })
        await app.test('closeSettings')
        const agentId = await openAnotherWorkspace(app, { model: `${LOCAL}/local-coder` })
        assert.ok((await engineModelKeys(app, agentId)).includes(`${LOCAL}/local-coder`))
        const from = server.requests.length
        server.queue(turn.text('ok'))
        await sendVisible(app, 'Reply with ok')
        await settleVisible(app)
        const request = await server.waitForRequest(undefined, { from })
        assert.equal(inspectRequest(request).model, 'local-coder')
        assert.equal(request.headers['x-api-key'], LOCAL_KEY)
      }
    )

    await step(
      'extension provider: its models are in the engine list and the composer picker',
      async () => {
        const keys = await engineModelKeys(app)
        assert.ok(keys.includes('qa-ext/qa-ext-model'), 'engine lists the keyed extension model')
        const pickerKeys = await openComposerPicker(app)
        assert.ok(pickerKeys.includes('qa-ext/qa-ext-model'))
        await page.keyboard.press('Escape')
      }
    )

    await step(
      'extension provider: Settings → Models pickers label its model "Extension"',
      async () => {
        await openSettings(app, 'models', 'Models')
        await page
          .locator('[id="setting-defaultModel"]')
          .getByRole('button', { name: /QA Reasoning/ })
          .click()
        await page.getByPlaceholder('Search models…').filter({ visible: true }).fill('QA Extension')
        const option = page.getByRole('option', { name: /QA Extension Model/ })
        await option.getByText('Extension', { exact: true }).waitFor()
        await app.screenshot('providers-02-extension-model')
        await page.keyboard.press('Escape')
      }
    )

    // auth-5: providers registered by extensions are listed on Settings → Providers, and an
    // extension's OAuth provider ("appears in /login" per custom-provider.md) can be signed in to.
    await soft.step(
      'extension providers are listed on the Providers page (keyed + OAuth)',
      async () => {
        await openSettings(app, 'providers', 'Providers & accounts')
        await providerRow(page, 'qa-ext').waitFor({ timeout: 5_000 })
        await providerRow(page, EXTENSION_SUBSCRIPTION).waitFor({ timeout: 5_000 })
        await app.screenshot('providers-03-extension-providers')
      }
    )

    await soft.step('extension OAuth provider: Sign in runs the extension’s login', async () => {
      const row = providerRow(page, EXTENSION_SUBSCRIPTION)
      await row.getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to QA Extension OAuth' })
      // The fixture's login() throws; its message proves the engine ran the extension's flow.
      await dialog.getByText('QA: never completes').waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
    })

    soft.finish()
  },
  { launch: { ...LAUNCH, env: { OPENROUTER_API_KEY: undefined } } }
)
