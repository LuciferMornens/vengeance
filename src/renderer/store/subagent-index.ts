import type { AgentMessage, SessionEntry, ToolResultPayload } from '@shared/engine-types'
import {
  asControlEvent,
  asNotifyDetails,
  asSupervisorRequest,
  isSubagentRunState,
  parseAsyncSnapshot,
  parseNotifyContent,
  parseSupervisorReplyPrompt,
  SUBAGENT_MESSAGE_TYPES,
  SUBAGENT_SUPERVISOR_REPLY_ENTRY,
  type SubagentRunState
} from '@shared/subagents'
import type { SubagentRunRecord, SubagentsState, ToolExecution } from './agent-state'

/**
 * Pure index of pi-subagents runs for one agent, fed by the reducer: launch/resume tool results, the async
 * snapshot widget, notify/control/supervisor custom messages and supervisor answers. The snapshot drops runs
 * 10 s after they end, so this index is what the fleet and the transcript read once a run is gone.
 */

const SUBAGENT_TOOL = 'subagent'
const SUPERVISOR_TOOL = 'subagent_supervisor'

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function upsertRun(state: SubagentsState, runId: string, base: () => SubagentRunRecord, patch: Partial<SubagentRunRecord>): SubagentsState {
  const current = state.runs[runId] ?? base()
  return { ...state, runs: { ...state.runs, [runId]: { ...current, ...patch } } }
}

function resultText(result: ToolResultPayload | undefined): string {
  return result?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? ''
}

/** `completed` / `pending` and other notify words mapped onto snapshot states. */
function normalizeState(status: string): SubagentRunState {
  if (status === 'completed' || status === 'done' || status === 'success') return 'complete'
  if (status === 'pending') return 'queued'
  if (status === 'timeout' || status === 'timed_out' || status === 'error') return 'failed'
  return isSubagentRunState(status) ? status : 'partial'
}

/** The first foreground result (`details.results[0]`), typed loosely: it is pi-subagents' `SingleResult`. */
function firstResult(details: Json): Json | undefined {
  const results = details.results
  return Array.isArray(results) && isRecord(results[0]) ? results[0] : undefined
}

function foregroundOutcome(result: Json): { state: SubagentRunState; durationMs?: number } {
  const progress = isRecord(result.progress) ? result.progress : {}
  const durationMs = typeof progress.durationMs === 'number' ? progress.durationMs : undefined
  const status = str(progress.status)
  if (status === 'running' || status === 'queued') return { state: 'running', durationMs }
  if (typeof result.exitCode === 'number') return { state: result.exitCode === 0 ? 'complete' : 'failed', durationMs }
  return { state: status ? normalizeState(status) : 'complete', durationMs }
}

/**
 * A `subagent` launch or resume result (live: tool_execution_end/update; history: the toolResult message).
 * `partial` is a streamed foreground progress update.
 */
export function indexSubagentToolResult(
  state: SubagentsState,
  call: Pick<ToolExecution, 'toolName' | 'args'>,
  result: ToolResultPayload | undefined,
  at: number,
  partial = false
): SubagentsState {
  if (call.toolName === SUPERVISOR_TOOL) return partial ? state : answerFromSupervisorTool(state, call.args, result)
  if (call.toolName !== SUBAGENT_TOOL || !isRecord(result?.details)) return state
  const details = result.details
  const args = call.args
  const action = str(args.action)
  const first = firstResult(details)
  const runId = str(details.runId) ?? str(details.asyncId) ?? str(first?.runId)
  if (!runId) return state

  if (action === 'resume') {
    const source = str(args.id)
    const previous = source ? state.runs[source] : undefined
    const label = previous?.label ?? /^Agent: (.+)$/m.exec(resultText(result))?.[1]?.trim() ?? 'agent'
    return upsertRun(state, runId, () => ({ runId, label, kind: previous?.kind ?? 'subagent' }), {
      resumedFrom: source,
      task: previous?.task,
      model: previous?.model,
      launchedAt: at
    })
  }
  if (action !== undefined) return state

  const workflow = args.workflow !== undefined
  const label = str(args.agent) ?? str(first?.agent) ?? (workflow ? 'workflow' : 'agent')
  const base = (): SubagentRunRecord => ({ runId, label, kind: workflow ? 'workflow' : 'subagent' })
  const patch: Partial<SubagentRunRecord> = {
    task: str(args.task) ?? str(first?.task),
    model: str(args.model) ?? str(first?.model),
    outputFile: str(args.output),
    // A saved workflow launched by name (`workflow: "review-chain"`) is titled by that name.
    title: str(first?.sessionName) ?? str(args.workflow),
    launchedAt: state.runs[runId]?.launchedAt ?? at
  }
  const foreground = !str(details.asyncId) && first !== undefined
  if (!foreground) return upsertRun(state, runId, base, patch)
  if (partial) return upsertRun(state, runId, base, { ...patch, foregroundState: 'running' })
  const outcome = foregroundOutcome(first)
  const summary = str(first.finalOutput)
  return upsertRun(state, runId, base, {
    ...patch,
    foregroundState: outcome.state,
    final: { state: outcome.state, at, durationMs: outcome.durationMs, summary, reason: outcome.state === 'failed' ? str(first.error) : undefined }
  })
}

