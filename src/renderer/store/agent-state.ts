import {
  hasBridgeCommands,
  isBridgeCommand,
  type AgentInfo,
  type EngineStatus
} from '@shared/api/engine'
import { SUBAGENT_HOST_COMMANDS } from '@shared/subagents'
import type { SpeedState } from '@shared/api/speed'
import type {
  AgentMessage,
  BashResult,
  CompactionReason,
  CompactionResult,
  ExtensionErrorEvent,
  ExtensionUIDialogRequest,
  Model,
  RpcSessionState,
  RpcSlashCommand,
  SessionEntry,
  SessionStats,
  ThinkingLevel,
  ToolResultPayload,
  Usage
} from '@shared/engine-types'
import type {
  SubagentAsyncSnapshot,
  SubagentRunState,
  SubagentSnapshotNode,
  SubagentSupervisorRequest
} from '@shared/subagents'

/** A completed message in the transcript with a stable React key. */
export interface TranscriptEntry {
  key: string
  message: AgentMessage
}

/** The message currently between message_start and message_end (usually an assistant message). */
export interface StreamingMessage {
  key: string
  message: AgentMessage
  /** Raw streamed tool-call argument JSON per content index (until toolcall_end). */
  toolArgsText: Record<number, string>
}

export type ToolStatus =
  /** Arguments still streaming from the model. */
  | 'streaming'
  /** Call complete, execution not started yet. */
  | 'pending'
  | 'running'
  | 'done'
  | 'error'

export interface ToolExecution {
  toolCallId: string
  toolName: string
  // Tool arguments (best-effort partial parse while streaming).
  args: Record<string, unknown>
  status: ToolStatus
  /** Latest partial result (tool-specific replace/extend semantics). */
  partialResult?: ToolResultPayload
  result?: ToolResultPayload
  isError: boolean
  /** epoch ms (client clock) */
  startedAt?: number
  endedAt?: number
  durationMs?: number
  /** Set for nested calls a tool made via ctx.executeTool(). */
  parentToolCallId?: string
  /**
   * The call can no longer finish (aborted mid-stream, engine crash, or resumed history without a
   * result). Such calls have status `error` and an "Interrupted" result unless a real one arrived.
   */
  interrupted?: boolean
}

/** A direct `!command` run via the RPC `bash` command. */
export interface BashRun {
  id: string
  command: string
  output: string
  running: boolean
  result?: BashResult
  startedAt: number
  /** `!!command`: the Engine keeps the output out of the model context. */
  excludeFromContext?: boolean
}

export interface PendingDialog {
  request: ExtensionUIDialogRequest
  /** epoch ms; with request.timeout gives the auto-dismiss deadline */
  receivedAt: number
  /** Asked while a run was active (a hook or tool of that run is waiting on it). */
  duringRun: boolean
}

export interface ExtensionNotification {
  id: string
  message: string
  level: 'info' | 'warning' | 'error'
  at: number
}

export interface ExtensionWidget {
  lines: string[]
  placement: 'aboveEditor' | 'belowEditor'
}

/** A status or widget whose text is a machine payload (JSON envelope); shown only in the inspector. */
export interface MachinePayload {
  lines: string[]
  at: number
}

export interface ExtensionUiState {
  /** setStatus entries by key (text may contain ANSI). */
  statuses: Record<string, string>
  widgets: Record<string, ExtensionWidget>
  /** Machine-payload statuses and widgets by key (never rendered as text near the composer). */
  machine: Record<string, MachinePayload>
  title?: string
  /** set_editor_text; nonce changes on every request so the composer can react. */
  editorText?: { text: string; nonce: number }
  dialogs: PendingDialog[]
  /** Recent notify requests (bounded); the extension-ui feature turns new ones into toasts. */
  notifications: ExtensionNotification[]
}

/** How a subagent run ended, from its `subagent-notify` message (or a foreground call's result). */
export interface SubagentRunFinal {
  state: SubagentRunState
  /** epoch ms the outcome arrived */
  at: number
  durationMs?: number
  summary?: string
  outputPath?: string
  /** Short failure reason (`timed out after 30m`). */
  reason?: string
}

/** Everything the host knows about one subagent run: launch args, the last snapshot node, the outcome. */
export interface SubagentRunRecord {
  runId: string
  label: string
  kind: 'subagent' | 'workflow'
  task?: string
  model?: string
  /** Child session name (foreground results). */
  title?: string
  /** Launch `output` file. */
  outputFile?: string
  /** Run this one revived (resume lineage). */
  resumedFrom?: string
  /** epoch ms of the launch result */
  launchedAt?: number
  /** State of a foreground (`async: false`) call while it has no snapshot. */
  foregroundState?: SubagentRunState
  /** Latest snapshot node, kept after the run leaves the snapshot. */
  node?: SubagentSnapshotNode
  final?: SubagentRunFinal
  /** Latest control-notice message. */
  attention?: string
}

export interface SubagentRequestRecord {
  request: SubagentSupervisorRequest
  state: 'pending' | 'sending' | 'answered'
  /** epoch ms the request arrived (message timestamp when rebuilt from history) */
  receivedAt: number
}

/** Host-side memory of pi-subagents runs: the snapshot only lists runs until 10 s after they end. */
export interface SubagentsState {
  snapshot: SubagentAsyncSnapshot | null
  snapshotAt?: number
  runs: Record<string, SubagentRunRecord>
  requests: Record<string, SubagentRequestRecord>
  /** Failed runs the user has looked at (or that failed before this session was opened). */
  seen: Record<string, true>
}

