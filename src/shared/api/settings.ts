/**
 * Settings feature contract: engine settings (settings.json global + project), models & providers
 * (auth flows), custom models (models.json), packages, resources, MCP servers, sessions & context.
 * Handlers live in src/main/ipc/settings.ts (+ src/main/features/settings/**).
 *
 * Secrets never cross this boundary: credentials are described by type/source and a masked hint only.
 */
import type { ThinkingLevel } from '../engine-types'
import type { EngineId } from './engine'
import type { SpeedMode } from './speed'

/** A parsed JSON object (settings.json, models.json, mcp.json). */
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject

export type SettingsScope = 'global' | 'project'

// ─── settings.json ──────────────────────────────────────────────────────────

export interface SettingsFileState {
  /** Absolute path of the settings file (may not exist yet). */
  path: string
  exists: boolean
  /** Parsed content (empty object when missing or unreadable). */
  data: JsonObject
  /** Raw file text ('' when missing). */
  text: string
  /** Parse error when the file exists but is not valid JSON. */
  error?: string
}

export interface ProjectTrustInfo {
  /** Saved decision for this folder or a parent (`trust.json`), null when none applies. */
  saved: boolean | null
  /** The global `defaultProjectTrust` fallback. */
  fallback: 'ask' | 'always' | 'never'
  /** Whether project-scoped settings load in engine processes started by Vengeance (RPC mode). */
  effective: boolean
}

/** A setting that an environment variable of the app overrides in every engine Vengeance starts. */
export interface SettingEnvOverride {
  /** Variable name; the UI shows it only behind Details. */
  variable: string
  /** The value in effect. */
  value: string
}

export interface SettingsSnapshot {
  agentDir: string
  global: SettingsFileState
  /** Null when no workspace is active. */
  project: (SettingsFileState & { cwd: string; trust: ProjectTrustInfo }) | null
  /** True when the main process uses a seeded temp agent dir (mock mode) or a `PI_CODING_AGENT_DIR` override. */
  isolated: boolean
  /** Settings overridden by an environment variable, by dotted key (e.g. `sessionDir`). */
  envOverrides: Record<string, SettingEnvOverride>
}

/** One path segment list into settings.json, e.g. `['compaction', 'modelOverrides', 'anthropic/claude-x']`. */
export type SettingPath = string[]

export interface SetSettingArgs {
  scope: SettingsScope
  cwd: string | null
  path: SettingPath
  /** `undefined` removes the key (reset to inherited/default); empty parent objects are pruned. */
  value: JsonValue | undefined
}

export interface WriteRawSettingsArgs {
  scope: SettingsScope
  cwd: string | null
  text: string
}

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  severity: ValidationSeverity
  /** Dotted key, or '' for document-level problems. */
  key: string
  message: string
}

// ─── Models & providers ─────────────────────────────────────────────────────

export type CredentialSource =
  'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'

export interface ProviderInfo {
  id: string
  name: string
  /** OAuth sign-in offered by the provider. */
  oauth?: { name: string; loginLabel?: string; subscription: boolean }
  /** API-key auth; `interactive` = the engine can prompt for and store a key. */
  apiKey?: { name: string; interactive: boolean }
  status: {
    configured: boolean
    source?: CredentialSource
    /** Human label, e.g. "ANTHROPIC_API_KEY" or "OAuth". */
    label?: string
    usingOAuth: boolean
  }
  /** Credential stored in auth.json (type + masked hint only). */
  stored?: { type: 'api_key' | 'oauth'; hint?: string; expiresAt?: number; command?: boolean }
  /** Environment variable(s) the provider reads, when known. */
  envVars: string[]
  /** Registered by an extension (`pi.registerProvider`). */
  fromExtension?: boolean
  /** A built-in or models.json provider an extension re-registers: that extension's name. */
  modifiedBy?: string
  modelCount: number
  availableCount: number
}

export interface ModelInfo {
  provider: string
  id: string
  name: string
  api: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Provider has usable credentials. */
  available: boolean
  thinkingLevels: ThinkingLevel[]
  /** Registered by an extension (`pi.registerProvider`, virtual models). */
  fromExtension?: boolean
}

export interface ModelCatalog {
  providers: ProviderInfo[]
  models: ModelInfo[]
  /**
   * Models only an open session offers: its own extensions (e.g. project extensions of an untrusted folder), or
   * config it has not reloaded yet. Marked `fromExtension`.
   */
  sessionModels?: ModelInfo[]
  /** models.json problems reported by the engine. */
  error?: string
}

