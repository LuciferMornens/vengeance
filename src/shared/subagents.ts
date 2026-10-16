/**
 * pi-subagents protocol: widget/status keys, custom message types and parsers for the machine payloads an
 * RPC host receives (async status snapshot, inspect replies, notices). Every parser fails closed: it returns
 * null (or drops a field) instead of passing model-facing text through.
 */

export const SUBAGENT_ASYNC_WIDGET_KEY = 'subagent-async'
export const SUBAGENT_ASYNC_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:'
export const SUBAGENT_INSPECT_WIDGET_KEY = 'subagent-inspect'
export const SUBAGENT_INSPECT_PREFIX = 'PI_SUBAGENT_INSPECT_JSON:'
export const SUBAGENT_HIDDEN_STATUS_KEYS: readonly string[] = ['subagent-slash', 'subagent-slash-text']
/** pi-subagents commands meant for RPC hosts, never offered to the user. */
export const SUBAGENT_HOST_COMMANDS: readonly string[] = ['subagents-inspect-rpc']
/** Start of pi-subagents' synthetic wake prompt (src/shared/parent-wake.js PARENT_WAKE_TEXT). */
export const SUBAGENT_WAKE_PREFIX = 'Inspect subagent updates above.'
export const SUBAGENT_SUPERVISOR_REPLY_ENTRY = 'subagent_supervisor_reply'
export const SUBAGENT_MESSAGE_TYPES = {
  notify: 'subagent-notify',
  supervisorRequest: 'subagent_supervisor_request',
  controlNotice: 'subagent_control_notice',
  steeringNotice: 'subagent_steering_notice',
  slashResult: 'subagent-slash-result',
  slashText: 'subagent-slash-text-result',
  completionUnanswered: 'subagent-completion-unanswered',
  completionUnhandled: 'subagent-completion-unhandled',
  supervisorUnanswered: 'subagent-supervisor-unanswered',
  supervisorBlocked: 'subagent-supervisor-blocked',
  waitSubscription: 'subagent-wait-subscription',
  incrementalChildNotify: 'subagent-incremental-child-notify',
  watchdogWarning: 'subagent_watchdog_warning',
  watchdogClarification: 'subagent_watchdog_clarification',
  compactionResume: 'subagent-compaction-resume'
} as const
export type SubagentMessageType = (typeof SUBAGENT_MESSAGE_TYPES)[keyof typeof SUBAGENT_MESSAGE_TYPES]

const MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(SUBAGENT_MESSAGE_TYPES))

export function isSubagentMessageType(customType: string): customType is SubagentMessageType {
  return MESSAGE_TYPES.has(customType)
}

// ─── Async status snapshot (`subagent-async` widget) ─────────────────────────────────────────────

export type SubagentRunState = 'queued' | 'running' | 'complete' | 'failed' | 'partial' | 'paused' | 'stopped' | 'rejected'
export interface SubagentSnapshotActivity {
  state?: string
  currentTool?: string
  lastActivityAt?: number
  currentToolStartedAt?: number
  turnCount?: number
  toolCount?: number
}
export interface SubagentSnapshotNode {
  id: string
  kind: 'subagent' | 'workflow' | 'step' | 'host-step'
  label: string
  state: SubagentRunState
  startedAt?: number
  updatedAt?: number
  endedAt?: number
  activity?: SubagentSnapshotActivity
  children?: SubagentSnapshotNode[]
}
export interface SubagentAsyncSnapshot {
  kind: 'pi-subagents.async-status-snapshot'
  version: 1
  generatedAt: number
  omitted: { runs: number; children: number; byteLimitExceeded: boolean }
  runs: SubagentSnapshotNode[]
}

const RUN_STATES: readonly SubagentRunState[] = ['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']
const NODE_KINDS: readonly SubagentSnapshotNode['kind'][] = ['subagent', 'workflow', 'step', 'host-step']

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function isSubagentRunState(value: unknown): value is SubagentRunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value)
}

