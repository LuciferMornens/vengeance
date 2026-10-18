import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
  ThinkingContent,
  ToolCall,
  UserMessage
} from '@shared/engine-types'
import {
  isSubagentMessageType,
  parseSupervisorReplyPrompt,
  SUBAGENT_WAKE_PREFIX
} from '@shared/subagents'
import type { StreamingMessage, TranscriptEntry } from '../../store/agent-state'
import { HIDDEN_TOOLS } from '../tools/tool-utils'

/** What the hover actions of one assistant turn operate on. */
export interface TurnInfo {
  key: string
  /** Every assistant text block of the turn (joined only when copied). */
  texts: string[]
  /** The user message that started the turn (retry target). */
  prompt?: UserMessage
  /** The user message after the turn (fork target); none = the turn is the session's tail. */
  next?: UserMessage
}

export type TranscriptItem =
  | { kind: 'user'; key: string; message: UserMessage }
  /** Consecutive settled thinking blocks of a turn are one item ("Thought \u00d72"). */
  | { kind: 'thinking'; key: string; blocks: ThinkingContent[]; live: boolean }
  | { kind: 'text'; key: string; text: string; live: boolean }
  | { kind: 'tools'; key: string; calls: ToolCall[] }
  | { kind: 'error'; key: string; message: AssistantMessage }
  /** A failed response a later one recovered from; `compacted`: the Engine compacted the context in between. */
  | { kind: 'retried'; key: string; message: AssistantMessage; compacted: boolean }
  | { kind: 'aborted'; key: string }
  | { kind: 'bash'; key: string; message: BashExecutionMessage }
  /** `leading`: nothing precedes it (a reopened session starts at its latest compaction). */
  | { kind: 'compaction'; key: string; message: CompactionSummaryMessage; leading: boolean }
  | { kind: 'branch'; key: string; message: BranchSummaryMessage }
  | { kind: 'custom'; key: string; message: CustomMessage }
  /** Consecutive pi-subagents custom messages (one row, or a folded "Subagent updates" row). */
  | {
      kind: 'subagent-notices'
      key: string
      notices: Array<{ key: string; message: CustomMessage }>
    }
  /** pi-subagents' wake prompt with no notices right before it (a quiet divider, not a bubble). */
  | { kind: 'wake'; key: string }
  /** The prompt carrying the user's answer to a supervisor request (a row, not a bubble). */
  | { kind: 'supervisor-reply'; key: string; message: UserMessage }
  | { kind: 'unknown'; key: string; role: string }
  | { kind: 'turn'; key: string; turn: TurnInfo }

/** Item kinds that belong to an assistant turn (and get turn actions after them). */
const TURN_KINDS = new Set<TranscriptItem['kind']>([
  'thinking',
  'text',
  'tools',
  'error',
  'retried',
  'aborted'
])

/**
 * The error a request gets when the user's Stop aborts it before the provider answered (e.g. the follow-up
 * request after a stopped tool). Providers that saw the abort report `stopReason: 'aborted'` instead.
 */
const ABORT_ERROR =
  /^(?:AbortError:\s*)?(?:This operation was aborted|The operation was aborted|Request was aborted|Request aborted)\.?$/i

function isAbortError(message: AssistantMessage): boolean {
  return message.stopReason === 'error' && ABORT_ERROR.test(message.errorMessage?.trim() ?? '')
}