export type AuthMethod = 'oauth' | 'api_key'

/** UI-neutral prompt from a login flow (mirrors pi-ai AuthPrompt). */
export type AuthFlowPrompt =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'manual_code'; message: string; placeholder?: string }
  | {
      type: 'select'
      message: string
      options: { id: string; label: string; description?: string }[]
    }

/** Progress notification from a login flow (mirrors pi-ai AuthEvent). */
export type AuthFlowNotice =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: 'progress'; message: string }

export type AuthFlowEvent = { engine?: EngineId } & (
  | { loginId: string; kind: 'prompt'; promptId: string; prompt: AuthFlowPrompt }
  | { loginId: string; kind: 'prompt-cancelled'; promptId: string }
  | { loginId: string; kind: 'notice'; notice: AuthFlowNotice }
  | { loginId: string; kind: 'done'; ok: boolean; error?: string; cancelled?: boolean }
)

export interface StartLoginArgs {
  providerId: string
  method: AuthMethod
  cwd?: string
}

export interface AuthCheckResult {
  status: 'ready' | 'not_ready' | 'invalid'
  authType?: string
  reason?: string
  /** Raw diagnostic text when the check could not run. */
  detail?: string
}

// ─── models.json ────────────────────────────────────────────────────────────

/** Built-in API types a models.json provider can use (pi docs/models.md). */
export const MODEL_API_TYPES = [
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'anthropic-messages',
  'mistral-conversations',
  'bedrock-converse-stream',
  'google-generative-ai',
  'google-vertex',
  'pi-messages'
] as const

export interface ModelsJsonState {
  path: string
  exists: boolean
  /** Parsed content with literal API keys / header values masked (`••••abcd`); masks round-trip on save. */
  data: JsonObject
  /** `data` serialized ('' when the file is missing or unreadable). */
  text: string
  error?: string
}

// ─── Packages ───────────────────────────────────────────────────────────────

export interface PackageInfo {
  /** Source as written in settings (`npm:…`, `git:…`, local path). */
  source: string
  scope: 'user' | 'project'
  kind: 'npm' | 'git' | 'local'
  /** Technical name (npm name, repo path, or folder name): links, search, secondary text. */
  name: string
  /** Human label for the UI (`friendlyExtensionName`), e.g. "Web access" for `npm:pi-web-access`. */
  displayName: string
  installedPath?: string
  installed: boolean
  version?: string
  description?: string
  homepage?: string
  /** Object-form entry with resource filters. */
  filtered: boolean
  /** All four resource types filtered to `[]`. */
  disabled: boolean
  /** A project package of a folder that isn't trusted: listed, but the Engine doesn't load it yet. */
  awaitingTrust: boolean
  /** Counts of resources this package contributes (after filters). */
  resources: { extensions: number; skills: number; prompts: number; themes: number }
}

export type PackageAction = 'install' | 'remove' | 'update' | 'update-all'

export interface PackageRunArgs {
  action: PackageAction
  source?: string
  /** Project scope (`-l`, `.pi/settings.json`). */
  local?: boolean
  cwd: string | null
}

export interface ProcessLogEvent {
  engine?: EngineId
  runId: string
  /** Log text. `info` lines are friendly status lines ("Installing Web access…"), never raw commands. */
  text: string
  stream: 'stdout' | 'stderr' | 'info'
  /** Diagnostics only (e.g. the raw engine command line of the run's first `info` line); never part of `text`. */
  detail?: string
}

export interface ProcessDoneEvent {
  engine?: EngineId
  runId: string
  ok: boolean
  code: number | null
  error?: string
}

// ─── Resources (pi config) ──────────────────────────────────────────────────

export type ResourceType = 'extensions' | 'skills' | 'prompts' | 'themes'

export interface ResourceItem {
  /** Absolute path, or `builtin:<name>`. */
  path: string
  type: ResourceType
  displayName: string
  description?: string
  enabled: boolean
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  /** Package source or `auto` / `local` / `builtin`. */
  source: string
  baseDir?: string
}

export interface ResourceGroup {
  key: string
  /** UI label: a friendly package name for package groups (the technical id stays in `source`). */
  label: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  source: string
  items: ResourceItem[]
}

export interface ToggleResourceArgs {
  cwd: string | null
  item: ResourceItem
  enabled: boolean
}

// ─── MCP ────────────────────────────────────────────────────────────────────

export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden'

