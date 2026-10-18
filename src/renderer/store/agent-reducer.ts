import { BRIDGE_STATUS_PREFIX } from '@shared/api/engine'
import { isSpeedMode, SPEED_STATUS_KEY, type SpeedOption, type SpeedState } from '@shared/api/speed'
import {
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_HIDDEN_STATUS_KEYS,
  SUBAGENT_INSPECT_WIDGET_KEY
} from '@shared/subagents'
import {
  EXTENSION_UI_DIALOG_METHODS,
  type AgentMessage,
  type AssistantMessage,
  type BashExecutionMessage,
  type EngineEvent,
  type ExtensionUIDialogRequest,
  type RpcExtensionUIRequest,
  type RpcSessionState,
  type ToolCall,
  type ToolResultMessage
} from '@shared/engine-types'
import { isMachinePayload } from '../lib/machine-payload'
import { parsePartialJson } from '../lib/partial-json'
import type {
  AgentState,
  BashRun,
  ExtensionUiState,
  StreamingMessage,
  ToolExecution,
  TranscriptEntry
} from './agent-state'
import { createSubagentsState } from './agent-state'
import {
  applySubagentSnapshot,
  indexSubagentEntry,
  indexSubagentMessage,
  indexSubagentToolResult
} from './subagent-index'

let keyCounter = 0
export function nextEntryKey(): string {
  keyCounter += 1
  return `m${keyCounter}`
}

const MAX_NOTIFICATIONS = 30
const MAX_APPENDED = 200
/** Finished `!command` runs kept while their messages have not reached the transcript yet. */
export const MAX_BASH_RUNS = 50

/** True once the transcript holds this run's `bashExecution` message (same command, not older than the run). */
export function bashRunLanded(run: BashRun, entries: TranscriptEntry[]): boolean {
  return entries.some(
    (e) =>
      e.message.role === 'bashExecution' &&
      e.message.command === run.command &&
      e.message.timestamp >= run.startedAt - 1000
  )
}

/**
 * N19: bound `agent.bash`. Finished runs are dropped once their `bashExecution` message has landed in the
 * transcript, and at most MAX_BASH_RUNS finished runs are kept (oldest go first); running ones always stay.
 */
export function pruneBashRuns(
  bash: Record<string, BashRun>,
  entries: TranscriptEntry[]
): Record<string, BashRun> {
  const runs = Object.values(bash)
  if (runs.length === 0) return bash
  const landed = entries.filter((e) => e.message.role === 'bashExecution')
  const kept = runs.filter((run) => run.running || !bashRunLanded(run, landed))
  const finished = kept.filter((run) => !run.running).sort((a, b) => a.startedAt - b.startedAt)
  const evicted = new Set(
    finished.slice(0, Math.max(0, finished.length - MAX_BASH_RUNS)).map((run) => run.id)
  )
  const next = kept.filter((run) => !evicted.has(run.id))
  return next.length === runs.length ? bash : Object.fromEntries(next.map((run) => [run.id, run]))
}

function bashRunMessage(
  run: BashRun,
  result: NonNullable<BashRun['result']>
): BashExecutionMessage {
  return {
    role: 'bashExecution',
    command: run.command,
    output: result.output,
    exitCode: result.exitCode,
    cancelled: result.cancelled,
    truncated: result.truncated,
    fullOutputPath: result.fullOutputPath,
    excludeFromContext: run.excludeFromContext,
    timestamp: Date.now()
  }
}

/**
 * Append finished `!command` runs to the transcript. The Engine records a user run without a message event:
 * right away while idle, or when the current run ends (just before agent_settled) while one is active. Both
 * put it at the end of the session, so the end of the transcript is where it belongs.
 */
export function landBashRuns(state: AgentState): AgentState {
  const finished = Object.values(state.bash)
    .filter((run) => !run.running && run.result && !bashRunLanded(run, state.entries))
    .sort((a, b) => a.startedAt - b.startedAt)
  if (finished.length === 0) return state
  const entries = [
    ...state.entries,
    ...finished.map((run) => ({ key: nextEntryKey(), message: bashRunMessage(run, run.result!) }))
  ]
  return { ...state, entries, bash: pruneBashRuns(state.bash, entries) }
}

