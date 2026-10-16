// Credential sources and their precedence (models.md "Authenticate": runtime --api-key, then a
// stored auth.json credential, then models.json apiKey, then environment variables). Each case
// checks what Settings → Providers shows against the credential the engine really sends to the
// fake LLM. auth.json edits made "outside" the app stand in for a terminal `pi /login`.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FAKE_API_KEY, FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { enginePackageDir } from '../settings/engine-sdk.mjs'
import {
  LAUNCH,
  openAnotherWorkspace,
  openSettings,
  providerRow,
  routeProviderToFake,
  sendVisible,
  settleVisible,
  softSteps,
  waitUntil
} from './helpers.mjs'

const PROVIDER = 'openrouter'
const ENV_KEY = 'qa-env-value'
const STORED_KEY = 'qa-stored-value'
const STORED_QA_KEY = 'qa-stored-key-0000000000000000wxyz'
const PI_AI_ENV_KEYS = pathToFileURL(
  join(enginePackageDir(), '..', 'pi-ai', 'dist', 'env-api-keys.js')
).href

await runSuite(
  'auth-credential-precedence',
  async ({ server, agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    let modelId

    /** A new session on `provider/model`; returns the Authorization / x-api-key it sends. */
    async function credentialSent(provider, model) {
      await openAnotherWorkspace(app, { model: `${provider}/${model}` })
      const from = server.requests.length
      server.queue(turn.text('ok'))
      await sendVisible(app, 'Reply with ok')
      await settleVisible(app)
      const request = await server.waitForRequest(undefined, { from })
      return request.headers.authorization ?? request.headers['x-api-key']
    }

    await step('route openrouter to the fake LLM; pick an OpenAI-style model', async () => {
      await routeProviderToFake(agentDir, server, PROVIDER)
      const catalog = await waitUntil(
        async () => {
          const next = await app.invoke('settings:catalog')
          return next.providers.find((p) => p.id === PROVIDER)?.status.configured && next
        },
        { label: 'openrouter configured from the environment' }
      )
      modelId = catalog.models.find(
        (m) => m.provider === PROVIDER && m.api === 'openai-completions' && !m.reasoning
      ).id
    })

    await step('environment key: Connected row names the variable', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      const row = providerRow(page, PROVIDER)
      await row.getByText('OPENROUTER_API_KEY', { exact: true }).waitFor()
      await row.getByText('from the environment').waitFor()
      assert.equal(await row.getByRole('button', { name: 'Remove key' }).count(), 0)
      await app.screenshot('precedence-01-env')
    })

    await soft.step('environment key: Test runs the engine readiness check → Ready', async () => {
      const row = providerRow(page, PROVIDER)
      await row.getByRole('button', { name: 'Test' }).click()
      await row.getByText('Ready', { exact: true }).waitFor({ timeout: 30_000 })
    })

    await step('environment key: the engine sends it', async () => {
      await app.test('closeSettings')
      assert.equal(await credentialSent(PROVIDER, modelId), `Bearer ${ENV_KEY}`)
    })

    // auth-2: with an env key, the provider row still offers storing a key (and OAuth sign-in),
    // since a stored credential takes precedence (models.md) and the engine's /login offers every
    // provider.
    await soft.step(
      'environment key: the row still offers storing a key / signing in',
      async () => {
        await openSettings(app, 'providers', 'Providers & accounts')
        const row = providerRow(page, PROVIDER)
        const offers = row.getByRole('button', { name: /API key|Add key|Replace key|Sign in/ })
        assert.ok((await offers.count()) > 0, 'a sign-in or add-key control on the env-only row')
      }
    )

    await step('stored key beats the environment: UI and request agree', async () => {
      await agentDir.writeText('auth.json', { [PROVIDER]: { type: 'api_key', key: STORED_KEY } })
      const row = providerRow(page, PROVIDER)
      await row
        .getByText(`API key ${STORED_KEY.slice(0, 4)}…${STORED_KEY.slice(-4)}`)
        .waitFor({ timeout: 15_000 })
      assert.equal(await row.getByText('from the environment').count(), 0)
      await app.screenshot('precedence-02-stored-over-env')
      await app.test('closeSettings')
      assert.equal(await credentialSent(PROVIDER, modelId), `Bearer ${STORED_KEY}`)
    })

    await step(
      'removing the stored key falls back to the environment (logout keeps env)',
      async () => {
        await openSettings(app, 'providers', 'Providers & accounts')
        const row = providerRow(page, PROVIDER)
        await row.getByRole('button', { name: 'Remove key' }).click()
        await row.getByText('OPENROUTER_API_KEY', { exact: true }).waitFor()
        const auth = await agentDir.readJson('auth.json')
        assert.ok(!(PROVIDER in auth))
        await app.test('closeSettings')
        assert.equal(await credentialSent(PROVIDER, modelId), `Bearer ${ENV_KEY}`)
      }
    )

    await step('stored key beats models.json apiKey (custom provider)', async () => {
      await openSettings(app, 'providers', 'Providers & accounts')
      const row = providerRow(page, FAKE_PROVIDER)
      await row.getByText('Custom models', { exact: true }).waitFor()
      await app.test('closeSettings')
      assert.equal(await credentialSent(FAKE_PROVIDER, FAKE_MODELS.small), FAKE_API_KEY)

      await agentDir.writeText('auth.json', {
        [FAKE_PROVIDER]: { type: 'api_key', key: STORED_QA_KEY }
      })
      await openSettings(app, 'providers', 'Providers & accounts')
      await row
        .getByText(`API key ${STORED_QA_KEY.slice(0, 4)}…${STORED_QA_KEY.slice(-4)}`)
        .waitFor({ timeout: 15_000 })
      await app.screenshot('precedence-03-stored-over-models-json')
      await app.test('closeSettings')
      assert.equal(await credentialSent(FAKE_PROVIDER, FAKE_MODELS.small), STORED_QA_KEY)
    })

    await step('a "!command" key shows as a key command and the engine runs it', async () => {
      await agentDir.writeText('auth.json', {
        [PROVIDER]: { type: 'api_key', key: '!echo cmd-key-from-command' }
      })
      await openSettings(app, 'providers', 'Providers & accounts')
      const row = providerRow(page, PROVIDER)
      await row.getByText('Key command', { exact: true }).waitFor({ timeout: 15_000 })
      assert.equal(await row.getByText('echo cmd-key').count(), 0, 'the command is not displayed')
      await app.test('closeSettings')
      assert.equal(await credentialSent(PROVIDER, modelId), 'Bearer cmd-key-from-command')
    })

    // auth-6: the env-var list comes from the engine's own list (pi-ai env-api-keys.js), e.g.
    // ANTHROPIC_AUTH_TOKEN, instead of a hard-coded table.
    await soft.step('every engine env variable is listed for its provider', async () => {
      const { findEnvKeys } = await import(PI_AI_ENV_KEYS)
      const everyVariableSet = new Proxy({}, { get: () => 'set', has: () => true })
      const catalog = await app.invoke('settings:catalog')
      const gaps = []
      for (const provider of catalog.providers) {
        const engineVars = findEnvKeys(provider.id, everyVariableSet) ?? []
        const shown = new Set(provider.envVars)
        for (const name of engineVars) if (!shown.has(name)) gaps.push(`${provider.id}: ${name}`)
      }
      assert.deepEqual(gaps, [])
    })

    soft.finish()
  },
  { launch: { ...LAUNCH, env: { OPENROUTER_API_KEY: ENV_KEY } } }
)
