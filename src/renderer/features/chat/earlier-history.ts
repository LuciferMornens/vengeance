import { createContext } from 'react'
import type { AgentMessage, SessionEntry } from '@shared/engine-types'
import type { TranscriptEntry } from '../../store/agent-state'

/** The message an entry contributes to the transcript; settings changes, labels and other bookkeeping have none. */
function entryMessage(entry: SessionEntry): AgentMessage | null {
  const timestamp = Date.parse(entry.timestamp)
  switch (entry.type) {
    case 'message':
      return entry.message
    case 'compaction':
      return { role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }
    case 'branch_summary':
      return { role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp }
    case 'custom_message':
      return { role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp }
    default:
      return null
  }
}

/**
 * The messages the latest compaction on the leaf path summarized: every path entry before its
 * `firstKeptEntryId`. The Engine's context (`get_messages`) starts at that compaction, so a reopened session
 * shows none of them.
 */
export function earlierMessages(entries: SessionEntry[], leafId: string | null): AgentMessage[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path: SessionEntry[] = []
  for (let entry = leafId ? byId.get(leafId) : undefined; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) path.push(entry)
  path.reverse()
  const compaction = path.findLast((entry) => entry.type === 'compaction')
  if (compaction?.type !== 'compaction') return []
  const kept = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
  const end = kept >= 0 ? kept : path.indexOf(compaction)
  return path.slice(0, end).flatMap((entry) => entryMessage(entry) ?? [])
}

export interface EarlierHistory {
  /** The transcript starts at a compaction, so earlier messages exist in the session file. */
  available: boolean
  /** Loaded and shown above the compaction divider; null while hidden. */
  entries: TranscriptEntry[] | null
  loading: boolean
  toggle(): void
}

export const EarlierHistoryContext = createContext<EarlierHistory>({ available: false, entries: null, loading: false, toggle: () => undefined })
