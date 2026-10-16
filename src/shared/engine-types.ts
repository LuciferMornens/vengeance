/**
 * pi RPC protocol types (mirrors pi-coding-agent 1.1.0 `dist/modes/rpc/rpc-types.d.ts`,
 * `dist/core/agent-session.d.ts`, `dist/modes/json-event.d.ts`, `pi-ai` and `pi-agent-core` types).
 *
 * Type-only module: shared by main, preload and renderer. No runtime imports.
 *
 * The engine evolves independently of Vengeance, so consumers must tolerate unknown event types,
 * message roles, content blocks and tool names (render generically, never crash).
 */

import type { SessionLineage, ShareReadiness, ShareSessionResult } from './api/sessions'

// ─── Thinking ────────────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

// ─── Content blocks (pi-ai types.ts) ─────────────────────────────────────────

export interface TextContent {
  type: 'text'
  text: string
  textSignature?: string
}

export interface ImageContent {
  type: 'image'
  /** base64 data */
  data: string
  mimeType: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}

export interface ToolCall {
  type: 'toolCall'
  id: string
  name: string
  // Tool arguments are tool-specific JSON (protocol boundary).
  arguments: Record<string, unknown>
  /** Native parser error when the final tool arguments are malformed. */
  argumentsError?: string
  thoughtSignature?: string
  namespace?: string
}

export type AssistantContent = TextContent | ThinkingContent | ToolCall

export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
  /** Already included in `output`. */
  reasoning?: number
  totalTokens: number
  cost: UsageCost
}

export type StopReason =
  'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'

// ─── Messages (message-types.md) ─────────────────────────────────────────────

export interface SystemMessage {
  role: 'system'
  content: string | TextContent[]
  sections?: Record<string, string | null>
  toolsAdded?: Array<{ name: string; description?: string; parameters?: unknown }>
  toolsRemoved?: Array<{ name: string }>
  timestamp: number
}

export interface UserMessage {
  role: 'user'
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContent[]
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  providerThinkingLevel?: string
  thinkingLevel?: ThinkingLevel
  diagnostics?: unknown[]
  usage: Usage
  stopReason: StopReason
  deferred?: unknown
  errorMessage?: string
  rawStopReason?: string
  endTurn?: boolean
  timestamp: number
}

export interface NestedToolCallRecord {
  id: string
  name: string
  arguments?: Record<string, unknown>
  argumentsBytes?: number
  status: 'ok' | 'error' | 'unfinished'
  durationMs?: number
  error?: string
}

export interface ToolResultMessage<TDetails = unknown> {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  usage?: Usage
  nestedCalls?: { calls: NestedToolCallRecord[]; complete: boolean }
  isError: boolean
  durationMs?: number
  timestamp: number
}

export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  excludeFromContext?: boolean
  timestamp: number
}

export interface CustomMessage<T = unknown> {
  role: 'custom'
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: T
  timestamp: number
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string | null
  timestamp: number
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

/** Known coding-agent message union. Renderers must still handle unknown roles defensively. */
export type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage

export type AgentMessageRole = AgentMessage['role']

// ─── Model (pi-ai Model<Api>) ────────────────────────────────────────────────

export interface ModelCost {
  /** USD per million tokens */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  /** Supported modalities; empty when a native descriptor could not be verified. */
  input: ('text' | 'image')[]
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  type?: 'chat'
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
  headers?: Record<string, string>
  // Provider-specific compat/limits blobs (protocol boundary).
  compat?: Record<string, unknown>
  promptCache?: Partial<Record<'short' | 'long', number>>
  inputLimits?: Record<string, unknown>
}

// ─── Session entries (session-format.md) ─────────────────────────────────────

export interface SessionHeader {
  type: 'session'
  version?: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

export interface SessionEntryBase {
  type: string
  id: string
  parentId: string | null
  /** ISO 8601 */
  timestamp: string
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message'
  message: AgentMessage
}
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change'
  thinkingLevel: string
}
export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change'
  provider: string
  modelId: string
}
export interface UsageEntry extends SessionEntryBase {
  type: 'usage'
  kind: string
  provider: string
  model: string
  usage: Usage
  note?: string
}
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: 'compaction'
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: T
  usage?: Usage
  fromHook?: boolean
  systemMessage?: SystemMessage
}
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: 'branch_summary'
  fromId: string
  summary: string
  details?: T
  usage?: Usage
  fromHook?: boolean
}
export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: 'custom'
  customType: string
  data?: T
}
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: 'custom_message'
  customType: string
  content: string | (TextContent | ImageContent)[]
  details?: T
  display: boolean
}
export interface ContextEditEntry extends SessionEntryBase {
  type: 'context_edit'
  targetId: string
  replacement: {
    content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[]
  } | null
}
export interface LabelEntry extends SessionEntryBase {
  type: 'label'
  targetId: string
  label: string | undefined
}
export interface SessionInfoEntry extends SessionEntryBase {
  type: 'session_info'
  name?: string
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | UsageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | ContextEditEntry
  | LabelEntry
  | SessionInfoEntry

/** A node of the engine's nested session tree (as pi's `get_tree` and `SessionManager.getTree()` return it). */
export interface SessionTreeNode {
  entry: SessionEntry
  children: SessionTreeNode[]
  label?: string
  labelTimestamp?: string
}

/** `get_tree` data as the engine sends it. */
export interface EngineTreeData {
  tree: SessionTreeNode[]
  leafId: string | null
}

/** One node of a flattened session tree: a `SessionTreeNode` with its tree parent instead of its children. */
export interface FlatTreeNode {
  entry: SessionEntry
  /** Parent node in the tree; null for roots (also for orphans whose `entry.parentId` names a missing entry). */
  parentId: string | null
  label?: string
  labelTimestamp?: string
}

/**
 * A session tree as it crosses IPC. The nested form nests one level per entry, and Electron's contextBridge
 * rejects objects deeper than 1000 levels, so main flattens it: nodes in pre-order, siblings in tree order.
 */
export interface FlatSessionTree {
  nodes: FlatTreeNode[]
  leafId: string | null
}

// ─── Command payload types ───────────────────────────────────────────────────

export type PromptDisposition = 'handled' | 'queued' | 'started'
export type QueuedInputDisposition = 'handled' | 'queued'
export type QueueMode = 'all' | 'one-at-a-time'
export type CompactionReason = 'manual' | 'threshold' | 'overflow'

export interface SourceInfo {
  path: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir?: string
}

export interface RpcSlashCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo: SourceInfo
}