export function userText(message: UserMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

/** Owns its arrays until construction finishes, so long groups can append without copying the prefix. */
class ItemBuilder {
  readonly items: TranscriptItem[] = []
  private turnText: string[] = []
  private turnOpen = false
  private prompt: UserMessage | undefined
  private readonly hasPrecedingItems: boolean
  /** Index of a failed response in the current turn; a later response means an automatic retry recovered it. */
  private failedAt: number | null = null
  /** A compaction followed the failed response (the Engine's context-overflow recovery). */
  private compactedSinceFailure = false

  constructor(prompt?: UserMessage, hasPrecedingItems = false) {
    this.prompt = prompt
    this.hasPrecedingItems = hasPrecedingItems
  }

  private push(item: TranscriptItem): void {
    // Consecutive tool calls (across messages; tool results are invisible) form one activity group,
    // consecutive settled thinking blocks one chip, and consecutive subagent notices one updates row.
    const last = this.items[this.items.length - 1]
    if (item.kind === 'tools' && last?.kind === 'tools') {
      last.calls.push(...item.calls)
    } else if (item.kind === 'thinking' && last?.kind === 'thinking' && !item.live && !last.live) {
      last.blocks.push(...item.blocks)
    } else if (item.kind === 'subagent-notices' && last?.kind === 'subagent-notices') {
      last.notices.push(...item.notices)
    } else {
      this.items.push(item)
    }
    if (TURN_KINDS.has(item.kind)) this.turnOpen = true
  }

  /** Close the running assistant turn (emits its actions row) before a boundary item. */
  private closeTurn(key: string, next: UserMessage | undefined): void {
    if (this.turnOpen)
      this.items.push({
        kind: 'turn',
        key: `turn:${key}`,
        turn: { key, texts: this.turnText, prompt: this.prompt, next }
      })
    this.turnOpen = false
    this.turnText = []
  }

  add(key: string, message: AgentMessage, live: boolean): void {
    switch (message.role) {
      case 'user':
        // Host-sent prompts are not turn boundaries: retry/fork keep targeting the user's own messages.
        if (userText(message).startsWith(SUBAGENT_WAKE_PREFIX)) {
          // Folded into the notices right before it; otherwise a divider.
          if (this.items[this.items.length - 1]?.kind !== 'subagent-notices')
            this.push({ kind: 'wake', key })
          return
        }
        if (parseSupervisorReplyPrompt(userText(message))) {
          this.push({ kind: 'supervisor-reply', key, message })
          return
        }
        this.failedAt = null
        this.closeTurn(key, message)
        this.items.push({ kind: 'user', key, message })
        this.prompt = message
        return
      case 'assistant':
        this.addAssistant(key, message, live)
        return
      case 'toolResult':
      case 'system':
        return
      case 'bashExecution':
        this.closeTurn(key, undefined)
        this.items.push({ kind: 'bash', key, message })
        return
      case 'compactionSummary':
        this.closeTurn(key, undefined)
        if (this.failedAt !== null) this.compactedSinceFailure = true
        this.items.push({
          kind: 'compaction',
          key,
          message,
          leading: !this.hasPrecedingItems && this.items.length === 0
        })
        return
      case 'branchSummary':
        this.closeTurn(key, undefined)
        this.items.push({ kind: 'branch', key, message })
        return
      case 'custom':
        if (!message.display) return
        if (isSubagentMessageType(message.customType))
          this.push({ kind: 'subagent-notices', key, notices: [{ key, message }] })
        else this.push({ kind: 'custom', key, message })
        return
      default: {
        const role = (message as { role?: unknown }).role
        this.push({ kind: 'unknown', key, role: typeof role === 'string' ? role : 'message' })
      }
    }
  }

  private addAssistant(key: string, message: AssistantMessage, live: boolean): void {
    const failed = this.failedAt === null ? undefined : this.items[this.failedAt]
    if (failed?.kind === 'error')
      this.items[this.failedAt!] = {
        kind: 'retried',
        key: failed.key,
        message: failed.message,
        compacted: this.compactedSinceFailure
      }
    this.failedAt = null
    this.compactedSinceFailure = false
    const last = message.content.length - 1
    message.content.forEach((block, i) => {
      const blockLive = live && i === last
      if (block.type === 'thinking') {
        if (block.thinking.trim() || block.redacted || blockLive)
          this.push({ kind: 'thinking', key: `${key}:${i}`, blocks: [block], live: blockLive })
      } else if (block.type === 'text') {
        if (block.text.trim() || blockLive) {
          this.push({ kind: 'text', key: `${key}:${i}`, text: block.text, live: blockLive })
          if (block.text.trim()) this.turnText.push(block.text)
        }
      } else if (block.type === 'toolCall') {
        // Plumbing tools (enabling other tools) are left out, so they never split or pad a group.
        if (!HIDDEN_TOOLS.has(block.name))
          this.push({ kind: 'tools', key: `tools:${block.id}`, calls: [block] })
      }
    })
    if (message.stopReason === 'aborted' || isAbortError(message)) {
      this.push({ kind: 'aborted', key: `${key}:aborted` })
    } else if (message.stopReason === 'error') {
      this.push({ kind: 'error', key: `${key}:error`, message })
      this.failedAt = this.items.length - 1
      this.compactedSinceFailure = false
    }
  }

  /** Turn info for the open tail turn (actions shown once the agent is idle). */
  tail(): TurnInfo | null {
    return this.turnOpen ? { key: 'tail', texts: this.turnText, prompt: this.prompt } : null
  }
}

export interface TranscriptModel {
  items: TranscriptItem[]
  tail: TurnInfo | null
}

/** Display items for completed entries (memoize on the entries array). */
export function buildEntryItems(entries: TranscriptEntry[]): TranscriptModel {
  const builder = new ItemBuilder()
  for (const entry of entries) builder.add(entry.key, entry.message, false)
  return { items: builder.items, tail: builder.tail() }
}

/** Items of the message currently streaming. */
export function buildStreamingItems(streaming: StreamingMessage | null): TranscriptItem[] {
  if (!streaming) return []
  const builder = new ItemBuilder()
  builder.add(streaming.key, streaming.message, true)
  return builder.items
}

/** Join completed + streaming items, merging a tool group that continues across the boundary. */
export function joinItems(settled: TranscriptItem[], live: TranscriptItem[]): TranscriptItem[] {
  if (live.length === 0) return settled
  const last = settled[settled.length - 1]
  const first = live[0]
  if (last?.kind === 'tools' && first?.kind === 'tools') {
    return [
      ...settled.slice(0, -1),
      { ...last, calls: [...last.calls, ...first.calls] },
      ...live.slice(1)
    ]
  }
  return [...settled, ...live]
}

export interface Segment {
  key: string
  kind: 'user' | 'turn' | 'event'
  items: TranscriptItem[]
  /** History outside the Engine's context (before the latest compaction): dimmed and read-only. */
  muted?: boolean
}

/** Group items into user / assistant-turn / event segments (turns get shared hover actions). */
export function segmentItems(items: TranscriptItem[]): Segment[] {
  const segments: Segment[] = []
  let turn: Segment | null = null
  for (const item of items) {
    if (item.kind === 'user') {
      turn = null
      segments.push({ key: item.key, kind: 'user', items: [item] })
    } else if (item.kind === 'bash' || item.kind === 'compaction' || item.kind === 'branch') {
      turn = null
      segments.push({ key: item.key, kind: 'event', items: [item] })
    } else {
      if (!turn) {
        turn = { key: `seg:${item.key}`, kind: 'turn', items: [] }
        segments.push(turn)
      }
      turn.items.push(item)
      if (item.kind === 'turn') turn = null
    }
  }
  return segments
}

/**
 * Read-only segments for history the Engine compacted away: no turn actions (nothing to retry or fork there),
 * and no compaction in it leads the transcript.
 */
export function earlierSegments(entries: TranscriptEntry[]): Segment[] {
  const items = buildEntryItems(entries)
    .items.filter((item) => item.kind !== 'turn')
    .map((item) => (item.kind === 'compaction' ? { ...item, leading: false } : item))
  return segmentItems(items).map((segment) => ({ ...segment, muted: true }))
}

function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false
  switch (a.kind) {
    case 'thinking':
      return (
        b.kind === 'thinking' &&
        a.live === b.live &&
        a.blocks.length === b.blocks.length &&
        a.blocks.every((block, i) => block === b.blocks[i])
      )
    case 'text':
      return b.kind === 'text' && a.text === b.text && a.live === b.live
    case 'tools':
      return (
        b.kind === 'tools' &&
        a.calls.length === b.calls.length &&
        a.calls.every((c, i) => c === b.calls[i])
      )
    case 'subagent-notices':
      return (
        b.kind === 'subagent-notices' &&
        a.notices.length === b.notices.length &&
        a.notices.every((n, i) => n.message === b.notices[i]!.message)
      )
    case 'turn':
      return (
        b.kind === 'turn' &&
        a.turn.texts.length === b.turn.texts.length &&
        a.turn.texts.every((text, i) => text === b.turn.texts[i]) &&
        a.turn.prompt === b.turn.prompt &&
        a.turn.next === b.turn.next
      )
    case 'retried':
      return b.kind === 'retried' && a.message === b.message && a.compacted === b.compacted
    case 'compaction':
      return b.kind === 'compaction' && a.message === b.message && a.leading === b.leading
    case 'unknown':
    case 'aborted':
    case 'wake':
      return true
    default:
      return 'message' in b && a.message === b.message
  }
}