function answer(state: SubagentsState, requestId: string | undefined): SubagentsState {
  if (!requestId) return state
  const current = state.requests[requestId]
  if (!current || current.state === 'answered') return state
  return { ...state, requests: { ...state.requests, [requestId]: { ...current, state: 'answered' } } }
}

function answerFromSupervisorTool(state: SubagentsState, args: Json, result: ToolResultPayload | undefined): SubagentsState {
  if (!result || str(args.action) !== 'reply') return state
  return answer(state, str(args.replyTo))
}

function messageText(message: AgentMessage): string {
  if (message.role !== 'user' && message.role !== 'custom') return ''
  const content = message.content
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** Custom subagent messages and user replies to supervisor requests. `at` is when the message arrived. */
export function indexSubagentMessage(state: SubagentsState, message: AgentMessage, at: number): SubagentsState {
  if (message.role === 'user') {
    return answer(state, parseSupervisorReplyPrompt(messageText(message))?.requestId)
  }
  if (message.role !== 'custom') return state
  switch (message.customType) {
    case SUBAGENT_MESSAGE_TYPES.notify:
      return indexNotify(state, message.details, messageText(message), at)
    case SUBAGENT_MESSAGE_TYPES.supervisorRequest: {
      const request = asSupervisorRequest(message.details)
      if (!request || state.requests[request.requestId]) return state
      const withRun = upsertRun(state, request.runId, () => ({ runId: request.runId, label: request.agent, kind: 'subagent' }), {})
      return { ...withRun, requests: { ...withRun.requests, [request.requestId]: { request, state: 'pending', receivedAt: at } } }
    }
    case SUBAGENT_MESSAGE_TYPES.controlNotice: {
      const event = asControlEvent(message.details)
      if (!event) return state
      return upsertRun(state, event.runId, () => ({ runId: event.runId, label: event.agent, kind: 'subagent' }), { attention: event.message })
    }
    default:
      return state
  }
}

function indexNotify(state: SubagentsState, details: unknown, content: string, at: number): SubagentsState {
  const notify = asNotifyDetails(details)
  if (!notify) return state
  const parsed = parseNotifyContent(content)
  let next = state
  for (const run of notify.runs) {
    // Summary and output path describe the run the message is about; a batch notice lists several.
    const own = notify.runs.length === 1 || parsed.agent === run.agent
    next = upsertRun(next, run.runId, () => ({ runId: run.runId, label: run.agent, kind: 'subagent' }), {
      final: {
        state: normalizeState(run.status),
        at,
        durationMs: run.durationMs,
        summary: own ? parsed.summary || undefined : undefined,
        outputPath: own ? parsed.outputPath : undefined,
        reason: own ? parsed.reason : undefined
      }
    })
  }
  return next
}

/** A `subagent_supervisor_reply` session entry (the parent model answered). */
export function indexSubagentEntry(state: SubagentsState, entry: SessionEntry): SubagentsState {
  if (entry.type !== 'custom' || entry.customType !== SUBAGENT_SUPERVISOR_REPLY_ENTRY || !isRecord(entry.data)) return state
  return answer(state, str(entry.data.requestId))
}

/** `subagent-async` widget lines (undefined = retracted: no active runs). Runs are remembered after they leave. */
export function applySubagentSnapshot(state: SubagentsState, lines: string[] | undefined, at: number): SubagentsState {
  const snapshot = lines ? parseAsyncSnapshot(lines) : null
  if (lines && !snapshot) return state
  if (!snapshot) return { ...state, snapshot: null, snapshotAt: at }
  const runs = { ...state.runs }
  for (const node of snapshot.runs) {
    const current = runs[node.id] ?? { runId: node.id, label: node.label, kind: node.kind === 'workflow' ? 'workflow' : 'subagent' }
    runs[node.id] = { ...current, node }
  }
  return { ...state, snapshot, snapshotAt: at, runs }
}

/**
 * Rebuild the transcript-derived part of the index from a full message list (resume / refresh). The live
 * snapshot and remembered nodes are kept; everything from history counts as already seen.
 */
export function indexSubagentHistory(previous: SubagentsState, messages: AgentMessage[], tools: Record<string, ToolExecution>): SubagentsState {
  let state: SubagentsState = { snapshot: previous.snapshot, snapshotAt: previous.snapshotAt, runs: {}, requests: {}, seen: {} }
  for (const message of messages) {
    const at = message.timestamp
    if (message.role === 'toolResult') {
      const call = tools[message.toolCallId]
      if (call && !message.isError) state = indexSubagentToolResult(state, call, { content: message.content, details: message.details }, at)
    } else {
      state = indexSubagentMessage(state, message, at)
    }
  }
  const runs = { ...state.runs }
  for (const [runId, node] of Object.entries(previous.runs).flatMap(([id, run]) => (run.node ? [[id, run.node] as const] : []))) {
    if (runs[runId]) runs[runId] = { ...runs[runId], node }
  }
  for (const node of previous.snapshot?.runs ?? []) {
    runs[node.id] ??= { runId: node.id, label: node.label, kind: node.kind === 'workflow' ? 'workflow' : 'subagent', node }
  }
  const seen: Record<string, true> = { ...previous.seen }
  for (const run of Object.values(runs)) if (run.final) seen[run.runId] = true
  return { ...state, runs, seen }
}