function upsertTool(
  tools: Record<string, ToolExecution>,
  id: string,
  patch: Partial<ToolExecution> & { toolName: string },
  owned = false
): Record<string, ToolExecution> {
  const current = tools[id]
  const next: ToolExecution = current
    ? { ...current, ...patch }
    : { toolCallId: id, args: {}, status: 'pending', isError: false, ...patch }
  const updated = owned ? tools : { ...tools }
  updated[id] = next
  return updated
}

/** Register tool calls of a completed assistant message and results of tool-result messages. */
function indexMessage(
  tools: Record<string, ToolExecution>,
  message: AgentMessage,
  owned = false
): Record<string, ToolExecution> {
  let next = tools
  if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue
      const existing = next[block.id]
      next = upsertTool(
        next,
        block.id,
        {
          toolName: block.name,
          args: block.arguments,
          status: existing && existing.status !== 'streaming' ? existing.status : 'pending'
        },
        owned || next !== tools
      )
    }
  } else if (message.role === 'toolResult') {
    next = applyToolResult(next, message, owned)
  }
  return next
}

function applyToolResult(
  tools: Record<string, ToolExecution>,
  message: ToolResultMessage,
  owned: boolean
): Record<string, ToolExecution> {
  const existing = tools[message.toolCallId]
  return upsertTool(
    tools,
    message.toolCallId,
    {
      toolName: message.toolName,
      status: message.isError ? 'error' : 'done',
      isError: message.isError,
      interrupted: false,
      partialResult: undefined,
      // Share committed content with the transcript instead of keeping the IPC event's copy.
      result: { content: message.content, details: message.details },
      durationMs: message.durationMs ?? existing?.durationMs
    },
    owned
  )
}

const INTERRUPTED_RESULT = {
  content: [{ type: 'text' as const, text: 'Interrupted' }],
  details: undefined
}

/**
 * Settle tools that can no longer finish (aborted mid-stream, crashed, or resumed without a result):
 * they become `error` with an "Interrupted" result and `interrupted: true`, so they never look active.
 */
function interruptOpenTools(tools: Record<string, ToolExecution>): Record<string, ToolExecution> {
  let next = tools
  for (const [id, tool] of Object.entries(tools)) {
    if (tool.status !== 'streaming' && tool.status !== 'pending' && tool.status !== 'running')
      continue
    if (next === tools) next = { ...tools }
    next[id] = {
      ...tool,
      status: 'error',
      isError: true,
      interrupted: true,
      result: tool.result ?? INTERRUPTED_RESULT
    }
  }
  return next
}

/**
 * Build transcript entries + tool index from a full message list (get_messages / resume).
 * `settled`: the engine is idle, so tools without a result were interrupted.
 */
export function hydrateMessages(
  messages: AgentMessage[],
  settled = true
): { entries: TranscriptEntry[]; tools: Record<string, ToolExecution> } {
  let tools: Record<string, ToolExecution> = {}
  const entries: TranscriptEntry[] = []
  for (const message of messages) {
    entries.push({ key: nextEntryKey(), message })
    // This dictionary is private until hydration finishes; copying it per tool is quadratic.
    tools = indexMessage(tools, message, true)
  }
  return { entries, tools: settled ? interruptOpenTools(tools) : tools }
}

