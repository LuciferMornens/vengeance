import { strict as assert } from 'node:assert'
import {
  normalizeModel,
  normalizeState,
  resolveStateModel,
  sanitizeNativeModels
} from '../../src/main/engine/prime/normalize'
import type { PrimeRecord } from '../../src/main/engine/prime/transport'
import { check } from './harness'

const modelId = 'shared-model'
const provider = 'resident-provider'
const visionModel = {
  id: modelId,
  provider,
  input: ['text', 'image'],
  reasoning: true,
  contextWindow: 96_000,
  maxTokens: 8_192,
  thinkingLevelMap: { high: 'high' },
  baseUrl: 'https://catalog.invalid/private?token=fixture-only',
  headers: { Authorization: 'Bearer fixture-only' },
  compat: { privateSetting: 'fixture-only' }
}

function identityState(): PrimeRecord {
  return { model: { id: modelId, provider, name: 'Resident model' } }
}

await check(
  'Prime resident model resolves the exact provider and ID from its catalog',
  async () => {
    const state = await resolveStateModel(identityState(), async () => ({
      models: [{ ...visionModel, provider: 'other-provider', input: ['text'] }, visionModel]
    }))
    const model = normalizeState(state, {}).model
    assert.ok(model)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.equal(model.reasoning, true)
    assert.equal(model.contextWindow, visionModel.contextWindow)
    assert.equal(model.maxTokens, visionModel.maxTokens)
    assert.deepEqual(model.thinkingLevelMap, visionModel.thinkingLevelMap)
    assert.equal(model.baseUrl, '')
    assert.equal(model.headers, undefined)
    assert.equal(model.compat, undefined)
    assert.ok(!JSON.stringify(state).includes('fixture-only'))
  }
)

await check('Prime custom text model does not inherit another provider’s vision', async () => {
  const state = await resolveStateModel(identityState(), async () => ({
    models: [
      { ...visionModel, provider: 'other-provider' },
      { ...visionModel, input: ['text'], reasoning: false }
    ]
  }))
  const model = normalizeState(state, {}).model
  assert.ok(model)
  assert.deepEqual(model.input, ['text'])
  assert.equal(model.reasoning, false)
})

await check('Prime full native descriptors do not query or borrow catalog metadata', async () => {
  let catalogReads = 0
  const state = sanitizeNativeModels({
    model: { ...visionModel, input: ['text'], contextWindow: 32_000 }
  })
  const resolved = await resolveStateModel(state, async () => {
    catalogReads += 1
    return { models: [visionModel] }
  })
  const model = normalizeState(resolved, {}).model
  assert.ok(model)
  assert.equal(catalogReads, 0)
  assert.deepEqual(model.input, ['text'])
  assert.equal(model.contextWindow, 32_000)
  assert.equal(model.headers, undefined)
  assert.equal(model.compat, undefined)
})

await check('Prime unresolved modalities stay unknown through repeated normalization', async () => {
  const catalogs = [
    async (): Promise<PrimeRecord> => {
      throw new Error('Catalog not supported by this resident')
    },
    async () => ({ models: [{ ...visionModel, provider: 'other-provider' }] })
  ]
  for (const readCatalog of catalogs) {
    const state = await resolveStateModel(identityState(), readCatalog)
    const normalized = normalizeState(state, {})
    assert.deepEqual(normalized.model?.input, [])
    const repeated = normalizeState({ model: normalizeModel(normalized.model) }, {})
    assert.deepEqual(repeated.model?.input, [])
    assert.ok(!JSON.stringify(state).includes('fixture-only'))
  }
})