/** The JSON object after `prefix` on the first line that carries it (widgets arrive as one line). */
function prefixedJson(lines: readonly string[] | undefined, prefix: string): JsonRecord | null {
  const line = lines?.find((candidate) => candidate.trimStart().startsWith(prefix))
  if (line === undefined) return null
  try {
    const value: unknown = JSON.parse(line.trimStart().slice(prefix.length))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function parseActivity(value: unknown): SubagentSnapshotActivity | undefined {
  if (!isRecord(value)) return undefined
  const activity: SubagentSnapshotActivity = {
    state: stringField(value, 'state'),
    currentTool: stringField(value, 'currentTool'),
    lastActivityAt: numberField(value, 'lastActivityAt'),
    currentToolStartedAt: numberField(value, 'currentToolStartedAt'),
    turnCount: numberField(value, 'turnCount'),
    toolCount: numberField(value, 'toolCount')
  }
  return activity
}

function parseNode(value: unknown): SubagentSnapshotNode | null {
  if (!isRecord(value)) return null
  const id = stringField(value, 'id')
  const kind = stringField(value, 'kind')
  const state = value.state
  if (!id || !kind || !(NODE_KINDS as readonly string[]).includes(kind) || !isSubagentRunState(state)) return null
  const children = Array.isArray(value.children) ? value.children.map(parseNode).filter((child): child is SubagentSnapshotNode => child !== null) : undefined
  return {
    id,
    kind: kind as SubagentSnapshotNode['kind'],
    label: stringField(value, 'label') ?? kind,
    state,
    startedAt: numberField(value, 'startedAt'),
    updatedAt: numberField(value, 'updatedAt'),
    endedAt: numberField(value, 'endedAt'),
    activity: parseActivity(value.activity),
    children: children?.length ? children : undefined
  }
}

export function parseAsyncSnapshot(lines: readonly string[] | undefined): SubagentAsyncSnapshot | null {
  const value = prefixedJson(lines, SUBAGENT_ASYNC_PREFIX)
  if (!value || value.kind !== 'pi-subagents.async-status-snapshot' || value.version !== 1 || !Array.isArray(value.runs)) return null
  const omitted = isRecord(value.omitted) ? value.omitted : {}
  return {
    kind: 'pi-subagents.async-status-snapshot',
    version: 1,
    generatedAt: numberField(value, 'generatedAt') ?? 0,
    omitted: {
      runs: numberField(omitted, 'runs') ?? 0,
      children: numberField(omitted, 'children') ?? 0,
      byteLimitExceeded: omitted.byteLimitExceeded === true
    },
    runs: value.runs.map(parseNode).filter((node): node is SubagentSnapshotNode => node !== null)
  }
}

// ─── Inspect replies (`subagent-inspect` widget) ─────────────────────────────────────────────────

export interface SubagentInspectRequest {
  asyncId: string
  childId?: string
  lines?: number
}
export interface SubagentInspectMessage {
  role: string
  kind: 'text' | 'toolCall' | 'toolResult'
  text: string
  name?: string
  isError?: boolean
}
export type SubagentInspectErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'foreign_session'
  | 'stale'
  | 'no_active_session'
  | 'internal'
  | 'unavailable'
  | 'timeout'
export interface SubagentInspectReply {
  requestId: string
  asyncId?: string
  childId?: string
  status?: SubagentRunState
  label?: string
  task?: string
  messages?: SubagentInspectMessage[]
  finalOutput?: string
  truncated?: { task: boolean; messages: number; finalOutput: boolean }
  error?: { code: SubagentInspectErrorCode; message: string }
}

const INSPECT_ERROR_CODES: readonly SubagentInspectErrorCode[] = [
  'invalid_request',
  'not_found',
  'foreign_session',
  'stale',
  'no_active_session',
  'internal',
  'unavailable',
  'timeout'
]
const MESSAGE_KINDS: readonly SubagentInspectMessage['kind'][] = ['text', 'toolCall', 'toolResult']

function parseInspectMessage(value: unknown): SubagentInspectMessage | null {
  if (!isRecord(value)) return null
  const kind = stringField(value, 'kind')
  const text = stringField(value, 'text')
  if (!kind || !(MESSAGE_KINDS as readonly string[]).includes(kind) || text === undefined) return null
  return {
    role: stringField(value, 'role') ?? 'assistant',
    kind: kind as SubagentInspectMessage['kind'],
    text,
    name: stringField(value, 'name'),
    isError: value.isError === true ? true : undefined
  }
}

export function parseInspectReply(lines: readonly string[] | undefined): SubagentInspectReply | null {
  const value = prefixedJson(lines, SUBAGENT_INSPECT_PREFIX)
  if (!value || value.kind !== 'pi-subagents.inspect-reply' || value.version !== 1) return null
  const requestId = stringField(value, 'requestId')
  if (!requestId) return null
  const reply: SubagentInspectReply = { requestId }
  reply.asyncId = stringField(value, 'asyncId')
  reply.childId = stringField(value, 'childId')
  if (isSubagentRunState(value.status)) reply.status = value.status
  reply.label = stringField(value, 'label')
  reply.task = stringField(value, 'task')
  if (Array.isArray(value.messages)) {
    reply.messages = value.messages.map(parseInspectMessage).filter((message): message is SubagentInspectMessage => message !== null)
  }
  reply.finalOutput = stringField(value, 'finalOutput')
  if (isRecord(value.truncated)) {
    reply.truncated = {
      task: value.truncated.task === true,
      messages: numberField(value.truncated, 'messages') ?? 0,
      finalOutput: value.truncated.finalOutput === true
    }
  }
  if (isRecord(value.error)) {
    const code = stringField(value.error, 'code')
    reply.error = {
      code: code && (INSPECT_ERROR_CODES as readonly string[]).includes(code) ? (code as SubagentInspectErrorCode) : 'internal',
      message: stringField(value.error, 'message') ?? ''
    }
  }
  return reply
}

// ─── subagent-notify ─────────────────────────────────────────────────────────────────────────────

export interface SubagentNotifyRun {
  agent: string
  status: string
  runId: string
  durationMs?: number
}
export interface SubagentNotifyDetails {
  runs: SubagentNotifyRun[]
}

export function asNotifyDetails(details: unknown): SubagentNotifyDetails | null {
  if (!isRecord(details) || !Array.isArray(details.runs)) return null
  const runs = details.runs.flatMap((run): SubagentNotifyRun[] => {
    if (!isRecord(run)) return []
    const runId = stringField(run, 'runId')
    const agent = stringField(run, 'agent')
    const status = stringField(run, 'status')
    if (!runId || !agent || !status) return []
    return [{ agent, status, runId, durationMs: numberField(run, 'durationMs') }]
  })
  return runs.length ? { runs } : null
}

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** `1800000` → `30m`, `5400000` → `1h 30m`, `45000` → `45s`. */
export function formatSubagentDuration(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND)
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const rest = minutes % MINUTES_PER_HOUR
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** Paragraphs of a notify message that are instructions or locations for the model, never shown. */
const NOTIFY_TRAILERS = /\n(?:…\n)?(?:Full output:|\n?Retention-managed async directory:|\n?Session file:|\n?Parent action:)/

/** The failure paragraph, shortened to the human reason (`Subagent timed out after 1800000ms.` → `timed out after 30m`). */
function failureReason(paragraph: string): string {
  const timedOut = /timed out after (\d+)\s*ms/i.exec(paragraph)
  if (timedOut) return `timed out after ${formatSubagentDuration(Number(timedOut[1]))}`
  const sentence = paragraph.split('\n')[0]!.replace(/^Subagent\s+/i, '').replace(/\.$/, '')
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

/** Split a subagent-notify content string into the human parts; ids/paths/instructions dropped. */
export function parseNotifyContent(text: string): { failed: boolean; agent?: string; summary: string; outputPath?: string; reason?: string } {
  const header = /^Background task (completed|failed):\s*\*\*(.+?)\*\*/.exec(text)
  const failed = header ? header[1] === 'failed' : /^Background task failed/.test(text)
  const agent = header?.[2]
  const outputPath = /Full output:\s*(.+?)\s+\(\d/.exec(text)?.[1]
  const body = (header ? text.slice(header[0].length) : text).replace(/^\s+/, '')
  const trailer = NOTIFY_TRAILERS.exec(`\n${body}`)
  let summary = (trailer ? `\n${body}`.slice(0, trailer.index) : `\n${body}`).trim()
  if (agent && summary.startsWith(`${agent}:\n`)) summary = summary.slice(agent.length + 2).trim()
  summary = summary.replace(/\n…$/, '').trim()
  if (!failed) return { failed, agent, summary, outputPath }
  return { failed, agent, summary, outputPath, reason: summary ? failureReason(summary) : undefined }
}

// ─── Supervisor requests ─────────────────────────────────────────────────────────────────────────

export interface SubagentSupervisorRequest {
  requestId: string
  reason: string
  expectsReply: boolean
  runId: string
  agent: string
  childIndex?: number
  requestBody: string
}

export function asSupervisorRequest(details: unknown): SubagentSupervisorRequest | null {
  if (!isRecord(details)) return null
  const requestId = stringField(details, 'requestId') ?? stringField(details, 'id')
  const runId = stringField(details, 'runId')
  const agent = stringField(details, 'agent')
  const requestBody = stringField(details, 'requestBody')
  if (!requestId || !runId || !agent || requestBody === undefined) return null
  return {
    requestId,
    reason: stringField(details, 'reason') ?? 'need_decision',
    expectsReply: details.expectsReply !== false,
    runId,
    agent,
    childIndex: numberField(details, 'childIndex'),
    requestBody
  }
}

const REPLY_PROMPT = /^Reply to subagent request (\S+) from (\S+) with exactly this message \(use subagent_supervisor reply\):\n\n([\s\S]*)$/

/** The parent-model prompt that carries a user's reply to a supervisor request. */
export function supervisorReplyPrompt(request: Pick<SubagentSupervisorRequest, 'requestId' | 'agent'>, message: string): string {
  return `Reply to subagent request ${request.requestId} from ${request.agent} with exactly this message (use subagent_supervisor reply):\n\n${message}`
}

export function parseSupervisorReplyPrompt(text: string): { requestId: string; agent: string; message: string } | null {
  const match = REPLY_PROMPT.exec(text)
  if (!match) return null
  return { requestId: match[1]!, agent: match[2]!, message: match[3]! }
}

// ─── Control notices ─────────────────────────────────────────────────────────────────────────────

export interface SubagentControlEvent {
  type: string
  message: string
  runId: string
  agent: string
  index?: number
  turns?: number
  tokens?: number
  toolCount?: number
  currentTool?: string
  currentToolDurationMs?: number
}

export function asControlEvent(details: unknown): SubagentControlEvent | null {
  if (!isRecord(details) || !isRecord(details.event)) return null
  const event = details.event
  const type = stringField(event, 'type')
  const message = stringField(event, 'message')
  const runId = stringField(event, 'runId')
  const agent = stringField(event, 'agent')
  if (!type || !message || !runId || !agent) return null
  return {
    type,
    message,
    runId,
    agent,
    index: numberField(event, 'index'),
    turns: numberField(event, 'turns'),
    tokens: numberField(event, 'tokens'),
    toolCount: numberField(event, 'toolCount'),
    currentTool: stringField(event, 'currentTool'),
    currentToolDurationMs: numberField(event, 'currentToolDurationMs')
  }
}
