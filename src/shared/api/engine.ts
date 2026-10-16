import type {
  EngineEvent,
  RpcCommand,
  RpcCommandType,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSlashCommand,
  SourceInfo,
  ThinkingLevel
} from '../engine-types'
import type { SubagentInspectReply, SubagentInspectRequest } from '../subagents'
import type { LaunchOptions } from './launch'
import type { EngineSettingsRequest, EngineSettingsResult } from './settings'
import type { SpeedMode, SpeedState } from './speed'

export type EngineId = 'pi' | 'prime'

export const DEFAULT_ENGINE_ID: EngineId = 'pi'

export const ENGINE_LABELS: Record<EngineId, string> = {
  pi: 'Engine',
  prime: 'Engine 2'
}

export function isEngineId(value: unknown): value is EngineId {
  return value === 'pi' || value === 'prime'
}

export function normalizeEngineId(value: unknown): EngineId {
  return isEngineId(value) ? value : DEFAULT_ENGINE_ID
}

export interface EngineCapabilities {
  settings: boolean
  providers: boolean
  customModels: boolean
  packages: boolean
  resources: boolean
  mcp: boolean
  instructions: boolean
  trust: boolean
  keybindings: boolean
  updates: boolean
  launchOptions: boolean
  extensionUi: boolean
  subagents: boolean
  sessions: {
    fork: boolean
    clone: boolean
    tree: boolean
    labels: boolean
    exportHtml: boolean
    exportJsonl: boolean
    import: boolean
    share: boolean
  }
  /** Commands exposed through the common session protocol. */
  commands: readonly RpcCommandType[]
}

export interface EngineDescriptor {
  id: EngineId
  label: string
  capabilities: EngineCapabilities
}

export interface BackgroundAgentInfo {
  engine: EngineId
  id: string
  name?: string
  cwd: string
  sessionPath?: string
  status: string
  busy: boolean
}

/** Lifecycle of one session's engine connection. */
export type EngineStatus = 'starting' | 'ready' | 'crashed' | 'exited' | 'stopping'

/** Options for creating, attaching, or resuming an engine session. */
export interface CreateAgentArgs {
  /** Backend for this session; missing values select the default engine. */
  engine?: EngineId
  /** Attach an engine-owned resident session, including one that has no session file yet. */
  nativeAgentId?: string
  /** Workspace folder; becomes the process cwd. */
  cwd: string
  /** Resume this session file (`--session`). */
  sessionPath?: string
  /** Fork this session file into a new session (`--fork`). */
  forkFrom?: string
  /** Ephemeral session (`--no-session`). */
  noSession?: boolean
  /** Override session storage (`--session-dir`). */
  sessionDir?: string
  /** Model pattern (`--model`), e.g. `anthropic/claude-sonnet-4-5` or `sonnet:high`. */
  model?: string
  /** Restrict model lookup to a provider (`--provider`). */
  provider?: string
  thinking?: ThinkingLevel
  /** Initial session display name (`--name`). */
  name?: string
  /** true → `--approve`, false → `--no-approve`, undefined → engine default trust behavior. */
  approve?: boolean
  /** Structured launch flags (tools, resources, system prompt, extension flags, env). */
  launch?: LaunchOptions
  /** Extra raw CLI args appended last (advanced). */
  extraArgs?: string[]
}

export interface EngineRuntimeInfo {
  /** Version reported by the session's running Engine. */
  version: string
  /** Engine currently selected for new sessions and explicit restarts, when available. */
  selectedVersion?: string
}

export interface AgentInfo {
  agentId: string
  engine: EngineId
  nativeAgentId?: string
  cwd: string
  status: EngineStatus
  /** Human-readable failure reason when status is `crashed`. */
  error?: string
  mock: boolean
  pid?: number
  runtime?: EngineRuntimeInfo
  sessionFile?: string
  sessionId?: string
  sessionName?: string
  /** True between `agent_start` and `agent_settled`. */
  busy: boolean
  /** The engine provides Vengeance bridge operations for trees, tools, and labels. */
  bridge: boolean
  /** epoch ms */
  createdAt: number
  args: CreateAgentArgs
}

