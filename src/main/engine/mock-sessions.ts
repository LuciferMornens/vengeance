import { randomUUID } from 'node:crypto'
import type { ForkPoint, SessionListItem } from '@shared/api/sessions'
import type { AgentMessage, AssistantMessage, SessionEntry, Usage } from '@shared/engine-types'

/**
 * Mock-mode session listings (VENGEANCE_MOCK=1): a few workspaces with sessions spread over
 * Today / Yesterday / This week / Older, plus the short history a resumed mock session replays.
 * Mutable so mock rename / trash / branch behave like the real thing.
 */

export const MOCK_SESSIONS_ROOT = 'C:\\Users\\dev\\.pi\\agent\\sessions'

interface MockSessionSeed {
  cwd: string
  name?: string
  firstMessage: string
  /** Minutes before "now". */
  ago: number
  messages: number
  reply: string
  /** Generated exchanges of a long session (see `mockLongSessionEntries`); without it the history is one exchange. */
  turns?: number
}

const AURORA = 'C:\\Users\\dev\\projects\\aurora'
const TAKEDOWN = 'C:\\Users\\dev\\projects\\takedown'
const RELAY = 'D:\\work\\relay'
const DOTFILES = 'C:\\Users\\dev\\dotfiles'

const HOUR = 60
const DAY = 24 * HOUR

/** Over 3000 entries: nested, this session is far deeper than contextBridge's 1000-level object limit. */
const LONG_SESSION_TURNS = 1500

/** The name pi-subagents gives a child session: `subagent-<agent>-<run id>-<index>`. */
const CHILD_SESSION_NAME = 'subagent-worker-967ce01c-715d-4775-925f-e95093f91615-1'

