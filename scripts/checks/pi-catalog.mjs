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

console.log(
  '✓ native Claude catalog: Haiku capabilities, pricing and Off thinking; Sonnet cache price'
)
