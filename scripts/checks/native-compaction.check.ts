import { strict as assert } from 'node:assert'
import {
  nativeItemForBranch,
  NATIVE_COMPACTION_ENTRY,
  NATIVE_COMPACTION_FORMAT,
  supportsNativeCompaction,
  withNativeItem,
  type BranchEntry
} from '../../resources/bridge/openai-native-compaction-core'
import { NATIVE_COMPACTION_ENTRY as SHARED_ENTRY } from '../../src/shared/api/engine'
import type { FlatTreeNode } from '../../src/shared/engine-types'
import { buildBranchTree, type BranchNode } from '../../src/renderer/features/inspector/tree-model'
import { check } from './harness'

const SUMMARY =
  'The conversation history before this point was compacted into the following summary:' +
  '\n\n<summary>\nold\n</summary>'
const item = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'enc-1' }
const selectedModel = (id: string) => ({
  id,
  provider: 'openai',
  api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1'
})
const native = (compactionId: string, model: string, encrypted = 'enc-1'): BranchEntry => ({
  type: 'custom',
  id: `n-${compactionId}-${model}`,
  customType: NATIVE_COMPACTION_ENTRY,
  data: {
    format: NATIVE_COMPACTION_FORMAT,
    ...selectedModel(model),
    compactionId,
    model,
    item: { type: 'compaction', id: 'cmp_1', encrypted_content: encrypted }
  }
})

await check(
  'Branches: the native entry folds away; the raw view names it instead of the internal type',
  () => {
    assert.equal(
      SHARED_ENTRY,
      NATIVE_COMPACTION_ENTRY,
      'renderer and bridge agree on the entry type'
    )
    const iso = new Date(0).toISOString()
    const nodes: FlatTreeNode[] = [
      {
        entry: {
          type: 'compaction',
          id: 'c1',
          parentId: null,
          timestamp: iso,
          summary: 's',
          firstKeptEntryId: 'c1',
          tokensBefore: 10
        },
        parentId: null
      },
      {
        entry: {
          type: 'custom',
          id: 'n1',
          parentId: 'c1',
          timestamp: iso,
          customType: NATIVE_COMPACTION_ENTRY,
          data: {}
        },
        parentId: 'c1'
      }
    ]
    const texts = (raw: boolean) => {
      const out: string[] = []
      const walk = (node: BranchNode) => {
        out.push(node.text)
        node.children.forEach(walk)
      }
      walk(buildBranchTree(nodes, 'n1', raw).root)
      return out
    }
    assert.ok(
      !texts(false).some((t) => t.includes('native') || t.includes('vengeance')),
      'folded view hides it'
    )
    assert.ok(texts(true).includes('OpenAI native compaction'), 'raw view labels it')
    assert.ok(
      !texts(true).some((t) => t.includes(NATIVE_COMPACTION_ENTRY)),
      'never the internal type'
    )
  }
)

await check('supportsNativeCompaction: OpenAI Responses and Codex Responses', () => {
  assert.equal(
    supportsNativeCompaction({ provider: 'openai', api: 'openai-responses', id: 'gpt-6-luna' }),
    true
  )
  assert.equal(
    supportsNativeCompaction({
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      id: 'gpt-6-luna'
    }),
    true
  )
  assert.equal(
    supportsNativeCompaction({ provider: 'openai', api: 'openai-completions', id: 'gpt-4o' }),
    false
  )
  assert.equal(
    supportsNativeCompaction({ provider: 'anthropic', api: 'anthropic-messages', id: 'x' }),
    false
  )
  assert.equal(supportsNativeCompaction(undefined), false)
})