export interface McpServerInfo {
  name: string
  scope: 'global' | 'project' | 'extension'
  /** Config file defining the server. */
  source: string
  override?: string
  enabled: boolean
  exposure: McpExposure
  transport: 'stdio' | 'http'
  /** Command line (stdio) or URL (http). */
  target: string
  description?: string
  /** Header/env names only (values may be secrets). */
  envNames: string[]
  headerNames: string[]
  oauth: boolean
}

export interface McpServerStatus {
  name: string
  state: string
  tools: string[]
  resources?: number
  supportsResources?: boolean
  error?: string
  label?: string
  usesOAuth?: boolean
  connectable?: boolean
  pasteToken?: boolean
  description?: string
  docsUrl?: string
  source?: string
  connectionIds?: string[]
  toolCount?: number
}

export interface McpOverview {
  servers: McpServerInfo[]
  errors: string[]
  /** Effective `autoEnableCodemode` (a project value wins over the global one). */
  autoEnableCodemode: boolean
  /** Raw values per file; undefined = not set there (engine default true). */
  autoEnableCodemodeGlobal?: boolean
  autoEnableCodemodeProject?: boolean
  globalPath: string
  projectPath: string | null
  /** The project mcp.json when the project is trusted (where project overrides are saved), else null. */
  projectConfig: string | null
  /** Built-in MCP support disabled via `-builtin:mcp`. */
  builtinDisabled: boolean
}

/** mcp.json `oauth` block of an HTTP server (pi docs/mcp.md "Authenticate with OAuth"). */
export interface McpOAuthConfig {
  clientId?: string
  /** Literal values arrive masked; `${VAR}` and `!command` references are shown as-is. */
  clientSecret?: string
  callbackPort?: number
  callbackUrl?: string
  scope?: string
  clientName?: string
  clientRegistration?: 'cimd'
  authServerMetadataUrl?: string
}

/**
 * Editable form of one mcp.json server entry. Literal `env` / `headers` / `oauth.clientSecret` values are
 * masked (`••••abcd`) and swapped back for the value on disk when saved unchanged. Unknown keys of the
 * entry are preserved on save.
 */
export interface McpServerDraft {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Working directory of a stdio server (relative values resolve against the session directory). */
  cwd?: string
  url?: string
  headers?: Record<string, string>
  oauth?: McpOAuthConfig
  /** Per-request timeout in seconds (engine default 60). */
  timeout?: number
  enabled: boolean
  exposure: McpExposure
  /** Per-tool exposure keyed by exact tool names or `*` patterns. */
  toolExposure?: Record<string, McpExposure>
  description?: string
}

export interface SaveMcpServerArgs {
  cwd: string | null
  /** File to write: the global mcp.json or the project one. */
  scope: 'global' | 'project'
  /** Name of the entry being edited (a rename removes it); omit when adding. */
  previousName?: string
  server: McpServerDraft
}

/**
 * Enable/disable or change exposure in the file that defines (or overrides) the server, like `/mcp`.
 * `projectOverride: 'set'` writes the change as a project override of a global server ("Enable in this
 * project"); `'clear'` removes that override.
 */
export interface McpServerPatch {
  enabled?: boolean
  exposure?: McpExposure
  projectOverride?: 'set' | 'clear'
}

export interface TextTail {
  path: string
  exists: boolean
  /** Last bytes of the file, cut at a line start. */
  text: string
}

// ─── Sessions & context ─────────────────────────────────────────────────────

export interface ContextOverview {
  /** AGENTS.md / CLAUDE.md files the engine loads for this folder (agent dir + ancestors). */
  contextFiles: Array<{ path: string; bytes: number }>
  /** SYSTEM.md / APPEND_SYSTEM.md in effect. */
  systemFiles: Array<{
    path: string
    kind: 'SYSTEM.md' | 'APPEND_SYSTEM.md'
    scope: 'global' | 'project'
  }>
  /** Default session storage directory for this folder. */
  defaultSessionDir: string
}

/** Native instruction files Vengeance can create and edit for either backend. */
export type InstructionFileKind = 'AGENTS.md' | 'SYSTEM.md' | 'APPEND_SYSTEM.md'

export interface InstructionFileRef {
  kind: InstructionFileKind
  /** Global = engine account directory; project prompt files use that engine's config directory. */
  scope: SettingsScope
}

export interface InstructionFileState extends InstructionFileRef {
  /** The file read and written (an existing CLAUDE.md / AGENTS.override.md stands in for AGENTS.md). */
  path: string
  exists: boolean
  text: string
}