const SEEDS: MockSessionSeed[] = [
  {
    cwd: AURORA,
    name: CHILD_SESSION_NAME,
    firstMessage: 'Task: Fix the session-tree jump on fork. When the user forks from a message in the Branches tab, the tree scrolls to the top.',
    ago: 70,
    messages: 64,
    reply: 'The forked node now stays selected and in view. Typecheck, build and shots pass.'
  },
  { cwd: AURORA, name: 'Debounced persist race', firstMessage: 'Session titles sometimes revert after I rename two sessions quickly.', ago: 38, messages: 46, reply: 'The shared debounce in `SessionStore.persist` drops every id but the last one in a 250 ms window. I switched it to a dirty set flushed in one write.' },
  { cwd: AURORA, firstMessage: 'Add keyboard navigation to the command palette results list', ago: 2 * HOUR + 12, messages: 31, reply: 'Arrow keys now move the active row, Home/End jump to the ends and Enter runs the highlighted command. The list scrolls the active row into view.' },
  { cwd: AURORA, name: 'Theme tokens audit', firstMessage: 'Audit every hard-coded color in src/ui and move it to tokens', ago: 5 * HOUR + 40, messages: 58, reply: 'Found 23 literal colors across 9 files. All of them now reference tokens; two new tokens were needed for the chart palette.' },
  { cwd: AURORA, firstMessage: 'Why does the dev server restart twice when I save a .tsx file?', ago: DAY + 3 * HOUR, messages: 12, reply: 'Two watchers observe `src/`: Vite and the `tsc --watch` task. Excluding `src/**` from the tsc task fixes the double restart.' },
  { cwd: AURORA, name: 'Release 0.9 checklist', firstMessage: 'Draft the release checklist for 0.9 from the merged PRs', ago: DAY + 7 * HOUR, messages: 19, reply: 'Checklist drafted: 14 merged PRs grouped into features, fixes and internal changes, plus the migration note for the settings file.' },
  { cwd: AURORA, firstMessage: 'Write integration tests for the sync engine conflict resolution', ago: 3 * DAY + 2 * HOUR, messages: 74, reply: 'Added 11 integration tests covering concurrent edits, tombstones and clock skew. Two of them exposed a real ordering bug, now fixed.' },
  { cwd: AURORA, firstMessage: 'Profile the startup path and find what blocks first paint', ago: 4 * DAY + 5 * HOUR, messages: 27, reply: 'Font loading and a synchronous settings read block first paint. Preloading the font and reading settings async cut 180 ms.' },
  { cwd: AURORA, name: 'Migrate to React 19', firstMessage: 'Plan the migration to React 19 and list breaking changes that affect us', ago: 12 * DAY, messages: 88, reply: 'Three breaking changes matter here: ref as a prop, removed string refs in legacy dialogs, and the new `useActionState` naming.' },
  { cwd: AURORA, firstMessage: 'Explain how the plugin loader resolves relative imports', ago: 26 * DAY, messages: 9, reply: 'The loader resolves relative specifiers against the plugin manifest directory, not the importing file. That is why nested imports break.' },
  { cwd: TAKEDOWN, name: 'Rate limiter rewrite', firstMessage: 'Rewrite the token bucket rate limiter to be lock-free', ago: 55, messages: 40, reply: 'The limiter now uses an atomic compare-and-swap loop over a packed (tokens, timestamp) word. Benchmarks show 3.1× throughput.' },
  { cwd: TAKEDOWN, firstMessage: 'Find why the scraper leaks file handles on Windows', ago: DAY + 9 * HOUR, messages: 22, reply: 'Response bodies were never consumed on 304s, so undici kept the sockets and their handles open. Draining the body fixes the leak.' },
  { cwd: TAKEDOWN, firstMessage: 'Set up GitHub Actions matrix for Node 22 and 24', ago: 6 * DAY, messages: 15, reply: 'The workflow now runs lint, typecheck and tests on Node 22 and 24 across Windows and Ubuntu, with npm cache keyed on the lockfile.' },
  { cwd: RELAY, name: 'Websocket reconnect', firstMessage: 'Make the websocket client reconnect with jittered backoff', ago: 3 * HOUR, messages: 33, reply: 'Reconnects use full-jitter exponential backoff capped at 30 s and resume subscriptions after the handshake.' },
  { cwd: RELAY, firstMessage: 'Document the relay message envelope format', ago: 9 * DAY, messages: 11, reply: 'Documented the envelope: version byte, flags, 32-bit length, then a CBOR payload. Added examples for each message kind.' },
  {
    cwd: RELAY,
    name: 'Decoder fuzzing marathon',
    firstMessage: 'Fuzz the envelope decoder round by round and log every finding',
    ago: 15 * DAY,
    messages: LONG_SESSION_TURNS * 2,
    reply: 'Round 1 done: the decoder rejects truncated length prefixes cleanly. No crashes so far.',
    turns: LONG_SESSION_TURNS
  },
  { cwd: DOTFILES, firstMessage: 'Port my zsh aliases to PowerShell', ago: 18 * DAY, messages: 14, reply: 'Ported 41 aliases into a PowerShell profile module; functions that need arguments became proper advanced functions.' }
]

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

function fileFor(cwd: string, at: number, id: string): string {
  return `${MOCK_SESSIONS_ROOT}\\${encodeCwd(cwd)}\\${new Date(at).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`
}

interface MockSessionRecord extends SessionListItem {
  reply: string
  turns?: number
}

let records: MockSessionRecord[] | null = null

function all(): MockSessionRecord[] {
  if (records) return records
  const now = Date.now()
  records = SEEDS.map((seed, index) => {
    const id = `0000${index.toString(16)}`.slice(-4) + randomUUID().slice(4)
    const modifiedAt = now - seed.ago * 60_000
    const createdAt = modifiedAt - Math.min(seed.messages, 60) * 45_000
    return {
      path: fileFor(seed.cwd, createdAt, id),
      id,
      cwd: seed.cwd,
      name: seed.name,
      createdAt,
      modifiedAt,
      messageCount: seed.messages,
      firstMessage: seed.firstMessage,
      searchText: `${seed.name ?? ''} ${seed.firstMessage} ${seed.reply}`.toLowerCase(),
      reply: seed.reply,
      turns: seed.turns
    }
  })
  return records
}