await check('nativeItemForBranch: the latest compaction, the same model, nothing else', () => {
  const branch: BranchEntry[] = [
    { type: 'message', id: 'm1' },
    { type: 'compaction', id: 'c1' },
    native('c1', 'gpt-6-luna', 'old'),
    { type: 'message', id: 'm2' },
    { type: 'compaction', id: 'c2' },
    { type: 'message', id: 'm3' },
    native('c2', 'gpt-6-sol', 'sol'),
    native('c2', 'gpt-6-luna', 'luna')
  ]
  assert.equal(nativeItemForBranch(branch, selectedModel('gpt-6-luna'))?.encrypted_content, 'luna')
  assert.equal(nativeItemForBranch(branch, selectedModel('gpt-6-sol'))?.encrypted_content, 'sol')
  assert.equal(nativeItemForBranch(branch, selectedModel('gpt-5.5')), undefined)
  // An item for an older compaction never stands in for the newer summary.
  assert.equal(nativeItemForBranch(branch.slice(0, 6), selectedModel('gpt-6-luna')), undefined)
  assert.equal(
    nativeItemForBranch([{ type: 'message', id: 'm' }], selectedModel('gpt-6-luna')),
    undefined
  )
  // Malformed data is ignored.
  const broken: BranchEntry = {
    type: 'custom',
    id: 'b',
    customType: NATIVE_COMPACTION_ENTRY,
    data: { compactionId: 'c9', model: 'gpt-6-luna', item: { type: 'compaction' } }
  }
  assert.equal(
    nativeItemForBranch([{ type: 'compaction', id: 'c9' }, broken], selectedModel('gpt-6-luna')),
    undefined
  )
})

await check(
  'nativeItemForBranch: unsafe checkpoints and foreign endpoints use the text summary',
  () => {
    const model = selectedModel('gpt-6.1-sol')
    const boundary: BranchEntry = { type: 'compaction', id: 'compact' }
    const legacy: BranchEntry = {
      type: 'custom',
      id: 'legacy',
      customType: NATIVE_COMPACTION_ENTRY,
      data: { compactionId: boundary.id, model: model.id, item }
    }
    const branch = [boundary, legacy]
    assert.equal(nativeItemForBranch(branch, model), undefined)
    branch.push(native(boundary.id, model.id))
    assert.deepEqual(nativeItemForBranch(branch, model), item)
    assert.equal(
      nativeItemForBranch(branch, { ...model, baseUrl: 'https://another.example/v1' }),
      undefined
    )
    assert.equal(nativeItemForBranch(branch, { ...model, provider: 'another' }), undefined)
    assert.equal(nativeItemForBranch(branch, { ...model, api: 'openai-completions' }), undefined)
    assert.deepEqual(legacy.data, { compactionId: boundary.id, model: model.id, item })
  }
)

await check(
  'withNativeItem: swaps the leading summary message, keeps the rest and the payload fields',
  () => {
    const payload = {
      model: 'gpt-6-luna',
      store: false,
      input: [
        { role: 'developer', content: 'system' },
        { role: 'user', content: [{ type: 'input_text', text: SUMMARY }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'next' }] }
      ]
    }
    const swapped = withNativeItem(payload, item)
    assert.ok(swapped)
    assert.deepEqual(swapped.input, [
      payload.input[0],
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc-1' },
      payload.input[2],
      payload.input[3]
    ])
    assert.equal(swapped.model, 'gpt-6-luna')
    assert.equal(swapped.store, false)
    assert.equal(payload.input[1]?.role, 'user', 'the original payload is not mutated')
  }
)

await check(
  'withNativeItem: no summary, a quoted summary later on, or no input: nothing to swap',
  () => {
    assert.equal(withNativeItem({ input: [{ role: 'user', content: 'hello' }] }, item), undefined)
    const quoted = {
      input: [
        { role: 'user', content: 'first' },
        { role: 'user', content: SUMMARY }
      ]
    }
    assert.equal(withNativeItem(quoted, item), undefined)
    assert.equal(withNativeItem({ messages: [] }, item), undefined)
    assert.equal(withNativeItem(null, item), undefined)
    assert.deepEqual(
      withNativeItem(
        { input: [{ role: 'user', content: SUMMARY }] },
        { type: 'compaction', encrypted_content: 'e' }
      )?.input,
      [{ type: 'compaction', encrypted_content: 'e' }]
    )
  }
)