export interface InstructionFileWriteRef extends InstructionFileRef {
  /** Refuse to replace a file that changed while its editor was open. */
  expected?: Pick<InstructionFileState, 'exists' | 'text'>
}

export interface SystemPromptDefault {
  /** Native built-in foundation, without user files or session-specific additions. */
  text: string
}

// ─── Project trust store (trust.json) ───────────────────────────────────────

export interface TrustEntry {
  /** Folder the decision applies to (and everything below it). */
  path: string
  decision: boolean
}

// ─── Terminal keybindings (keybindings.json) ────────────────────────────────

export interface KeybindingAction {
  /** e.g. `app.session.new`, `tui.editor.undo`. */
  id: string
  description: string
  /** Defaults of the installed engine on this platform. */
  defaults: string[]
  /** Display group, e.g. "Sessions", "Editor". */
  group: string
}

export interface KeybindingsState {
  path: string
  exists: boolean
  error?: string
  actions: KeybindingAction[]
  /** User assignments from keybindings.json (unknown ids preserved). An empty list disables an action. */
  bindings: Record<string, string[]>
}

// ─── Channels ───────────────────────────────────────────────────────────────

export interface SettingsInvokeMap {
  'settings:snapshot': [cwd: string | null, result: SettingsSnapshot]
  /**
   * Settings is opening: start loading what its sections read (the Engine's SDK) so they answer at once. Safe to
   * call any time and repeatedly; nothing for engines that need no warm-up.
   */
  'settings:prewarm': [result: void]
  /** Settings closed: shorten the interactive keep-alive window of warm SDK/provider hosts so they exit promptly. */
  'settings:release': [result: void]
  'settings:set': [args: SetSettingArgs, result: SettingsSnapshot]
  /** Validate raw settings.json text without saving. */
  'settings:validate': [text: string, scope: SettingsScope, result: ValidationIssue[]]
  /** Save raw settings.json text (rejects on JSON/validation errors). */
  'settings:write-raw': [args: WriteRawSettingsArgs, result: SettingsSnapshot]
  'settings:set-trust': [cwd: string, decision: boolean | null, result: SettingsSnapshot]

  'settings:catalog': [result: ModelCatalog]
  /** The catalog with the providers of extensions re-read (loads the extensions outside the main process). */
  'settings:extension-providers': [result: ModelCatalog]
  'settings:auth-login': [args: StartLoginArgs, result: string]
  'settings:auth-respond': [loginId: string, promptId: string, value: string | null, result: void]
  'settings:auth-cancel': [loginId: string, result: void]
  'settings:auth-logout': [providerId: string, result: ModelCatalog]
  'settings:auth-check': [providerId: string, result: AuthCheckResult]

  'settings:models-json': [result: ModelsJsonState]
  'settings:models-json-write': [data: JsonObject, result: ModelsJsonState]
  'settings:models-json-validate': [data: JsonObject, result: ValidationIssue[]]

  'settings:packages': [cwd: string | null, result: PackageInfo[]]
  /** Start a streamed `pi install|remove|update` run; returns its run id (events `settings:process-*`). */
  'settings:package-run': [args: PackageRunArgs, result: string]
  'settings:package-enable': [
    cwd: string | null,
    pkg: { source: string; scope: 'user' | 'project' },
    enabled: boolean,
    result: PackageInfo[]
  ]

  'settings:resources': [cwd: string | null, result: ResourceGroup[]]
  /** Names of the custom themes an engine started in `cwd` loads (the theme files' `name`), sorted. */
  'settings:themes': [cwd: string | null, result: string[]]
  'settings:resource-toggle': [args: ToggleResourceArgs, result: ResourceGroup[]]

  'settings:mcp': [cwd: string | null, result: McpOverview]
  'settings:mcp-status': [cwd: string | null, result: McpServerStatus[]]
  /** One server entry as an editable draft (secrets masked). */
  'settings:mcp-server': [
    cwd: string | null,
    name: string,
    scope: 'global' | 'project',
    result: McpServerDraft
  ]
  /** Add or replace a server entry (keeps unknown keys, restores masked secrets). */
  'settings:mcp-save': [args: SaveMcpServerArgs, result: McpOverview]
  'settings:mcp-remove': [cwd: string | null, name: string, local: boolean, result: McpOverview]
  'settings:mcp-update': [
    cwd: string | null,
    name: string,
    patch: McpServerPatch,
    result: McpOverview
  ]
  /** Set (or with null remove) `autoEnableCodemode` in the global or project mcp.json. */
  'settings:mcp-codemode': [
    cwd: string | null,
    scope: 'global' | 'project',
    value: boolean | null,
    result: McpOverview
  ]
  /** Tail of `<agentDir>/mcp.log` (server logging notifications). */
  'settings:mcp-log': [maxBytes: number, result: TextTail]
  /** Streamed `pi mcp login|logout <server>`; returns a run id. */
  'settings:mcp-auth': [
    cwd: string | null,
    name: string,
    action: 'login' | 'logout',
    result: string
  ]

