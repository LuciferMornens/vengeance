import { strict as assert } from 'node:assert'
import type { AgentMessage, AssistantMessage, CompactionSummaryMessage, SessionEntry, UserMessage } from '../../src/shared/engine-types'
import { earlierMessages } from '../../src/renderer/features/chat/earlier-history'
import { parseProviderError } from '../../src/renderer/features/chat/provider-error'
import { buildEntryItems, earlierSegments } from '../../src/renderer/features/chat/transcript-items'
import { fileErrorReason } from '../../src/renderer/features/tools/tool-utils'
import type { TranscriptEntry } from '../../src/renderer/store/agent-state'
import { check } from './harness'

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function user(content: string): UserMessage {
  return { role: 'user', content, timestamp: 0 }
}

function assistant(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'x', provider: 'p', model: 'm', usage: USAGE, stopReason: 'stop', timestamp: 0 }
}

function failure(errorMessage: string): AssistantMessage {
  return { ...assistant(''), content: [], stopReason: 'error', errorMessage }
}

function compaction(summary: string): CompactionSummaryMessage {
  return { role: 'compactionSummary', summary, tokensBefore: 11000, timestamp: 0 }
}

function entries(messages: AgentMessage[]): TranscriptEntry[] {
  return messages.map((message, i) => ({ key: `e${i}`, message }))
}

function kinds(messages: AgentMessage[]): string[] {
  return buildEntryItems(entries(messages)).items.map((item) => item.kind)
}

// ─── Transcript items ────────────────────────────────────────────────────────────────────────────

await check('buildEntryItems: a request aborted by Stop before the provider answered reads as Stopped', () => {
  assert.deepEqual(kinds([user('go'), failure('This operation was aborted')]), ['user', 'aborted'])
  assert.deepEqual(kinds([user('go'), failure('Request was aborted.')]), ['user', 'aborted'])
  assert.deepEqual(kinds([user('go'), failure('503 {"error":{"message":"down"}}')]), ['user', 'error'])
})

await check('buildEntryItems: a failure recovered through a compaction is a compacted retry, a plain retry is not', () => {
  const overflow = buildEntryItems(entries([user('go'), failure('prompt is too long'), compaction('S'), assistant('ok')])).items
  const retried = overflow.find((item) => item.kind === 'retried')
  assert.ok(retried?.kind === 'retried' && retried.compacted)
  const plain = buildEntryItems(entries([user('go'), failure('503 down'), assistant('ok')])).items
  const again = plain.find((item) => item.kind === 'retried')
  assert.ok(again?.kind === 'retried' && !again.compacted)
})

await check('buildEntryItems: only a compaction that starts the transcript leads it', () => {
  const reopened = buildEntryItems(entries([compaction('S'), user('go')])).items[0]
  assert.ok(reopened?.kind === 'compaction' && reopened.leading)
  const live = buildEntryItems(entries([user('go'), assistant('ok'), compaction('S')])).items.find((item) => item.kind === 'compaction')
  assert.ok(live?.kind === 'compaction' && !live.leading)
})

await check('earlierSegments: muted, without turn actions, no leading compaction inside', () => {
  const segments = earlierSegments(entries([compaction('older'), user('one'), assistant('answer one')]))
  assert.ok(segments.every((segment) => segment.muted))
  const items = segments.flatMap((segment) => segment.items)
  assert.ok(!items.some((item) => item.kind === 'turn'))
  assert.ok(!items.some((item) => item.kind === 'compaction' && item.leading))
})

// ─── Earlier history ─────────────────────────────────────────────────────────────────────────────

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
  return { type: 'message', id, parentId, timestamp: '2025-01-01T00:00:00.000Z', message }
}

await check('earlierMessages: the leaf path before the latest compaction\u2019s first kept entry', () => {
  const sessionEntries: SessionEntry[] = [
    messageEntry('u1', null, user('one')),
    messageEntry('a1', 'u1', assistant('answer one')),
    { type: 'model_change', id: 'm1', parentId: 'a1', timestamp: '2025-01-01T00:00:00.000Z', provider: 'p', modelId: 'x' },
    messageEntry('u2', 'm1', user('two')),
    messageEntry('a2', 'u2', assistant('answer two')),
    { type: 'compaction', id: 'c1', parentId: 'a2', timestamp: '2025-01-01T00:00:00.000Z', summary: 'S', firstKeptEntryId: 'u2', tokensBefore: 10 },
    messageEntry('u3', 'c1', user('three')),
    messageEntry('side', 'a1', user('another branch'))
  ]
  const texts = earlierMessages(sessionEntries, 'u3').map((message) => (message.role === 'user' ? message.content : message.role))
  assert.deepEqual(texts, ['one', 'assistant'])
  assert.deepEqual(earlierMessages(sessionEntries, 'side'), [])
})

// ─── Provider errors and tool errors ─────────────────────────────────────────────────────────────

await check('parseProviderError: an HTML error page keeps its headline, the markup only in raw', () => {
  const page = '400 <html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>nginx</center></body></html>'
  const parsed = parseProviderError(page)
  assert.equal(parsed.title, 'The request was rejected')
  assert.equal(parsed.detail, 'Bad Request')
  assert.equal(parsed.raw, page)
  assert.equal(parseProviderError('<html><body>oops</body></html>').title, 'The provider returned an error page')
})

await check('fileErrorReason: errno codes become words with the shown path; other errors keep their first line', () => {
  const missing = "ENOENT: no such file or directory, access 'C:\\Users\\dev\\AppData\\Local\\Temp\\w\\missing.txt'"
  assert.equal(fileErrorReason(missing, 'missing.txt'), 'File not found: missing.txt')
  assert.equal(fileErrorReason("EACCES: permission denied, open '/etc/x'", '/etc/x'), 'Permission denied: /etc/x')
  assert.equal(fileErrorReason('Offset 90 is beyond end of file (3 lines total)\nmore', 'a.txt'), 'Offset 90 is beyond end of file (3 lines total)')
})