export interface EngineLocationInfo {
  engine?: EngineId
  capabilities?: EngineCapabilities
  found: boolean
  error?: string
  version?: string
  packageDir?: string
  cliPath?: string
  /** How the engine was located. */
  source?: 'bundled' | 'override' | 'path' | 'managed' | 'npm-global'
  nodePath?: string
  nodeVersion?: string
  /** `system-node` = node on PATH; `electron` = Electron's bundled Node via ELECTRON_RUN_AS_NODE. */
  runtime?: 'system-node' | 'electron'
  /** Version reported by the lazily imported engine SDK (proves config-side access works). */
  sdkVersion?: string
  mock: boolean
}

export interface EngineExitInfo {
  agentId: string
  code: number | null
  signal: string | null
  /** True when Vengeance requested the shutdown. */
  expected: boolean
  stderrTail: string
}

export interface EngineStatusEvent {
  agentId: string
  status: EngineStatus
  info: AgentInfo
}

/** Named scripted runs available in mock mode (see main/engine/mock-scripts.ts). */
export type MockScriptName =
  'showcase' | 'short' | 'gallery' | 'parity' | 'marathon' | 'subagents' | 'toolbelt'

export interface MockPlayArgs {
  script?: MockScriptName
  /** User prompt text shown for the run. */
  prompt?: string
  /** Stop right before the step with this label (resume with another play call with `resume: true`). */
  pauseAt?: string
  /** Continue a paused run. */
  resume?: boolean
  /** Emit steps without delays (deterministic screenshots). */
  instant?: boolean
}

// ─── Vengeance bridge extension (resources/bridge/vengeance-bridge.ts) ──────────────────────────

/**
 * Hidden extension commands registered by the bridge. They reach `ExtensionCommandContext` APIs that
 * RPC has no command for. Keep in sync with `resources/bridge/vengeance-bridge.ts`.
 */
export const BRIDGE_COMMANDS = [
  'vengeance-tree',
  'vengeance-reload',
  'vengeance-tools',
  'vengeance-label',
  'vengeance-subagents',
  'vengeance-speed'
] as const
export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number]

/** Status key prefix the bridge replies on (`ctx.ui.setStatus('__vengeance:<reqId>', json)`); never shown in the UI. */
export const BRIDGE_STATUS_PREFIX = '__vengeance:'

/** File name of the bridge extension (`resources/bridge/`). */
export const BRIDGE_FILE_NAME = 'vengeance-bridge.ts'

/** Custom entry holding an OpenAI native compaction item. Keep in sync with `resources/bridge/openai-native-compaction-core.ts`. */
export const NATIVE_COMPACTION_ENTRY = 'vengeance-native-compaction'

function fromBridgeFile(command: RpcSlashCommand): boolean {
  return (
    command.source === 'extension' &&
    command.sourceInfo.path.replace(/\\/g, '/').endsWith(`/${BRIDGE_FILE_NAME}`)
  )
}

/** A bridge command (hidden from command lists). */
export function isBridgeCommand(command: RpcSlashCommand): boolean {
  return (BRIDGE_COMMANDS as readonly string[]).includes(command.name) && fromBridgeFile(command)
}

/** Every bridge command is registered by the bridge file (it loaded and nothing shadows a name). */
export function hasBridgeCommands(commands: RpcSlashCommand[]): boolean {
  return BRIDGE_COMMANDS.every((name) => commands.some((c) => c.name === name && fromBridgeFile(c)))
}

/** One bridge operation (`engine:bridge`). */
export type BridgeRequest =
  | {
      op: 'tree'
      /** Target entry; a user message moves the leaf to its parent and returns its text as `editorText`. */
      entryId: string
      /** Summarize the branch being left (runs a model call). */
      summarize?: boolean
      customInstructions?: string
      /** `customInstructions` replace the default summary prompt instead of extending it. */
      replaceInstructions?: boolean
      /** Label for the summary entry (or the target when not summarizing). */
      label?: string
    }
  | { op: 'reload' }
  | { op: 'tools-get' }
  | { op: 'tools-set'; names: string[] }
  | { op: 'label'; entryId: string; label?: string }
  | { op: 'subagents'; method: SubagentsRpcMethod; params?: Record<string, unknown> }
  /** Read the session's response speed, or request `mode` (Engine 2 maps this onto its native service tier). */
  | { op: 'speed'; mode?: SpeedMode }

export type BridgeOp = BridgeRequest['op']

/** pi-subagents event-bus RPC methods (`subagents:rpc:v1:request`) the bridge proxies. */
export type SubagentsRpcMethod =
  'ping' | 'status' | 'steer' | 'stop' | 'interrupt' | 'resume' | 'cost'