  'settings:context': [cwd: string | null, result: ContextOverview]
  'settings:system-prompt-default': [result: SystemPromptDefault]
  'settings:instruction-file': [
    cwd: string | null,
    ref: InstructionFileRef,
    result: InstructionFileState
  ]
  /** Save an instruction file; `null` moves it to the recycle bin. */
  'settings:instruction-file-write': [
    cwd: string | null,
    ref: InstructionFileWriteRef,
    text: string | null,
    result: InstructionFileState
  ]

  /** Every saved decision in trust.json. */
  'settings:trust-list': [result: TrustEntry[]]
  /** Change or (with null) forget the decision saved for exactly this path. */
  'settings:trust-entry': [path: string, decision: boolean | null, result: TrustEntry[]]

  'settings:keybindings': [result: KeybindingsState]
  /** Replace keybindings.json with these assignments (key syntax validated). */
  'settings:keybindings-write': [bindings: Record<string, string[]>, result: KeybindingsState]

  /**
   * Open a folder, or a .md/.json/.jsonl file inside the agent dir or the active project, with the OS
   * default handler. Any other path is only revealed in Explorer (never executed).
   */
  'settings:open-path': [path: string, result: void]
  'settings:cancel-run': [runId: string, result: void]
}

export type SettingsChangeArea =
  | 'settings'
  | 'auth'
  | 'models'
  | 'packages'
  | 'resources'
  | 'mcp'
  | 'keybindings'
  | 'instructions'
  | 'trust'

export interface SettingsEventMap {
  'settings:auth-event': AuthFlowEvent
  'settings:process-log': ProcessLogEvent
  'settings:process-done': ProcessDoneEvent
  /** Engine config changed on disk: through Vengeance, or (`external`) by the terminal / another program. */
  'settings:changed': {
    engine?: EngineId
    area: SettingsChangeArea
    external?: boolean
    /** Set when only one project's `.pi` changed; `trusted` says whether that folder's engines load it. */
    project?: { cwd: string; trusted: boolean }
    /** settings.json was rewritten by an install or update Vengeance ran, which announces its own change. */
    fromRun?: boolean
    /** An explicit file save is for future sessions; applying to open work is a separate action. */
    apply?: 'new-sessions'
  }
  /** The models a subscription account offers changed (main hides the rest); pickers re-read their lists. */
  'settings:account-models': { providerId: string; engine?: EngineId }
}

export type SettingsChannel = keyof SettingsInvokeMap

export type SettingsArguments<Channel extends SettingsChannel> =
  SettingsInvokeMap[Channel] extends [...infer Arguments, unknown] ? Arguments : never

export type EngineSettingsRequest<Channel extends SettingsChannel = SettingsChannel> = {
  [Key in Channel]: {
    engine: EngineId
    cwd?: string | null
    channel: Key
    args: SettingsArguments<Key>
  }
}[Channel]

export type EngineSettingsResult<Channel extends SettingsChannel = SettingsChannel> =
  SettingsInvokeMap[Channel] extends [...unknown[], infer Result] ? Result : never

export type ReducedMotionPref = 'system' | 'reduce'
export type RestartPolicy = 'ask' | 'always' | 'never'

export interface SettingsPrefs {
  /** Motion preference applied app-wide (default: follow the OS). */
  motion?: ReducedMotionPref
  /** What to do with open agents after a setting that needs an engine restart changed. */
  restartPolicy?: RestartPolicy
  /** OpenAI native compaction for `openai` models (resources/bridge/openai-native-compaction.ts). Default on. */
  nativeCompaction?: boolean
  /**
   * Response speed for Engine sessions without a saved choice (`SPEED_DEFAULT_ENV`). Choosing a speed in a
   * session updates it, like Engine 2's native default service tier. Default: standard.
   */
  speedDefault?: SpeedMode
}
