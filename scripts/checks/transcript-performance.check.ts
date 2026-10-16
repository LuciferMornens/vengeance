import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { AssistantMessage, ToolCall } from '../../src/shared/engine-types'
import {
  buildEntryItems,
  settledTranscript
} from '../../src/renderer/features/chat/transcript-items'
import type { TranscriptEntry } from '../../src/renderer/store/agent-state'
import { check } from './harness'

const LARGE_TOOL_COUNT = 20_000
const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: USAGE,
    stopReason: 'stop',
    timestamp: 0
  }
}

function toolCall(index: number): ToolCall {
  return {
    type: 'toolCall',
    id: `call-${index}`,
    name: 'read',
    arguments: { path: `file-${index}.txt` }
  }
}

await check('large consecutive tool runs keep every call without mutating message content', () => {
  const calls = Array.from({ length: LARGE_TOOL_COUNT }, (_, index) => toolCall(index))
  const entries = calls.map((call, index) => {
    const message = assistant([call])
    Object.freeze(message.content)
    return { key: `entry-${index}`, message }
  })
  const started = performance.now()
  const model = buildEntryItems(entries)
  const elapsed = performance.now() - started

  assert.equal(model.items.length, 1)
  const group = model.items[0]
  assert.ok(group?.kind === 'tools')
  assert.deepEqual(group.calls, calls)
  assert.ok(model.tail)
  assert.ok(entries.every((entry) => entry.message.content.length === 1))
  console.log(`      ${LARGE_TOOL_COUNT} consecutive calls: ${elapsed.toFixed(1)} ms`)
})

await check(
  'unchanged conversations reuse their projection and appended snapshots stay independent',
  () => {
    const entries: TranscriptEntry[] = [
      { key: 'prompt', message: { role: 'user', content: 'Read the files', timestamp: 0 } },
      { key: 'first', message: assistant([toolCall(0)]) }
    ]
    const first = settledTranscript(entries)
    assert.strictEqual(settledTranscript(entries), first)

    const appended = [...entries, { key: 'second', message: assistant([toolCall(1)]) }]
    const second = settledTranscript(appended, first.segments)
    assert.notStrictEqual(second, first)
    assert.strictEqual(second.segments[0], first.segments[0])
    const firstGroup = first.segments[1]?.items[0]
    const secondGroup = second.segments[1]?.items[0]
    assert.ok(firstGroup?.kind === 'tools' && secondGroup?.kind === 'tools')
    assert.equal(firstGroup.calls.length, 1)
    assert.equal(secondGroup.calls.length, 2)
    assert.strictEqual(settledTranscript(entries), first)
    assert.strictEqual(settledTranscript(appended), second)
  }
)

await check(
  'replaced history with reused keys renders the replacement text and turn targets',
  () => {
    const initial: TranscriptEntry[] = [
      { key: 'prompt', message: { role: 'user', content: 'Initial prompt', timestamp: 0 } },
      { key: 'answer', message: assistant([{ type: 'text', text: 'Initial answer' }]) }
    ]
    const first = settledTranscript(initial)
    const replacement: TranscriptEntry[] = [
      { key: 'prompt', message: { role: 'user', content: 'Replacement prompt', timestamp: 0 } },
      { key: 'answer', message: assistant([{ type: 'text', text: 'Replacement answer' }]) }
    ]
    const second = settledTranscript(replacement, first.segments)
    const answer = second.segments[1]?.items[0]

    assert.ok(answer?.kind === 'text')
    assert.equal(answer.text, 'Replacement answer')
    assert.deepEqual(second.tail?.texts, ['Replacement answer'])
    assert.strictEqual(second.tail?.prompt, replacement[0]?.message)
  }
)