function sameSegment(a: Segment, b: Segment): boolean {
  return (
    a.kind === b.kind &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => sameItem(item, b.items[i]!))
  )
}

/**
 * Reuse the previous segment objects that did not change, so memoized segment views skip re-rendering when
 * the transcript grows (rebuilding items allocates new objects for every entry).
 */
export function reuseSegments(previous: Segment[], next: Segment[]): Segment[] {
  if (previous.length === 0) return next
  const byKey = new Map(previous.map((seg) => [seg.key, seg]))
  return next.map((seg) => {
    const old = byKey.get(seg.key)
    return old && sameSegment(old, seg) ? old : seg
  })
}

export interface SettledTranscript {
  segments: Segment[]
  tail: TurnInfo | null
}

interface TranscriptCheckpoint {
  entryCount: number
  prompt: UserMessage
  segments: Segment[]
}

interface SessionTranscriptState {
  entries: TranscriptEntry[]
  settled: SettledTranscript
  checkpoint: TranscriptCheckpoint | null
}

// Entries are immutable store snapshots. Weak keys let closed sessions and superseded snapshots go.
const settledTranscripts = new WeakMap<TranscriptEntry[], SettledTranscript>()
const settledByFirstEntry = new WeakMap<TranscriptEntry, SessionTranscriptState>()

