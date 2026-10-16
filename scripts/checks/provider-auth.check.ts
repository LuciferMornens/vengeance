import { strict as assert } from 'node:assert'
import type { JsonObject } from '@shared/api/settings'
import { maskModelsSecrets, restoreModelsSecrets, unresolvedSecretProviders } from '../../src/main/features/settings/models-secrets'
import { SECRET_MASK } from '../../src/main/features/settings/secrets'
import { signInPlan } from '../../src/renderer/features/settings/provider-name'
import { check } from './harness'

const MODEL_HEADER = 'model-header-secret-0001'
const OVERRIDE_HEADER = 'override-header-secret-02'

function modelsJson(modelHeader: string, overrideHeader: string) {
  return {
    providers: {
      local: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'local-api-key-000000000123',
        models: [{ id: 'coder', headers: { 'X-Model': modelHeader, 'X-Ref': '$MODEL_TOKEN' } }],
        modelOverrides: { coder: { headers: { 'X-Override': overrideHeader } } }
      }
    }
  }
}

type ModelsFixture = ReturnType<typeof modelsJson>

/** The fixture's shape, for reading results of the JsonObject-typed functions. */
function asFixture(data: JsonObject): ModelsFixture {
  // SAFETY: masking and restoring copy the fixture and only replace string values, so its shape is kept.
  return data as unknown as ModelsFixture
}

await check('models.json secrets (settings-9): custom model headers are masked like provider headers', () => {
  const masked = maskModelsSecrets(modelsJson(MODEL_HEADER, OVERRIDE_HEADER))
  const local = asFixture(masked).providers.local
  assert.ok(String(local.apiKey).startsWith(SECRET_MASK))
  assert.ok(String(local.models[0]!.headers['X-Model']).startsWith(SECRET_MASK))
  assert.equal(local.models[0]!.headers['X-Ref'], '$MODEL_TOKEN', 'variable references stay readable')
  assert.ok(String(local.modelOverrides.coder.headers['X-Override']).startsWith(SECRET_MASK))
  assert.ok(!JSON.stringify(masked).includes(MODEL_HEADER))
})

await check('models.json secrets (settings-9): unchanged masks are restored on save', () => {
  const onDisk = modelsJson(MODEL_HEADER, OVERRIDE_HEADER)
  const restored = restoreModelsSecrets(maskModelsSecrets(onDisk), onDisk)
  assert.deepEqual(restored, onDisk)
  assert.deepEqual(unresolvedSecretProviders(restored), [])
})

await check('models.json secrets: a mask whose model id changed stays unresolved', () => {
  const onDisk = modelsJson(MODEL_HEADER, OVERRIDE_HEADER)
  const edited = maskModelsSecrets(onDisk)
  asFixture(edited).providers.local.models[0]!.id = 'renamed'
  const restored = restoreModelsSecrets(edited, onDisk)
  assert.ok(String(asFixture(restored).providers.local.models[0]!.headers['X-Model']).startsWith(SECRET_MASK))
  assert.deepEqual(unresolvedSecretProviders(restored), ['local'])
})

await check('signInPlan (auth-9): the plan comes from the OAuth name, titles stay engine names', () => {
  assert.equal(signInPlan({ oauth: { name: 'OpenAI (ChatGPT Plus/Pro)', subscription: true } }), 'ChatGPT Plus/Pro')
  assert.equal(signInPlan({ oauth: { name: 'OpenAI (ChatGPT subscription)', subscription: true } }), 'ChatGPT')
  assert.equal(signInPlan({ oauth: { name: 'Kimi Code (subscription)', subscription: true } }), null)
  assert.equal(signInPlan({ oauth: { name: 'OpenRouter OAuth', subscription: false } }), null)
  assert.equal(signInPlan({}), null)
})