const strip = ({ reply: _reply, turns: _turns, ...item }: MockSessionRecord): SessionListItem => item

export function listMockSessions(cwd: string | null): SessionListItem[] {
  const wanted = cwd?.toLowerCase()
  return all()
    .filter((s) => wanted === undefined || s.cwd.toLowerCase() === wanted)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .map(strip)
}

export function findMockSession(path: string): MockSessionRecord | undefined {
  return all().find((s) => s.path.toLowerCase() === path.toLowerCase())
}

export function renameMockSession(path: string, name: string): void {
  const record = findMockSession(path)
  if (!record) throw new Error(`Session not found: ${path}`)
  record.name = name.trim() || undefined
  record.searchText = `${record.name ?? ''} ${record.firstMessage} ${record.reply}`.toLowerCase()
}

export function trashMockSession(path: string): void {
  records = all().filter((s) => s.path.toLowerCase() !== path.toLowerCase())
}

/** Mock `createBranchedSession`: a new listed session derived from `sourcePath`. */
export function branchMockSession(sourcePath: string): string {
  const source = findMockSession(sourcePath)
  const now = Date.now()
  const id = randomUUID()
  const cwd = source?.cwd ?? AURORA
  const record: MockSessionRecord = {
    path: fileFor(cwd, now, id),
    id,
    cwd,
    name: source ? `Branch of ${source.name ?? source.firstMessage}` : undefined,
    parentSessionPath: sourcePath,
    createdAt: now,
    modifiedAt: now,
    messageCount: Math.max(2, Math.round((source?.messageCount ?? 4) / 2)),
    firstMessage: source?.firstMessage ?? 'Continue from here',
    searchText: '',
    reply: source?.reply ?? 'Continuing from the selected point.'
  }
  all().push(record)
  return record.path
}

/** Mock `/import`: a new listed session in `cwd` (the copy of an imported file). */
export function importMockSession(cwd: string, name: string | undefined, firstMessage: string, messageCount: number): string {
  const now = Date.now()
  const id = randomUUID()
  const reply = 'Imported session: the conversation continues where the original file left off.'
  all().push({
    path: fileFor(cwd, now, id),
    id,
    cwd,
    name,
    createdAt: now - 3 * DAY,
    modifiedAt: now,
    messageCount,
    firstMessage,
    searchText: `${name ?? ''} ${firstMessage} ${reply}`.toLowerCase(),
    reply
  })
  return fileFor(cwd, now, id)
}

export function mockForkPoints(path: string): ForkPoint[] {
  const record = findMockSession(path)
  if (!record) return []
  return [
    { entryId: 'mock0001', parentId: null, text: record.firstMessage, timestamp: record.createdAt },
    { entryId: 'mock0003', parentId: 'mock0002', text: 'Can you also add a regression test for it?', timestamp: record.modifiedAt - 120_000 }
  ]
}

export interface MockSessionHistory {
  name?: string
  firstMessage: string
  reply: string
  /** Time of the last message. */
  at: number
  /** Set for a long session: its history is `mockLongSessionEntries`. */
  turns?: number
}

/** History a resumed mock session starts with (null for unknown paths). */
export function mockSessionHistory(path: string): MockSessionHistory | null {
  const record = findMockSession(path)
  return record ? { name: record.name, firstMessage: record.firstMessage, reply: record.reply, at: record.modifiedAt, turns: record.turns } : null
}