export function createSubagentsState(): SubagentsState {
  return { snapshot: null, runs: {}, requests: {}, seen: {} }
}

export interface RetryState {
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
  startedAt: number
}

export interface CompactionState {
  reason: CompactionReason
  startedAt: number
}

export interface CompactionOutcome {
  reason: CompactionReason
  result?: CompactionResult
  aborted: boolean
  errorMessage?: string
  at: number
}

export interface AgentState {
  id: string
  /** Invalidates asynchronous reads when this agent's engine restarts. */
  engineGeneration: number
  /** Invalidates reads begun before an authoritative native attachment snapshot. */
  snapshotRevision: number
  /** Full history committed for the current engine generation and session. */
  historyLoaded: boolean
  info: AgentInfo
  status: EngineStatus
  error?: string
  /** `running` between agent_start and agent_settled. */
  phase: 'idle' | 'running'
  turnActive: boolean
  lastRunAborted: boolean
  entries: TranscriptEntry[]
  streaming: StreamingMessage | null
  tools: Record<string, ToolExecution>
  queue: { steering: string[]; followUp: string[] }
  session?: RpcSessionState
  model?: Model
  thinkingLevel?: ThinkingLevel
  thinkingLevels: ThinkingLevel[]
  /** Invalidates model reads when a live selection changes. */
  modelRevision: number
  modelChangePending: boolean
  /** Response speed (Fast / Ultrafast); absent when the engine does not report one. */
  speed?: SpeedState
  sessionName?: string
  stats?: SessionStats
  /** Latest cumulative usage of the streaming assistant response. */
  liveUsage?: Usage
  commands: RpcSlashCommand[]
  commandsStatus: 'loading' | 'ready' | 'error'
  commandsRevision: number
  retry: RetryState | null
  /** Final auto-retry failure message, cleared by the next run. */
  retryError?: string
  compaction: CompactionState | null
  lastCompaction?: CompactionOutcome
  summarizationRetry: {
    attempt: number
    maxAttempts: number
    delayMs: number
    errorMessage: string
  } | null
  bash: Record<string, BashRun>
  ext: ExtensionUiState
  subagents: SubagentsState
  extensionErrors: ExtensionErrorEvent[]
  /** Entries appended by extensions (`entry_appended`), bounded. */
  appendedEntries: SessionEntry[]
  lastEventAt: number
}

export function createAgentState(info: AgentInfo): AgentState {
  return {
    id: info.agentId,
    engineGeneration: 0,
    snapshotRevision: 0,
    historyLoaded: false,
    info,
    status: info.status,
    error: info.error,
    phase: info.busy ? 'running' : 'idle',
    turnActive: false,
    lastRunAborted: false,
    entries: [],
    streaming: null,
    tools: {},
    queue: { steering: [], followUp: [] },
    thinkingLevels: [],
    modelRevision: 0,
    modelChangePending: false,
    sessionName: info.sessionName,
    commands: [],
    commandsStatus: 'loading',
    commandsRevision: 0,
    retry: null,
    compaction: null,
    summarizationRetry: null,
    bash: {},
    ext: { statuses: {}, widgets: {}, machine: {}, dialogs: [], notifications: [] },
    subagents: createSubagentsState(),
    extensionErrors: [],
    appendedEntries: [],
    lastEventAt: Date.now()
  }
}

export function hasReadyHistory(agent: AgentState | undefined): boolean {
  return agent?.status === 'ready' && agent.historyLoaded
}

export function restartedRuntime(agent: AgentState): Partial<AgentState> {
  const fresh = createAgentState({ ...agent.info, status: 'starting', busy: false })
  return {
    historyLoaded: false,
    commandsStatus: 'loading',
    modelChangePending: false,
    // The new engine process reports its own speed once it is ready.
    speed: undefined,
    phase: 'idle',
    turnActive: false,
    streaming: null,
    queue: fresh.queue,
    retry: null,
    retryError: undefined,
    compaction: null,
    summarizationRetry: null,
    liveUsage: undefined,
    // The editor nonce must remain monotonic across engine replacement.
    ext: { ...fresh.ext, editorText: agent.ext.editorText },
    extensionErrors: []
  }
}

export function capabilityStatePatch(
  agent: AgentState,
  state: RpcSessionState,
  levels: ThinkingLevel[],
  commands: RpcSlashCommand[],
  modelRevision: number | undefined
): Partial<AgentState> {
  return {
    historyLoaded: agent.historyLoaded && agent.session?.sessionId === state.sessionId,
    ...(agent.modelRevision === modelRevision && !agent.modelChangePending
      ? {
          session: state,
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          thinkingLevels: levels
        }
      : {}),
    sessionName: state.sessionName,
    commands: commands.filter(
      (command) => !isBridgeCommand(command) && !SUBAGENT_HOST_COMMANDS.includes(command.name)
    ),
    commandsStatus: 'ready',
    info: {
      ...agent.info,
      lineage: state.lineage,
      bridge: agent.info.engine === 'pi' ? hasBridgeCommands(commands) : agent.info.bridge
    }
  }
}

export function sessionStatePatch(
  agent: AgentState,
  state: RpcSessionState,
  modelRevision: number | undefined
): Partial<AgentState> {
  return {
    historyLoaded: agent.historyLoaded && agent.session?.sessionId === state.sessionId,
    ...(agent.modelRevision === modelRevision && !agent.modelChangePending
      ? { session: state, model: state.model, thinkingLevel: state.thinkingLevel }
      : {}),
    sessionName: state.sessionName,
    info: { ...agent.info, lineage: state.lineage }
  }
}
