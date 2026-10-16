import { strict as assert } from 'node:assert'
import type { Model } from '../../src/shared/engine-types'
import { previousInCycle, resolveModelScope } from '../../src/renderer/features/composer/model-scope'
import { check } from './harness'

function model(provider: string, id: string, name = id): Model {
  return {
    provider,
    id,
    name,
    api: 'x',
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100
  } as Model
}

const MODELS = [
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5'),
  model('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 (dated)'),
  model('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5'),
  model('openai', 'gpt-5', 'GPT-5'),
  model('openai', 'gpt-5-mini', 'GPT-5 mini')
]

function keys(scope: Array<{ model: Model }>): string[] {
  return scope.map((s) => `${s.model.provider}/${s.model.id}`)
}

await check('resolveModelScope: exact ids, globs within a segment, partial names prefer the alias, :thinking suffixes', () => {
  const scope = resolveModelScope(['openai/gpt-5:high', 'anthropic/*haiku*', 'sonnet', 'gpt-5'], MODELS)
  assert.deepEqual(keys(scope), ['openai/gpt-5', 'anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-4-5'])
  assert.equal(scope[0]?.thinkingLevel, 'high')
  assert.deepEqual(keys(resolveModelScope(['*/gpt-*'], MODELS)), ['openai/gpt-5', 'openai/gpt-5-mini'])
  assert.deepEqual(keys(resolveModelScope(['nothing-matches'], MODELS)), [])
})

await check('previousInCycle: steps back through every available model, wrapping around', () => {
  assert.equal(previousInCycle(MODELS[1], [], MODELS)?.model.id, 'claude-sonnet-4-5')
  const wrapped = previousInCycle(MODELS[0], [], MODELS)
  assert.equal(wrapped?.model.id, 'gpt-5-mini')
  assert.equal(wrapped?.isScoped, false)
})

await check('previousInCycle: stays within the scope; a one-model scope has nothing to cycle to', () => {
  const step = previousInCycle(MODELS[3], ['anthropic/claude-haiku-4-5', 'openai/gpt-5:low'], MODELS)
  assert.equal(step?.model.id, 'claude-haiku-4-5')
  assert.equal(step?.isScoped, true)
  assert.equal(previousInCycle(MODELS[2], ['openai/gpt-5:low', 'anthropic/claude-haiku-4-5'], MODELS)?.thinkingLevel, 'low')
  assert.equal(previousInCycle(MODELS[0], ['gpt-5-mini'], MODELS), undefined)
})
