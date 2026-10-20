import { strict as assert } from 'node:assert'
import type { AgentMessage, AssistantMessage, CompactionSummaryMessage, SessionEntry, UserMessage } from '../../src/shared/engine-types'
import { earlierMessages } from '../../src/renderer/features/chat/earlier-history'
import type { ProviderInfo } from '../../src/shared/api/settings'
import {
  expiredSignInName,
  expiredSignInProvider,
  expiredSignInSummary,
  parseProviderError
} from '../../src/renderer/features/chat/provider-error'
import { SIGN_IN_EXPIRED } from '../../src/renderer/features/settings/provider-status'
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

await check('parseProviderError: a sign-in the provider refused to renew reads as in Providers, whatever the token endpoint said', () => {
  const failures: Array<[provider: string, raw: string]> = [
    // OpenAI: the token endpoint's JSON body (its `error` alone used to be the title).
    ['openai', 'Sign-in for openai expired: the provider rejected its refresh token (OpenAI OAuth token request failed (400): {"error":"invalid_grant","error_description":"Refresh token has been revoked"}). Sign in again.'],
    // Anthropic: status, URL and body (the status used to make it "The request was rejected").
    ['anthropic', 'Sign-in for anthropic expired: the provider rejected its refresh token (HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error":"invalid_grant","error_description":"Refresh token not found or invalid"}). Sign in again.'],
    // Kimi Code: no JSON, a status in words.
    ['kimi-coding', 'Sign-in for kimi-coding expired: the provider rejected its refresh token (Kimi Code token refresh unauthorized (status 401): Refresh token revoked). Sign in again.'],
    // Every later request, and a prompt or model switch (whose advice is a terminal command).
    ['xai', 'Sign-in for xai expired: the provider rejected its refresh token. Sign in again.'],
    ['openai-codex', "Sign-in for openai-codex expired: the provider rejected its refresh token. Run '/login openai-codex' to sign in again."]
  ]
  for (const [provider, raw] of failures) {
    const parsed = parseProviderError(raw)
    assert.equal(parsed.title, SIGN_IN_EXPIRED.label, raw)
    assert.equal(parsed.detail, SIGN_IN_EXPIRED.explanation, raw)
    assert.equal(parsed.expiredSignIn, provider, raw)
    assert.equal(expiredSignInProvider(raw), provider)
    assert.equal(parsed.status, undefined, raw)
    assert.equal(parsed.code, undefined, raw)
    assert.equal(parsed.raw, raw, 'the Engine’s text stays under Details')
  }
  assert.equal(expiredSignInProvider(`Error: ${failures[0]![1]}`), 'openai')
  // A compaction or branch summary that failed on it, behind the Engine's summarization label.
  for (const label of ['Summarization', 'Turn prefix summarization', 'Branch summarization'])
    assert.equal(expiredSignInProvider(`${label} failed: ${failures[0]![1]}`), 'openai', label)
  assert.equal(expiredSignInProvider(`Bug report failed: ${failures[0]![1]}`), undefined)
  // Other failures keep their own reading.
  const other = parseProviderError('400 {"error":"invalid_grant","error_description":"Bad refresh token"}')
  assert.equal(other.expiredSignIn, undefined)
  assert.equal(other.status, 400)
  assert.equal(expiredSignInProvider('OAuth refresh failed for openai'), undefined)
  assert.equal(expiredSignInProvider(undefined), undefined)
})

await check('expired sign-in: the provider by its UI name, and a toast line without terminal advice', () => {
  const catalog: ProviderInfo[] = [
    { id: 'kimi-coding', name: 'Kimi Code', status: { configured: false, usingOAuth: false }, envVars: [], modelCount: 2, availableCount: 0 },
    { id: 'openai', name: 'OpenAI', status: { configured: true, source: 'environment', usingOAuth: false }, envVars: ['OPENAI_API_KEY'], modelCount: 9, availableCount: 9 }
  ]
  assert.equal(expiredSignInName('kimi-coding', catalog), 'Kimi Code')
  // Only OAuth sign-ins are renewed: openai is the ChatGPT sign-in, also next to an API key and without a catalog.
  assert.equal(expiredSignInName('openai', catalog), 'ChatGPT')
  assert.equal(expiredSignInName('openai'), 'ChatGPT')
  assert.equal(expiredSignInName('openai-codex'), 'ChatGPT · Codex')
  assert.equal(expiredSignInName('kimi-coding'), 'Kimi Coding')
  const summary = expiredSignInSummary('openai', catalog)
  assert.equal(summary, `Sign-in expired for ChatGPT. ${SIGN_IN_EXPIRED.explanation}`)
  assert.doesNotMatch(summary, /\/login|\bpi\b/i)
})

await check('fileErrorReason: errno codes become words with the shown path; other errors keep their first line', () => {
  const missing = "ENOENT: no such file or directory, access 'C:\\Users\\dev\\AppData\\Local\\Temp\\w\\missing.txt'"
  assert.equal(fileErrorReason(missing, 'missing.txt'), 'File not found: missing.txt')
  assert.equal(fileErrorReason("EACCES: permission denied, open '/etc/x'", '/etc/x'), 'Permission denied: /etc/x')
  assert.equal(fileErrorReason('Offset 90 is beyond end of file (3 lines total)\nmore', 'a.txt'), 'Offset 90 is beyond end of file (3 lines total)')
})