/** Every n-th turn of a long session reads a file first (assistant tool call + tool result). */
const TOOL_TURN_EVERY = 10
/** Every n-th turn of a long session has an abandoned side question hanging off its reply. */
const SIDE_BRANCH_EVERY = 400
const LONG_SESSION_STEP_MS = 20_000
/**
 * Nesting of the last tool result's `details` (a fuzz corpus): past the ~500 objects contextBridge accepts,
 * like adversarial MCP output, so get_messages and get_tree exercise main's payload depth guard.
 */
const CORPUS_DEPTH = 1200

function nestedCorpus(levels: number): Record<string, unknown> {
  let frame: Record<string, unknown> = { payload: 'ff00' }
  for (let level = 1; level < levels; level++) frame = { frame }
  return frame
}

const LONG_SESSION_USAGE: Usage = {
  input: 18_200,
  output: 140,
  cacheRead: 17_600,
  cacheWrite: 0,
  totalTokens: 35_940,
  cost: { input: 0.0546, output: 0.0021, cacheRead: 0.00528, cacheWrite: 0, total: 0.06198 }
}

function longSessionReply(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'], timestamp: number): AssistantMessage {
  return { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: LONG_SESSION_USAGE, stopReason, timestamp }
}

/**
 * Entries of a long mock session: `turns` exchanges on one line, every TOOL_TURN_EVERY-th reading a file first,
 * and an abandoned side question every SIDE_BRANCH_EVERY turns. Array order is time order and tree pre-order.
 */
export function mockLongSessionEntries(history: MockSessionHistory, turns: number, rootParentId: string | null): { entries: SessionEntry[]; leafId: string | null } {
  const entries: SessionEntry[] = []
  const toolTurns = Math.floor(turns / TOOL_TURN_EVERY)
  const sideTurns = Math.floor(turns / SIDE_BRANCH_EVERY)
  // Every exchange (turn, tool call + result, side question + answer) is two entries.
  const entryCount = (turns + toolTurns + sideTurns) * 2
  let time = history.at - entryCount * LONG_SESSION_STEP_MS
  const add = (parentId: string | null, message: (timestamp: number) => AgentMessage): string => {
    time += LONG_SESSION_STEP_MS
    const id = `long${entries.length.toString(16).padStart(4, '0')}`
    entries.push({ type: 'message', id, parentId, timestamp: new Date(time).toISOString(), message: message(time) })
    return id
  }

  let leafId = rootParentId
  for (let turn = 1; turn <= turns; turn++) {
    const prompt = turn === 1 ? history.firstMessage : `Round ${turn}: mutate the length prefix and run the decoder again.`
    leafId = add(leafId, (timestamp) => ({ role: 'user', content: prompt, timestamp }))
    if (turn % TOOL_TURN_EVERY === 0) {
      const toolCallId = `read-${turn}`
      const call = { type: 'toolCall' as const, id: toolCallId, name: 'read', arguments: { path: 'src/envelope/decode.ts' } }
      leafId = add(leafId, (timestamp) => longSessionReply([{ type: 'text', text: `Reading the decoder before round ${turn}.` }, call], 'toolUse', timestamp))
      const details = turn + TOOL_TURN_EVERY > turns ? { details: { corpus: nestedCorpus(CORPUS_DEPTH) } } : {}
      const output = 'export function decode(frame: Uint8Array) { … }'
      leafId = add(leafId, (timestamp) => ({ role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text: output }], ...details, isError: false, timestamp }))
    }
    const text = turn === 1 ? history.reply : `Round ${turn} done: no new crashes.`
    leafId = add(leafId, (timestamp) => longSessionReply([{ type: 'text', text }], 'stop', timestamp))
    if (turn % SIDE_BRANCH_EVERY === 0) {
      const side = add(leafId, (timestamp) => ({ role: 'user', content: `Should round ${turn} also try oversized frames?`, timestamp }))
      add(side, (timestamp) => longSessionReply([{ type: 'text', text: 'Oversized frames are rejected before decoding, so they add nothing here.' }], 'stop', timestamp))
    }
  }
  return { entries, leafId }
}