function applyNativeSnapshot(state: AgentState, data: Record<string, unknown>): AgentState {
  if (!Array.isArray(data.messages) || typeof data.state !== 'object' || !data.state) return state
  // The native adapter normalizes this IPC envelope to the common message and session contracts.
  const messages = data.messages as AgentMessage[]
  const session = data.state as RpcSessionState
  const busy = session.isStreaming || session.isCompacting || data.isBashRunning === true
  const { entries, tools } = hydrateMessages(messages, !busy)
  // Committed rows retain their creation timestamp across attachments. Stable prefix keys keep
  // virtual-list measurements and the user's scroll position while authoritative content replaces it.
  for (let index = 0; index < Math.min(entries.length, state.entries.length); index++) {
    const previous = state.entries[index]!
    const next = entries[index]!
    if (
      previous.message.role !== next.message.role ||
      previous.message.timestamp !== next.message.timestamp
    )
      break
    if (
      previous.message.role === 'toolResult' &&
      next.message.role === 'toolResult' &&
      previous.message.toolCallId !== next.message.toolCallId
    )
      break
    next.key = previous.key
  }
  for (const [toolCallId, tool] of Object.entries(tools)) {
    const previous = state.tools[toolCallId]
    if (!previous) continue
    tools[toolCallId] = {
      ...tool,
      startedAt: previous.startedAt,
      endedAt: previous.endedAt,
      durationMs: tool.durationMs ?? previous.durationMs
    }
  }
  const steering = Array.isArray(data.steering)
    ? data.steering.filter((item): item is string => typeof item === 'string')
    : []
  const followUp = Array.isArray(data.followUp)
    ? data.followUp.filter((item): item is string => typeof item === 'string')
    : []
  return {
    ...state,
    snapshotRevision: state.snapshotRevision + 1,
    entries,
    tools,
    session,
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    sessionName: session.sessionName,
    info: {
      ...state.info,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      lineage: session.lineage,
      busy
    },
    phase: busy ? 'running' : 'idle',
    turnActive: session.isStreaming,
    streaming: null,
    queue: { steering, followUp },
    bash:
      data.isBashRunning === true
        ? Object.fromEntries(Object.entries(state.bash).filter(([, run]) => run.running))
        : {},
    retry: null,
    retryError: undefined,
    summarizationRetry: null,
    compaction: session.isCompacting
      ? (state.compaction ?? { reason: 'manual', startedAt: Date.now() })
      : null,
    lastRunAborted: false,
    liveUsage: undefined,
    stats: undefined,
    appendedEntries: [],
    subagents: createSubagentsState(),
    ext: { ...state.ext, dialogs: [] }
  }
}

function cloneForStreaming(message: AgentMessage): AgentMessage {
  return message.role === 'assistant' ? { ...message, content: [...message.content] } : message
}

function applyAssistantUpdate(
  state: AgentState,
  event: Extract<EngineEvent, { type: 'message_update' }>
): AgentState {
  const streaming = state.streaming
  if (!streaming || streaming.message.role !== 'assistant')
    return { ...state, liveUsage: event.usage }
  const message: AssistantMessage = {
    ...streaming.message,
    content: [...streaming.message.content],
    usage: event.usage
  }
  const next: StreamingMessage = { ...streaming, message }
  let tools = state.tools
  const update = event.assistantMessageEvent
  switch (update.type) {
    case 'text_start':
      message.content[update.contentIndex] = { type: 'text', text: '' }
      break
    case 'text_delta': {
      const block = message.content[update.contentIndex]
      message.content[update.contentIndex] =
        block?.type === 'text'
          ? { ...block, text: block.text + update.delta }
          : { type: 'text', text: update.delta }
      break
    }
    case 'text_end': {
      const block = message.content[update.contentIndex]
      message.content[update.contentIndex] = {
        ...(block?.type === 'text' ? block : {}),
        type: 'text',
        text: update.content
      }
      break
    }
    case 'thinking_start':
      message.content[update.contentIndex] = { type: 'thinking', thinking: '' }
      break
    case 'thinking_delta': {
      const block = message.content[update.contentIndex]
      message.content[update.contentIndex] =
        block?.type === 'thinking'
          ? { ...block, thinking: block.thinking + update.delta }
          : { type: 'thinking', thinking: update.delta }
      break
    }
    case 'thinking_end': {
      const block = message.content[update.contentIndex]
      message.content[update.contentIndex] = {
        ...(block?.type === 'thinking' ? block : {}),
        type: 'thinking',
        thinking: update.content
      }
      break
    }
    case 'toolcall_start': {
      const call: ToolCall = {
        type: 'toolCall',
        id: update.id,
        name: update.toolName,
        arguments: {}
      }
      message.content[update.contentIndex] = call
      next.toolArgsText = { ...streaming.toolArgsText, [update.contentIndex]: '' }
      tools = upsertTool(tools, update.id, {
        toolName: update.toolName,
        status: 'streaming',
        args: {}
      })
      break
    }
    case 'toolcall_delta': {
      const prevText = streaming.toolArgsText[update.contentIndex] ?? ''
      const text = prevText + update.delta
      next.toolArgsText = { ...streaming.toolArgsText, [update.contentIndex]: text }
      const block = message.content[update.contentIndex]
      if (block?.type === 'toolCall') {
        const shouldParse =
          text.length <= 4_096 ||
          Object.keys(block.arguments).length === 0 ||
          Math.floor(text.length / 16_384) !== Math.floor(prevText.length / 16_384)
        const args = shouldParse ? parsePartialJson(text) : block.arguments
        if (args && args !== block.arguments) {
          message.content[update.contentIndex] = { ...block, arguments: args }
        }
        if (args && tools[block.id]?.args !== args) {
          tools = upsertTool(tools, block.id, { toolName: block.name, args })
        }
      }
      break
    }
    case 'toolcall_end': {
      message.content[update.contentIndex] = update.toolCall
      const rest = { ...streaming.toolArgsText }
      delete rest[update.contentIndex]
      next.toolArgsText = rest
      const existing = tools[update.toolCall.id]
      tools = upsertTool(tools, update.toolCall.id, {
        toolName: update.toolCall.name,
        args: update.toolCall.arguments,
        status: existing && existing.status !== 'streaming' ? existing.status : 'pending'
      })
      break
    }
    default:
      // start/done/error are folded into message_start/message_end by the agent loop.
      break
  }
  return { ...state, streaming: next, tools, liveUsage: event.usage }
}