function hasEntryPrefix(
  entries: TranscriptEntry[],
  prefix: TranscriptEntry[],
  count = prefix.length
): boolean {
  if (entries.length < count) return false
  if (count === 0) return true
  if (entries[count - 1] !== prefix[count - 1] || entries[0] !== prefix[0]) return false
  for (let i = 1; i < count - 1; i++) {
    if (entries[i] !== prefix[i]) return false
  }
  return true
}

function isIgnoredEntry(entry: TranscriptEntry): boolean {
  const { message } = entry
  return (
    message.role === 'toolResult' ||
    message.role === 'system' ||
    (message.role === 'custom' && !message.display)
  )
}

function isTurnBoundaryUser(message: AgentMessage): message is UserMessage {
  if (message.role !== 'user') return false
  const text = userText(message)
  return !text.startsWith(SUBAGENT_WAKE_PREFIX) && !parseSupervisorReplyPrompt(text)
}

function reuseFromOffset(previous: Segment[], next: Segment[], offset: number): Segment[] {
  if (previous.length === 0 || next.length === 0) return next
  const slice =
    offset > 0 && previous.length >= offset ? previous.slice(offset) : previous
  return reuseSegments(slice, next)
}

/** Reuse the derived history when an unchanged conversation mounts again after a tab switch. */
export function settledTranscript(
  entries: TranscriptEntry[],
  previous: Segment[] = []
): SettledTranscript {
  const cached = settledTranscripts.get(entries)
  if (cached) return cached

  if (entries.length === 0) {
    const empty: SettledTranscript = { segments: [], tail: null }
    settledTranscripts.set(entries, empty)
    return empty
  }

  const firstEntry = entries[0]!
  const prior = settledByFirstEntry.get(firstEntry)

  if (prior && entries.length > prior.entries.length && hasEntryPrefix(entries, prior.entries)) {
    let allIgnored = true
    for (let i = prior.entries.length; i < entries.length; i++) {
      if (!isIgnoredEntry(entries[i]!)) {
        allIgnored = false
        break
      }
    }
    if (allIgnored && (previous.length === 0 || previous === prior.settled.segments)) {
      settledTranscripts.set(entries, prior.settled)
      settledByFirstEntry.set(firstEntry, {
        entries,
        settled: prior.settled,
        checkpoint: prior.checkpoint
      })
      return prior.settled
    }
  }

  let checkpoint: TranscriptCheckpoint | null = null
  if (prior?.checkpoint && hasEntryPrefix(entries, prior.entries, prior.checkpoint.entryCount)) {
    const priorSegments = prior.checkpoint.segments
    const matchesPrevious =
      previous.length === 0 ||
      (previous.length >= priorSegments.length &&
        previous[0] === priorSegments[0] &&
        previous[priorSegments.length - 1] === priorSegments[priorSegments.length - 1])
    checkpoint = matchesPrevious
      ? prior.checkpoint
      : {
          ...prior.checkpoint,
          segments: reuseSegments(previous, priorSegments)
        }
  }

  const startIndex = checkpoint?.entryCount ?? 0
  let lastUserIdx = -1
  for (let i = entries.length - 1; i >= startIndex; i--) {
    if (isTurnBoundaryUser(entries[i]!.message)) {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx >= startIndex) {
    const midBuilder = new ItemBuilder(checkpoint?.prompt, checkpoint !== null)
    for (let i = startIndex; i <= lastUserIdx; i++) {
      const entry = entries[i]!
      midBuilder.add(entry.key, entry.message, false)
    }
    const baseSegmentCount = checkpoint?.segments.length ?? 0
    const midSegments = reuseFromOffset(
      previous,
      segmentItems(midBuilder.items),
      baseSegmentCount
    )
    checkpoint = {
      entryCount: lastUserIdx + 1,
      prompt: entries[lastUserIdx]!.message as UserMessage,
      segments: checkpoint ? [...checkpoint.segments, ...midSegments] : midSegments
    }
  }

  const tailStart = checkpoint?.entryCount ?? 0
  const tailBuilder = new ItemBuilder(checkpoint?.prompt, checkpoint !== null)
  for (let i = tailStart; i < entries.length; i++) {
    const entry = entries[i]!
    tailBuilder.add(entry.key, entry.message, false)
  }
  const baseSegmentCount = checkpoint?.segments.length ?? 0
  const tailSegments = reuseFromOffset(
    previous,
    segmentItems(tailBuilder.items),
    baseSegmentCount
  )
  const settled: SettledTranscript = {
    segments: checkpoint ? [...checkpoint.segments, ...tailSegments] : tailSegments,
    tail: tailBuilder.tail()
  }
  settledTranscripts.set(entries, settled)
  settledByFirstEntry.set(firstEntry, { entries, settled, checkpoint })
  return settled
}
