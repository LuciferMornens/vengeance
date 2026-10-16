// Auth: a ChatGPT sign-in (OAuth on the built-in `openai` provider) sees only the models its account offers.
// Main reads `GET /v1/models` with the Engine's credential (here a fake OAuth token, the provider's baseUrl pointed at
// the fake LLM) and hides every other `openai` model from the Engine's model list, the composer picker, the model
// cycle and the Settings catalog. An API key shows the whole catalog again.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAKE_API_KEY, FAKE_PROVIDER, defaultFakeModels } from '../lib/agent-dir.mjs'
import { API } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { engineModelKeys, openComposerPicker, sorted, waitUntil } from './helpers.mjs'

const OFFERED = ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-terra', 'gpt-qa-not-in-catalog']
const OFFERED_KEYS = ['openai/gpt-5.6-terra', 'openai/gpt-6-luna', 'openai/gpt-6-sol']
const ACCESS = 'qa-chatgpt-access'

const oauth = {
  type: 'oauth',
  access: ACCESS,
  refresh: 'qa-refresh',
  expires: Date.now() + 10 * 365 * 86_400_000,
  clientId: 'qa',
  scopes: ['openid']
}
const openaiKeys = (keys) => sorted(keys.filter((key) => key.startsWith('openai/')))
const modelListRequests = (server) =>
  server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/models')

/** The cache main writes; null while missing or unreadable (the assertions then fail). */
function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

await runSuite('auth-account-models', async ({ server, agentDir, app, step }) => {
  // gpt-5.5 is in the catalog but hidden for the account (ChatGPT apps do not offer it).
  server.setAccountModels(OFFERED, { hidden: ['gpt-5.5'] })
  const cacheFile = join(app.userData, 'account-models.json')

  await step(
    'a ChatGPT sign-in: main reads the account models with the Engine credential',
    async () => {
      await agentDir.writeText('models.json', {
        providers: {
          [FAKE_PROVIDER]: {
            name: 'QA Fake',
            baseUrl: server.anthropicBaseUrl,
            api: API.anthropic,
            apiKey: FAKE_API_KEY,
            models: defaultFakeModels(server)
          },
          openai: { baseUrl: server.openaiBaseUrl }
        }
      })
      await agentDir.writeText('auth.json', { openai: oauth })
      const [request] = await waitUntil(
        () => modelListRequests(server).length > 0 && modelListRequests(server),
        { label: 'GET /v1/models' }
      )
      assert.equal(request.headers.authorization, `Bearer ${ACCESS}`)
      const cached = await waitUntil(() => readCache(cacheFile), { label: 'account-models.json' })
      assert.deepEqual(cached.ids, OFFERED, 'ids only, in the order OpenAI listed them')
      assert.ok(!JSON.stringify(cached).includes(ACCESS), 'no credential in the cache')
    }
  )

  await step(
    'the Engine model list and the composer picker hold only the offered OpenAI models',
    async () => {
      await app.openWorkspace()
      const keys = await engineModelKeys(app)
      assert.deepEqual(openaiKeys(keys), OFFERED_KEYS)
      assert.ok(
        keys.some((key) => key.startsWith(`${FAKE_PROVIDER}/`)),
        'other providers are untouched'
      )
      const picker = await openComposerPicker(app)
      assert.deepEqual(openaiKeys(picker), OFFERED_KEYS)
      await app.screenshot('account-models-picker')
      await app.page.keyboard.press('Escape')
    }
  )

  await step('the forward model cycle steps over hidden models', async () => {
    const start = (await app.agentState()).model
    const seen = []
    for (let i = 0; i < 12; i++) {
      const result = await app.rpc({ type: 'cycle_model' })
      seen.push(`${result.model.provider}/${result.model.id}`)
    }
    const openai = seen.filter((key) => key.startsWith('openai/'))
    assert.ok(openai.length > 0, `the cycle reached OpenAI models (${seen.join(', ')})`)
    assert.deepEqual(
      openai.filter((key) => !OFFERED_KEYS.includes(key)),
      [],
      'no hidden model in the cycle'
    )
    await app.rpc({ type: 'set_model', provider: start.provider, modelId: start.id })
  })

  await step('Settings catalog: only the offered OpenAI models', async () => {
    const catalog = await app.invoke('settings:catalog')
    assert.deepEqual(openaiKeys(catalog.models.map((m) => `${m.provider}/${m.id}`)), OFFERED_KEYS)
    assert.equal(catalog.providers.find((p) => p.id === 'openai')?.modelCount, OFFERED_KEYS.length)
  })

  await step('an API key instead: the full OpenAI catalog, the cached list cleared', async () => {
    await agentDir.writeText('auth.json', { openai: { type: 'api_key', key: 'sk-qa-fake-key' } })
    await waitUntil(
      async () =>
        (await app.invoke('settings:catalog')).models.filter((m) => m.provider === 'openai')
          .length > OFFERED_KEYS.length,
      {
        label: 'the whole openai catalog'
      }
    )
    const cleared = readCache(cacheFile)
    assert.ok(cleared && !cleared.ids, 'cache cleared')
  })
})
