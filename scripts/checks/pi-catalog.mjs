import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleRoot, engineLock } from '../engines/common.mjs'

const packageDirectory = process.env.QA_PI_SOURCE
  ? join(resolve(process.env.QA_PI_SOURCE), 'packages', 'ai')
  : join(bundleRoot, engineLock.pi.packageDir, '..', 'pi-ai')
const catalog = await import(pathToFileURL(join(packageDirectory, 'dist', 'providers', 'all.js')))
const models = await import(pathToFileURL(join(packageDirectory, 'dist', 'models.js')))

const haiku = catalog.getBuiltinModel('anthropic', 'claude-haiku-5-5')
assert.equal(haiku.reasoning, true)
assert.deepEqual(haiku.input, ['text', 'image'])
assert.equal(haiku.contextWindow, 1_000_000)
assert.equal(haiku.maxTokens, 128_000)
assert.deepEqual(haiku.cost, {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
  ]
})
assert.deepEqual(models.getSupportedThinkingLevels(haiku), [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
assert.equal(haiku.compat.forceAdaptiveThinking, true)
assert.equal(haiku.compat.supportsTemperature, false)
assert.equal(haiku.compat.supportsStrictTools, true)
assert.equal(haiku.inputLimits.images.maxPerRequest, 600)
assert.equal(haiku.inputLimits.images.resize.maxWidth, 2000)
assert.equal(haiku.inputLimits.images.resize.maxHeight, 2000)

const sonnet = catalog.getBuiltinModel('anthropic', 'claude-sonnet-5-5')
assert.equal(sonnet.cost.cacheRead, 0.1)
assert.deepEqual(models.getSupportedThinkingLevels(sonnet), [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

const fable = catalog.getBuiltinModel('anthropic', 'claude-fable-5-2')
assert.equal(fable.reasoning, true)
assert.deepEqual(fable.input, ['text', 'image'])
assert.equal(fable.contextWindow, 1_000_000)
assert.equal(fable.maxTokens, 128_000)
assert.deepEqual(fable.cost, { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 })
assert.deepEqual(
  models.getSupportedThinkingLevels(fable),
  models.getSupportedThinkingLevels(catalog.getBuiltinModel('anthropic', 'claude-fable-5-1'))
)
assert.equal(fable.compat.forceAdaptiveThinking, true)

const orcarouter = catalog.getBuiltinModel('orcarouter', 'orca/orcacyber-k3.1-pro')
assert.equal(orcarouter.reasoning, true)
assert.deepEqual(orcarouter.input, ['text', 'image'])
assert.equal(orcarouter.contextWindow, 1_048_576)
assert.equal(orcarouter.maxTokens, 943_718)
assert.deepEqual(orcarouter.cost, { input: 4, output: 20, cacheRead: 0.35, cacheWrite: 4 })
assert.deepEqual(models.getSupportedThinkingLevels(orcarouter), ['off', 'low', 'high', 'max'])
assert.equal(orcarouter.compat.supportsDeveloperRole, false)

const audn = catalog.getBuiltinModel('audn', 'necromicon')
assert.equal(audn.reasoning, true)
assert.deepEqual(audn.input, ['text'])
assert.equal(audn.contextWindow, 1_048_576)
assert.equal(audn.maxTokens, 32_768)
assert.deepEqual(audn.cost, { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3 })
assert.deepEqual(models.getSupportedThinkingLevels(audn), ['low', 'high', 'max'])
assert.equal(audn.compat.supportsDeveloperRole, false)

const silkcompute = {
  'kimi-k3.1-pro-uncensored': [['text', 'image'], 131_072, [5, 15, 0.5]],
  'deepseek-v4.1-flash-1017-uncensored': [['text', 'image'], 131_072, [0.26, 0.9, 0.06]],
  'glm-5.3-uncensored': [['text'], 131_072, [2, 4, 0.3]],
  'glm-5.3-flash-uncensored': [['text', 'image'], 131_072, [0.24, 1, 0.06]],
  'hy4-uncensored': [['text', 'image'], 65_536, [1.6, 3.2, 0.3]]
}
assert.deepEqual(
  catalog.getBuiltinModels('silkcompute').map((model) => model.id),
  Object.keys(silkcompute)
)
for (const [id, expected] of Object.entries(silkcompute)) {
  const [input, maxTokens, [inputPrice, output, cacheRead]] = expected
  const model = catalog.getBuiltinModel('silkcompute', id)
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.input, input)
  assert.equal(model.contextWindow, 1_048_576)
  assert.equal(model.maxTokens, maxTokens)
  assert.deepEqual(model.cost, { input: inputPrice, output, cacheRead, cacheWrite: inputPrice })
  assert.deepEqual(models.getSupportedThinkingLevels(model), ['off', 'low', 'high', 'max'])
  assert.equal(model.thinkingLevelMap.off, 'none')
  assert.equal(model.compat.supportsDeveloperRole, false)
}

console.log(
  '✓ native catalog: Haiku capabilities, pricing and Off thinking; Sonnet cache price; Fable 5.2; OrcaRouter; Audn; SilkCompute'
)