function applyExtensionUi(state: AgentState, request: RpcExtensionUIRequest): AgentState {
  const ext = state.ext
  switch (request.method) {
    case 'select':
    case 'confirm':
    case 'input':
    case 'editor':
      return {
        ...state,
        ext: {
          ...ext,
          dialogs: [
            ...ext.dialogs,
            { request, receivedAt: Date.now(), duringRun: state.phase === 'running' }
          ]
        }
      }
    case 'notify':
      return {
        ...state,
        ext: {
          ...ext,
          notifications: [
            ...ext.notifications,
            {
              id: request.id,
              message: request.message,
              level: request.notifyType ?? 'info',
              at: Date.now()
            }
          ].slice(-MAX_NOTIFICATIONS)
        }
      }
    case 'setStatus': {
      if (request.statusKey === SPEED_STATUS_KEY)
        return { ...state, speed: parseSpeedStatus(request.statusText) }
      // Bridge replies are consumed by the main process (engine:bridge); subagent slash progress is TUI-only.
      if (
        request.statusKey.startsWith(BRIDGE_STATUS_PREFIX) ||
        SUBAGENT_HIDDEN_STATUS_KEYS.includes(request.statusKey)
      )
        return state
      const statuses = { ...ext.statuses }
      delete statuses[request.statusKey]
      const machine = withoutKey(ext.machine, request.statusKey)
      if (request.statusText === undefined) return { ...state, ext: { ...ext, statuses, machine } }
      if (isMachinePayload([request.statusText]))
        return {
          ...state,
          ext: {
            ...ext,
            statuses,
            machine: {
              ...machine,
              [request.statusKey]: { lines: [request.statusText], at: Date.now() }
            }
          }
        }
      return {
        ...state,
        ext: { ...ext, statuses: { ...statuses, [request.statusKey]: request.statusText }, machine }
      }
    }
    case 'setWidget': {
      // The inspect reply is consumed by the main process (engine:subagents-inspect); emit-then-retract is a no-op here.
      if (request.widgetKey === SUBAGENT_INSPECT_WIDGET_KEY) return state
      if (request.widgetKey === SUBAGENT_ASYNC_WIDGET_KEY) {
        // The fleet reads the parsed snapshot; the raw lines stay inspectable as machine data, never as a widget.
        const at = Date.now()
        const lines = request.widgetLines
        const machine = lines
          ? { ...ext.machine, [request.widgetKey]: { lines, at } }
          : withoutKey(ext.machine, request.widgetKey)
        return {
          ...state,
          ext: { ...ext, machine },
          subagents: applySubagentSnapshot(state.subagents, lines, at)
        }
      }
      return {
        ...state,
        ext: applyWidget(ext, request.widgetKey, request.widgetLines, request.widgetPlacement)
      }
    }
    case 'setTitle':
      return { ...state, ext: { ...ext, title: request.title } }
    case 'set_editor_text':
      return {
        ...state,
        ext: { ...ext, editorText: { text: request.text, nonce: (ext.editorText?.nonce ?? 0) + 1 } }
      }
    default:
      return state
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

function applyWidget(
  ext: ExtensionUiState,
  key: string,
  lines: string[] | undefined,
  placement: 'aboveEditor' | 'belowEditor' | undefined
): ExtensionUiState {
  const widgets = withoutKey(ext.widgets, key)
  const machine = withoutKey(ext.machine, key)
  if (!lines) return { ...ext, widgets, machine }
  if (isMachinePayload(lines))
    return { ...ext, widgets, machine: { ...machine, [key]: { lines, at: Date.now() } } }
  return {
    ...ext,
    widgets: { ...widgets, [key]: { lines, placement: placement ?? 'aboveEditor' } },
    machine
  }
}

function isSpeedOption(value: unknown): value is SpeedOption {
  if (typeof value !== 'object' || value === null) return false
  const { mode, costMultiplier, description } = value as Record<keyof SpeedOption, unknown>
  return (
    isSpeedMode(mode) &&
    mode !== 'standard' &&
    (costMultiplier === undefined || Number.isFinite(costMultiplier)) &&
    (description === undefined || typeof description === 'string')
  )
}

/** The bridge's `SpeedState` status payload; a cleared or malformed one hides the speed control. */
function parseSpeedStatus(text: string | undefined): SpeedState | undefined {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const { requested, effective, options } = value as Partial<SpeedState>
    if (!isSpeedMode(requested) || !isSpeedMode(effective) || !Array.isArray(options))
      return undefined
    return options.every(isSpeedOption) ? (value as SpeedState) : undefined
  } catch {
    return undefined
  }
}

export function isDialogRequest(
  request: RpcExtensionUIRequest
): request is ExtensionUIDialogRequest {
  return (EXTENSION_UI_DIALOG_METHODS as readonly string[]).includes(request.method)
}

/**
 * Pure event reducer for one agent (json.md semantics). Unknown event types are ignored so newer
 * engines never break the UI.
 */
export function reduceAgentEvent(state: AgentState, event: EngineEvent): AgentState {
  const s: AgentState = { ...state, lastEventAt: Date.now() }
  switch (event.type) {
    case 'engine_native_event':
      return state.info.engine === 'prime' &&
        event.engine === 'prime' &&
        event.name === 'session_snapshot'
        ? applyNativeSnapshot(s, event.data)
        : s
    case 'agent_start':
      return { ...s, phase: 'running', lastRunAborted: false, retryError: undefined }
    case 'agent_end':
      return s
    case 'agent_settled':
      return landBashRuns({
        ...s,
        phase: 'idle',
        turnActive: false,
        retry: null,
        lastRunAborted: event.aborted,
        liveUsage: undefined,
        tools: interruptOpenTools(s.tools),
        // An aborted run aborts the signal its hooks and tools handed to their dialogs, and the Engine resolves
        // those dialogs itself without telling the client.
        ext: event.aborted
          ? { ...s.ext, dialogs: s.ext.dialogs.filter((dialog) => !dialog.duringRun) }
          : s.ext
      })
    case 'turn_start':
      return { ...s, turnActive: true }
    case 'turn_end':
      return { ...s, turnActive: false }
    case 'message_start':
      return {
        ...s,
        streaming: {
          key: nextEntryKey(),
          message: cloneForStreaming(event.message),
          toolArgsText: {}
        }
      }
    case 'message_update':
      return applyAssistantUpdate(s, event)
    case 'message_end': {
      const key = s.streaming?.key ?? nextEntryKey()
      const entries = [...s.entries, { key, message: event.message }]
      const tools = indexMessage(s.tools, event.message)
      return {
        ...s,
        streaming: null,
        entries,
        tools,
        bash: event.message.role === 'bashExecution' ? pruneBashRuns(s.bash, entries) : s.bash,
        subagents: indexSubagentMessage(s.subagents, event.message, Date.now())
      }
    }
    case 'tool_execution_start':
      return {
        ...s,
        tools: upsertTool(s.tools, event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
          status: 'running',
          startedAt: Date.now(),
          parentToolCallId: event.parentToolCallId
        })
      }
    case 'tool_execution_update':
      return {
        ...s,
        tools: upsertTool(s.tools, event.toolCallId, {
          toolName: event.toolName,
          partialResult: event.partialResult,
          status: 'running'
        }),
        subagents: indexSubagentToolResult(
          s.subagents,
          { toolName: event.toolName, args: event.args },
          event.partialResult,
          Date.now(),
          true
        )
      }
    case 'tool_execution_end':
      return {
        ...s,
        subagents: event.isError
          ? s.subagents
          : indexSubagentToolResult(
              s.subagents,
              { toolName: event.toolName, args: s.tools[event.toolCallId]?.args ?? {} },
              event.result,
              Date.now()
            ),
        tools: upsertTool(s.tools, event.toolCallId, {
          toolName: event.toolName,
          result: event.result,
          partialResult: undefined,
          isError: event.isError,
          interrupted: false,
          status: event.isError ? 'error' : 'done',
          endedAt: Date.now(),
          durationMs: event.durationMs
        })
      }
    case 'queue_update':
      return { ...s, queue: { steering: [...event.steering], followUp: [...event.followUp] } }
    case 'compaction_start':
      return { ...s, compaction: { reason: event.reason, startedAt: Date.now() } }
    case 'compaction_end': {
      const outcome = {
        reason: event.reason,
        result: event.result,
        aborted: event.aborted,
        errorMessage: event.errorMessage,
        at: Date.now()
      }
      const entries = event.result
        ? [
            ...s.entries,
            {
              key: nextEntryKey(),
              message: {
                role: 'compactionSummary' as const,
                summary: event.result.summary,
                tokensBefore: event.result.tokensBefore,
                timestamp: Date.now()
              }
            }
          ]
        : s.entries
      return { ...s, compaction: null, lastCompaction: outcome, entries }
    }
    case 'entry_appended':
      return {
        ...s,
        appendedEntries: [...s.appendedEntries, event.entry].slice(-MAX_APPENDED),
        subagents: indexSubagentEntry(s.subagents, event.entry)
      }
    case 'session_info_changed':
      return { ...s, sessionName: event.name }
    case 'thinking_level_changed':
      return { ...s, thinkingLevel: event.level }
    case 'auto_retry_start':
      return {
        ...s,
        retry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
          startedAt: Date.now()
        }
      }
    case 'auto_retry_end':
      return { ...s, retry: null, retryError: event.success ? undefined : event.finalError }
    case 'summarization_retry_scheduled':
      return {
        ...s,
        summarizationRetry: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage
        }
      }
    case 'summarization_retry_attempt_start':
      return s
    case 'summarization_retry_finished':
      return { ...s, summarizationRetry: null }
    case 'bash_execution_update': {
      if (!event.id) return s
      const run = s.bash[event.id] ?? {
        id: event.id,
        command: '',
        output: '',
        running: true,
        startedAt: Date.now()
      }
      return { ...s, bash: { ...s.bash, [event.id]: { ...run, output: run.output + event.delta } } }
    }
    case 'extension_error':
      return { ...s, extensionErrors: [...s.extensionErrors, event].slice(-50) }
    case 'extension_ui_request':
      return applyExtensionUi(s, event)
    default:
      return s
  }
}