export interface RpcSessionState {
  model?: Model
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
  sessionFile?: string
  sessionId: string
  sessionName?: string
  lineage?: SessionLineage
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface ContextUsage {
  /** null right after compaction until a fresh response reports usage */
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export interface SessionStats {
  sessionFile: string | undefined
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: ContextUsage
}

export interface BashResult {
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

export interface CompactionResult<T = unknown> {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  estimatedTokensAfter?: number
  usage?: Usage
  details?: T
}

// ─── Commands (stdin) ────────────────────────────────────────────────────────

type WithId<T> = T & { id?: string }

export type RpcCommand = WithId<
  | {
      type: 'prompt'
      message: string
      images?: ImageContent[]
      streamingBehavior?: 'steer' | 'followUp'
    }
  | { type: 'steer'; message: string; images?: ImageContent[] }
  | { type: 'follow_up'; message: string; images?: ImageContent[] }
  | { type: 'abort' }
  | { type: 'clear_queue' }
  | { type: 'new_session'; parentSession?: string }
  | { type: 'get_state' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'get_available_models' }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'cycle_thinking_level' }
  | { type: 'get_available_thinking_levels' }
  | { type: 'set_steering_mode'; mode: QueueMode }
  | { type: 'set_follow_up_mode'; mode: QueueMode }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'bash'; command: string; excludeFromContext?: boolean }
  | { type: 'abort_bash' }
  | { type: 'get_session_stats' }
  | { type: 'export_html'; outputPath?: string }
  | { type: 'share_readiness' }
  | { type: 'share_session'; expectedDestination?: 'gist' | 'radius' }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'fork'; entryId: string }
  | { type: 'clone' }
  | { type: 'get_fork_messages' }
  | { type: 'get_entries'; since?: string }
  | { type: 'get_tree' }
  | { type: 'get_last_assistant_text' }
  | { type: 'set_session_name'; name: string }
  | { type: 'get_messages' }
  | { type: 'get_commands' }
>

export type RpcCommandType = RpcCommand['type']

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A command as sent by Vengeance code; the id is assigned by the engine process wrapper. */
export type RpcCommandInput = DistributiveOmit<RpcCommand, 'id'>

export type RpcCommandOf<T extends RpcCommandType> = Extract<RpcCommandInput, { type: T }>

// ─── Responses (stdout) ──────────────────────────────────────────────────────

/** Successful response data per command (undefined = no data field). */
export interface RpcResponseDataMap {
  prompt: { disposition: PromptDisposition }
  steer: { disposition: QueuedInputDisposition }
  follow_up: { disposition: QueuedInputDisposition }
  abort: undefined
  clear_queue: { steering: string[]; followUp: string[] }
  new_session: { cancelled: boolean }
  get_state: RpcSessionState
  set_model: Model
  cycle_model: { model: Model; thinkingLevel: ThinkingLevel; isScoped: boolean } | null
  get_available_models: { models: Model[] }
  set_thinking_level: undefined
  cycle_thinking_level: { level: ThinkingLevel } | null
  get_available_thinking_levels: { levels: ThinkingLevel[] }
  set_steering_mode: undefined
  set_follow_up_mode: undefined
  compact: CompactionResult
  set_auto_compaction: undefined
  set_auto_retry: undefined
  abort_retry: undefined
  bash: BashResult
  abort_bash: undefined
  get_session_stats: SessionStats
  export_html: { path: string }
  share_readiness: ShareReadiness
  share_session: ShareSessionResult
  switch_session: { cancelled: boolean }
  fork: { text: string; cancelled: boolean }
  clone: { cancelled: boolean }
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> }
  get_entries: { entries: SessionEntry[]; leafId: string | null }
  /** Flattened by main (`flattenTreeResponse`); the engine itself answers with `EngineTreeData`. */
  get_tree: FlatSessionTree
  get_last_assistant_text: { text: string | null }
  set_session_name: undefined
  get_messages: { messages: AgentMessage[] }
  get_commands: { commands: RpcSlashCommand[] }
}

