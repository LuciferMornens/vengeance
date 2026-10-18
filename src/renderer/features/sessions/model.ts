import type { SessionListItem } from '@shared/api/sessions'
import { basename } from '../../lib/format'
import type { AgentState } from '../../store/agent-state'
import { userText } from '../chat/transcript-items'
import { childSessionAgent, runTitle } from '../subagents/format'

type ListingLookup = (path: string | undefined) => SessionListItem | undefined

/**
 * The listing of a session file, installed by the sessions store. Injected rather than imported: this module stays
 * free of the store's IPC, so offline checks can load it.
 */
let listedSession: ListingLookup = () => undefined

export function setListingLookup(lookup: ListingLookup): void {
  listedSession = lookup
}

/** The session file an open agent is on (follows fork/clone/switch via get_state). */
export function agentSessionFile(agent: AgentState): string | undefined {
  if (agent.session) return agent.session.sessionFile ?? agent.info.sessionFile
  return agent.info.sessionFile ?? agent.info.args.sessionPath
}

function firstLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Title of a child session the subagents extension named `subagent-worker-<run id>-1`: `Worker subagent`, plus the
 * task title from its first message (`Worker subagent · Fix lane B`). Null for any other name.
 */
export function childSessionTitle(
  name: string | undefined,
  firstMessage: string | undefined
): string | null {
  const agent = childSessionAgent(name)
  if (!agent) return null
  const role = `${agent.charAt(0).toUpperCase()}${agent.slice(1)} subagent`
  const task = runTitle(undefined, firstMessage)
  return task ? `${role} · ${task}` : role
}

/** The raw extension-generated name of a child session (shown only as a tooltip); undefined for other names. */
export function generatedChildName(name: string | undefined): string | undefined {
  return childSessionAgent(name) ? name?.trim() : undefined
}

/** Sidebar title of a persisted session: name, else first user message. */
export function itemTitle(item: SessionListItem): string {
  return (
    childSessionTitle(item.name, item.firstMessage) ??
    (item.name?.trim() || firstLine(item.firstMessage) || 'Untitled session')
  )
}

type FirstEntryState = { kind: 'user'; text: string } | { kind: 'compaction' } | { kind: 'none' }

const firstUserCache = new WeakMap<AgentState['entries'], FirstEntryState>()
const messageCountCache = new WeakMap<AgentState['entries'], number>()

/**
 * First user message of the session. A resumed compacted session's transcript starts at the compaction summary, after
 * the real first message, so the title comes from the listing (read from the file) there.
 */
function firstUserText(agent: AgentState): string | undefined {
  let state = firstUserCache.get(agent.entries)
  if (!state) {
    const first = agent.entries.find(
      (e) => e.message.role === 'user' || e.message.role === 'compactionSummary'
    )?.message
    state =
      first?.role === 'user'
        ? { kind: 'user', text: firstLine(userText(first)) }
        : first?.role === 'compactionSummary'
          ? { kind: 'compaction' }
          : { kind: 'none' }
    firstUserCache.set(agent.entries, state)
  }
  if (state.kind === 'user') return state.text || undefined
  if (state.kind !== 'compaction') return undefined
  return firstLine(listedSession(agentSessionFile(agent))?.firstMessage ?? '') || undefined
}

/**
 * Drop a leading "<workspace> · " (or " - ", " — ", ": ") that extensions put in titles: the
 * workspace is already shown by the titlebar crumb and the sidebar (SPEC §9.2).
 */
export function stripWorkspacePrefix(title: string, cwd: string): string {
  const name = basename(cwd)
  if (!name) return title
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stripped = title
    .replace(new RegExp(`^\\s*${escaped}\\s*(?:·|-|—|–|:|\\|)\\s*`, 'i'), '')
    .trim()
  return stripped || title
}

/** The title an open agent has on its own (extension title, session name, first user message), or null. */
export function agentOwnTitle(agent: AgentState): string | null {
  if (agent.ext.title) return stripWorkspacePrefix(agent.ext.title, agent.info.cwd)
  if (agent.sessionName)
    return childSessionTitle(agent.sessionName, firstUserText(agent)) ?? agent.sessionName
  return firstUserText(agent) || null
}

/** Title of an open agent: its own title, else the listing's, else "New session". */
export function agentTitle(agent: AgentState, listing?: SessionListItem): string {
  return agentOwnTitle(agent) ?? (listing ? itemTitle(listing) : 'New session')
}

/** Transcript characters searched per open session, like the listing's `searchText`. */
const SEARCH_TEXT_LIMIT = 4000

/** Search text per transcript: entries are replaced (never mutated) when a message lands, so this stays valid. */
const searchTextCache = new WeakMap<AgentState['entries'], string>()

/** Lowercased user and assistant text of an open agent, for sidebar search (matches closed sessions by content too). */
export function agentSearchText(agent: AgentState): string {
  const cached = searchTextCache.get(agent.entries)
  if (cached !== undefined) return cached
  const parts: string[] = []
  for (const { message } of agent.entries) {
    if (message.role === 'user') parts.push(userText(message))
    else if (message.role === 'assistant')
      parts.push(message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' '))
  }
  const text = parts.join(' ').slice(0, SEARCH_TEXT_LIMIT).toLowerCase()
  searchTextCache.set(agent.entries, text)
  return text
}

/**
 * Message count of an open agent, counted like the session list (pi's `messageCount`: every message
 * entry), minus system-prompt messages, which are not part of the conversation.
 */
export function agentMessageCount(agent: AgentState): number {
  const cached = messageCountCache.get(agent.entries)
  if (cached !== undefined) return cached
  let count = 0
  for (const entry of agent.entries) {
    if (entry.message.role !== 'system') count++
  }
  messageCountCache.set(agent.entries, count)
  return count
}

export type LiveState = 'starting' | 'running' | 'waiting' | 'crashed' | 'idle'

export function liveState(agent: AgentState): LiveState {
  if (agent.status === 'crashed' || agent.status === 'exited') return 'crashed'
  if (agent.ext.dialogs.length > 0) return 'waiting'
  if (agent.phase === 'running') return 'running'
  if (agent.status === 'starting' || agent.status === 'stopping') return 'starting'
  return 'idle'
}

export const LIVE_LABEL: Record<LiveState, string> = {
  starting: 'Starting engine…',
  running: 'Working…',
  waiting: 'Waiting for your input',
  crashed: 'Engine stopped',
  idle: 'Idle'
}

export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Older'

export const DATE_GROUPS: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Older']

export function dateGroup(epochMs: number, now = new Date()): DateGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (epochMs >= startOfToday) return 'Today'
  if (epochMs >= startOfToday - 86_400_000) return 'Yesterday'
  if (epochMs >= startOfToday - 6 * 86_400_000) return 'This week'
  return 'Older'
}

/** Compact relative time for list rows: "now", "12m", "3h", "2d", "Mar 4". */
export function shortTime(epochMs: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - epochMs) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function matchesQuery(query: string, ...texts: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}
