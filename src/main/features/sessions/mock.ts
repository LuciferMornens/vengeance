import type { ImportCandidate } from '@shared/api/sessions'
import type { AssistantMessage, FlatSessionTree, SessionEntry, Usage } from '@shared/engine-types'
import { mockLongSessionEntries, mockSessionHistory, type MockSessionHistory } from '../../engine/mock-sessions'

/**
 * Mock-mode (VENGEANCE_MOCK=1) answers for the sessions channels that read files: the tree of a
 * listed session (same ids as `mockForkPoints`), labels on it, and a sample import candidate.
 */

const labels = new Map<string, Map<string, string>>()

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function assistant(text: string, timestamp: number): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: ZERO_USAGE, stopReason: 'stop', timestamp }
}

/** The one-exchange-plus-follow-up history of a listed session (same ids as `mockForkPoints`). */
function shortSessionEntries(history: MockSessionHistory): { entries: SessionEntry[]; leafId: string } {
  const at = history.at
  const iso = (offset: number) => new Date(at - offset).toISOString()
  const entries: SessionEntry[] = [
    { type: 'message', id: 'mock0001', parentId: null, timestamp: iso(300_000), message: { role: 'user', content: history.firstMessage, timestamp: at - 300_000 } },
    { type: 'message', id: 'mock0002', parentId: 'mock0001', timestamp: iso(240_000), message: assistant(history.reply, at - 240_000) },
    { type: 'message', id: 'mock0003', parentId: 'mock0002', timestamp: iso(120_000), message: { role: 'user', content: 'Can you also add a regression test for it?', timestamp: at - 120_000 } },
    { type: 'message', id: 'mock0004', parentId: 'mock0003', timestamp: iso(60_000), message: assistant('Added a regression test that fails on the old code and passes with the fix.', at - 60_000) }
  ]
  return { entries, leafId: 'mock0004' }
}

export function mockSessionTree(path: string): FlatSessionTree {
  const history = mockSessionHistory(path)
  if (!history) return { nodes: [], leafId: null }
  // Both histories list their entries in tree pre-order, so each entry's parent is its tree parent.
  const { entries, leafId } = history.turns ? mockLongSessionEntries(history, history.turns, null) : shortSessionEntries(history)
  const own = labels.get(path.toLowerCase())
  const nodes = entries.map((entry) => {
    const label = own?.get(entry.id)
    return { entry, parentId: entry.parentId, ...(label ? { label } : {}) }
  })
  return { nodes, leafId }
}

export function setMockSessionLabel(path: string, entryId: string, label: string | undefined): void {
  const key = path.toLowerCase()
  const own = labels.get(key) ?? new Map<string, string>()
  const trimmed = label?.trim()
  if (trimmed) own.set(entryId, trimmed)
  else own.delete(entryId)
  labels.set(key, own)
}

/** What the import review shows in screenshots (the mock never opens a file dialog). */
export function mockImportCandidate(): ImportCandidate {
  return {
    sourcePath: 'C:\\Users\\dev\\Downloads\\2025-09-28T14-02-11_8f2c1d.jsonl',
    fileName: '2025-09-28T14-02-11_8f2c1d.jsonl',
    sessionId: '8f2c1d40-5b7e-4f61-9a3e-2c7d9e1b0a55',
    cwd: 'C:\\Users\\sam\\code\\aurora',
    cwdExists: false,
    name: 'Offline sync design review',
    firstMessage: 'Review the offline sync design doc and list the riskiest assumptions',
    messageCount: 24,
    createdAt: Date.now() - 3 * 86_400_000
  }
}