export type RpcResponseData<T extends RpcCommandType> = RpcResponseDataMap[T]

export type RpcSuccessResponse<T extends RpcCommandType = RpcCommandType> = T extends RpcCommandType
  ? { id?: string; type: 'response'; command: T; success: true; data: RpcResponseDataMap[T] }
  : never

export interface RpcErrorResponse {
  id?: string
  type: 'response'
  command: string
  success: false
  error: string
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse

// ─── Session events (json.md) ────────────────────────────────────────────────

/** `message_update.assistantMessageEvent` as sent on the wire (no cumulative `partial`). */
export type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; id: string; toolName: string }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' | 'deferred'; message: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: AssistantMessage }

/** Generic tool result payload (`AgentToolResult`): content + tool-specific details. */
export interface ToolResultPayload<TDetails = unknown> {
  content: (TextContent | ImageContent)[]
  details?: TDetails
  // Some tools attach extra fields (usage, nestedCalls); protocol boundary.
  [key: string]: unknown
}

export type AgentSessionEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[]; willRetry: boolean }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; usage: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      partialResult: ToolResultPayload
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: ToolResultPayload
      isError: boolean
      durationMs?: number
      parentToolCallId?: string
    }
  | { type: 'queue_update'; steering: readonly string[]; followUp: readonly string[] }
  | { type: 'compaction_start'; reason: CompactionReason }
  | {
      type: 'compaction_end'
      reason: CompactionReason
      result: CompactionResult | undefined
      aborted: boolean
      willRetry: boolean
      errorMessage?: string
    }
  | { type: 'entry_appended'; entry: SessionEntry }
  | { type: 'session_info_changed'; name: string | undefined }
  | { type: 'thinking_level_changed'; level: ThinkingLevel }
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | {
      type: 'summarization_retry_scheduled'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'summarization_retry_attempt_start'; source: 'branchSummary' }
  | { type: 'summarization_retry_attempt_start'; source: 'compaction'; reason: CompactionReason }
  | { type: 'summarization_retry_finished' }
  | { type: 'bash_execution_update'; id?: string; delta: string }

/** RPC-only: an extension handler threw. */
export interface ExtensionErrorEvent {
  type: 'extension_error'
  extensionPath: string
  event: string
  error: string
}

// ─── Extension UI sub-protocol (rpc-extension-ui.md) ─────────────────────────

export type RpcExtensionUIRequest =
  | {
      type: 'extension_ui_request'
      id: string
      method: 'select'
      title: string
      options: string[]
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'confirm'
      title: string
      message: string
      timeout?: number
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'input'
      title: string
      placeholder?: string
      timeout?: number
    }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'notify'
      message: string
      notifyType?: 'info' | 'warning' | 'error'
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setStatus'
      statusKey: string
      statusText: string | undefined
    }
  | {
      type: 'extension_ui_request'
      id: string
      method: 'setWidget'
      widgetKey: string
      widgetLines: string[] | undefined
      widgetPlacement?: 'aboveEditor' | 'belowEditor'
    }
  | { type: 'extension_ui_request'; id: string; method: 'setTitle'; title: string }
  | { type: 'extension_ui_request'; id: string; method: 'set_editor_text'; text: string }

export type ExtensionUIMethod = RpcExtensionUIRequest['method']

/** Dialog requests block the extension until an `extension_ui_response` is written back. */
export type ExtensionUIDialogRequest = Extract<
  RpcExtensionUIRequest,
  { method: 'select' | 'confirm' | 'input' | 'editor' }
>

export const EXTENSION_UI_DIALOG_METHODS: readonly ExtensionUIDialogRequest['method'][] = [
  'select',
  'confirm',
  'input',
  'editor'
]

export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

// ─── Everything forwarded from an engine process to the renderer ─────────────

export interface NativeEngineEvent {
  type: 'engine_native_event'
  engine: 'prime'
  name: string
  data: Record<string, unknown>
}

export type EngineEvent =
  AgentSessionEvent | ExtensionErrorEvent | RpcExtensionUIRequest | NativeEngineEvent

export type EngineEventType = EngineEvent['type']