/** pi-subagents' reply to one event-bus RPC request, passed through by the bridge. */
export type SubagentsRpcReply =
  { success: true; data: unknown } | { success: false; error: { code: string; message: string } }

/** How the model reaches a tool (pi `ToolExposure`). */
export type BridgeToolExposure = 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden'

export interface BridgeToolInfo {
  name: string
  description: string
  exposure: BridgeToolExposure
  /** Tool group, e.g. an MCP server (`mcp__docs`). */
  namespace?: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  sourceInfo: SourceInfo
}

export interface BridgeToolsState {
  /** Tools declared to the model (pi `getActiveTools()`). */
  active: string[]
  /** Every configured tool (pi `getAllTools()`, without parameter schemas). */
  tools: BridgeToolInfo[]
}

export interface BridgeTreeResult {
  cancelled: boolean
  /** Leaf after navigation. */
  leafId: string | null
  /** Text of the selected user message, for the composer (TUI parity). */
  editorText?: string
}

export interface BridgeResultMap {
  tree: BridgeTreeResult
  reload: null
  'tools-get': BridgeToolsState
  'tools-set': BridgeToolsState
  label: null
  subagents: SubagentsRpcReply
  speed: SpeedState
}

export type BridgeResult = BridgeResultMap[BridgeOp]

export interface BridgeCallOptions {
  /** Override the per-operation default timeout (ms). */
  timeoutMs?: number
}

export interface EngineInvokeMap {
  'engine:background-list': [engine: EngineId, result: BackgroundAgentInfo[]]
  'engine:background-stop': [engine: EngineId, nativeAgentId: string, result: void]
  'engine:backends': [result: EngineDescriptor[]]
  'engine:describe': [engine: EngineId, result: EngineLocationInfo]
  'engine:settings': [request: EngineSettingsRequest, result: EngineSettingsResult]
  /** Native operations belonging to the session's second engine backend. */
  'prime:command': [
    agentId: string,
    type: string,
    payload: Record<string, unknown> | undefined,
    result: unknown
  ]
  /** `agentId` is chosen by the renderer so events emitted during startup can be attributed. */
  'engine:create': [args: CreateAgentArgs, agentId: string, result: AgentInfo]
  /** `command.id` is optional; pass a unique `r-…` id only to correlate streamed `bash_execution_update` events. */
  'engine:command': [agentId: string, command: RpcCommand, result: RpcResponse]
  'engine:ui-response': [agentId: string, response: RpcExtensionUIResponse, result: void]
  'engine:dispose': [agentId: string, result: void]
  'engine:list': [result: AgentInfo[]]
  /**
   * The engines a window reloaded after a renderer crash takes over (main keeps them running for a grace period);
   * empty on a normal start. Adopting cancels the shutdown of those engines.
   */
  'engine:adopt': [result: AgentInfo[]]
  /**
   * Restart an agent's engine (resuming its session file). `patch` is merged over the stored args, e.g.
   * `{ approve: undefined }` drops a pinned trust flag so the engine reads the saved decision.
   */
  'engine:restart': [
    agentId: string,
    patch: Partial<CreateAgentArgs> | undefined,
    result: AgentInfo
  ]
  /** Switch an idle thread to another backend, carrying its selected history into a new native file. */
  'engine:switch': [agentId: string, args: CreateAgentArgs, result: AgentInfo]
  'engine:stderr': [agentId: string, result: string]
  'engine:info': [result: EngineLocationInfo]
  /** Run a bridge operation; rejects when the bridge is not loaded (check `AgentInfo.bridge`). */
  'engine:bridge': [
    agentId: string,
    request: BridgeRequest,
    options: BridgeCallOptions | undefined,
    result: BridgeResult
  ]
  /** Ask pi-subagents for an async child's live transcript (`/subagents-inspect-rpc`); never rejects for protocol errors. */
  'engine:subagents-inspect': [
    agentId: string,
    request: SubagentInspectRequest,
    result: SubagentInspectReply
  ]
  /** Mock mode only: drive a scripted run deterministically. */
  'mock:play': [agentId: string, args: MockPlayArgs, result: void]
}

export interface EngineEventMap {
  'engine:event': { agentId: string; event: EngineEvent }
  'engine:exit': EngineExitInfo
  'engine:status': EngineStatusEvent
}
