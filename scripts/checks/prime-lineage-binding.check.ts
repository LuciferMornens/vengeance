import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { SessionIdentity } from '../../src/shared/api/sessions'
import type { PrimeSessionLineage } from '../../src/main/engine/prime/session-lineage'
import { normalizeState } from '../../src/main/engine/prime/normalize'
import { check } from './harness'

await check('Trusted saved lineage binds reopened child state to its exact file only', async () => {
  const require = createRequire(resolve('package.json'))
  const esbuild: typeof import('esbuild') = require('esbuild')
  const bundled = await esbuild.build({
    entryPoints: [resolve('src/main/engine/prime/session-lineage.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    alias: { '@shared': resolve('src/shared') },
    plugins: [
      {
        name: 'saved-identity-boundary',
        setup(bundler) {
          bundler.onResolve({ filter: /^\.\/sessions$/ }, () => ({
            path: 'saved-identity',
            namespace: 'fixture'
          }))
          bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const primeSessionIdentity = async () => {
              globalThis.recordIdentityRead();
              return globalThis.savedIdentity;
            };`
          }))
        }
      }
    ]
  })
  const parent = resolve('fixture-parent.jsonl')
  const child = resolve('fixture-child.jsonl')
  const fork = resolve('fixture-fork.jsonl')
  const identity: SessionIdentity = {
    cwd: process.cwd(),
    engine: 'prime',
    lineage: { parentSessionPath: parent, childId: 'sub-saved', depth: 1, runtimeKind: 'subagent' }
  }
  const exported = { exports: {} }
  let identityReads = 0
  const context = {
    module: exported,
    exports: exported.exports,
    require,
    process,
    savedIdentity: identity,
    recordIdentityRead: () => identityReads++
  }
  runInNewContext(bundled.outputFiles[0]!.text, context)
  const { PrimeSessionLineage: Binding } = exported.exports as {
    PrimeSessionLineage: typeof PrimeSessionLineage
  }
  const binding = new Binding()
  await binding.load(parent, 0)
  assert.equal(identityReads, 0, 'native depth-zero roots do not inspect saved topology')
  await binding.load(child)
  assert.equal(identityReads, 1, 'unknown native depth still verifies saved lineage')
  const native = normalizeState({ sessionFile: child, runtimeKind: 'top-level', rlmDepth: 1 }, {})
  const reopened = binding.apply(native)
  assert.equal(reopened.lineage?.childId, 'sub-saved')
  assert.equal(reopened.lineage?.runtimeKind, 'subagent')
  assert.equal(reopened.lineage?.parentSessionPath, parent)
  assert.equal(binding.apply({ ...native, sessionFile: fork }).lineage?.childId, undefined)
  await binding.load(child, 1)
  assert.equal(identityReads, 1, 'repeated child snapshots reuse their verified file binding')
  await binding.load(child, 0)
  assert.equal(binding.apply(native).lineage?.childId, undefined)
  await binding.load(child)
  assert.equal(identityReads, 2, 'a later legacy snapshot must verify after a depth-zero binding')
  context.savedIdentity = { cwd: process.cwd(), engine: 'prime', lineage: { depth: 1 } }
  await binding.load(fork)
  const forkState = binding.apply({ ...native, sessionFile: fork })
  assert.equal(forkState.lineage?.childId, undefined)
  assert.equal(forkState.lineage?.depth, 1)
  await binding.load(undefined)
  assert.equal(binding.apply(native), native)
})
