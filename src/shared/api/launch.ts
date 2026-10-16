/**
 * Launch options + project trust — contract shared by the engine core (serialization) and the
 * launch feature (trust preflight, extension-flag discovery, per-workspace defaults UI).
 *
 * Owned by the launch lane: add channels to the maps below (handlers in src/main/ipc/launch.ts)
 * and persisted prefs to LaunchPrefs (stored under AppPersistedState.features.launch).
 * `launchOptionsToArgs` is the single serializer; keep it pure (no node imports).
 */

import type { EngineId } from './engine'

export interface PrimeAutonomousConfig {
  enabled?: boolean
  maxContinuations?: number
  maxTurns?: number
  maxTokens?: number
  timeoutMs?: number
  continuationPrompt?: string
  gates?: { commands?: string[]; maxRetries?: number; timeoutMs?: number }
  subagentKeepAliveMs?: number
}

export interface PrimeLaunchOptions {
  systemPrompt?: string
  appendSystemPrompt?: string[]
  skills?: string[]
  promptTemplates?: string[]
  models?: string[]
  autonomous?: PrimeAutonomousConfig
}

/** Structured pi CLI launch flags for one agent process. Every field maps 1:1 to a documented flag. */
export interface LaunchOptions {
  /** Native configuration for the second backend; never serialized as default-engine CLI flags. */
  prime?: PrimeLaunchOptions
  /** `--tools a,b` allowlist (supports `*` patterns and `+name`/`-name` deltas). */
  tools?: string[]
  /** `--exclude-tools a,b`. */
  excludeTools?: string[]
  /** `--no-tools`. */
  noTools?: boolean
  /** `--no-builtin-tools`. */
  noBuiltinTools?: boolean
  /** `--no-extensions`. */
  noExtensions?: boolean
  /** `-e <path|builtin:name>` (repeatable). */
  extensions?: string[]
  /** `--no-skills`. */
  noSkills?: boolean
  /** `--skill <path>` (repeatable). */
  skills?: string[]
  /** `--no-prompt-templates`. */
  noPromptTemplates?: boolean
  /** `--prompt-template <path>` (repeatable). */
  promptTemplates?: string[]
  /** `--no-context-files`. */
  noContextFiles?: boolean
  /** `--no-mcp`. */
  noMcp?: boolean
  /** `--system-prompt <text>` (replaces the default system prompt). */
  systemPrompt?: string
  /** `--append-system-prompt <text|file>` (repeatable). */
  appendSystemPrompt?: string[]
  /** `--models a,b` scoped model patterns for cycling. */
  models?: string[]
  /** `--offline`. */
  offline?: boolean
  /**
   * Extension-registered CLI flags, keyed by flag name without dashes (e.g. `no-lens`).
   * `true` → `--flag`, string → `--flag value`, string[] → `--flag a --flag b` (repeated; empty
   * strings skipped), `false`/absent → omitted.
   */
  extensionFlags?: Record<string, ExtensionFlagValue>
  /**
   * Extra environment variables for the engine process (merged over the inherited env). Values reach the
   * renderer masked (see `launch:reveal-env`); sending a mask back unchanged keeps the stored value.
   */
  env?: Record<string, string>
}

/** Value of one extension flag in LaunchOptions.extensionFlags. */
export type ExtensionFlagValue = string | boolean | string[]

/** Serialize LaunchOptions to pi CLI args (env is applied separately by the process spawner). */
export function launchOptionsToArgs(options: LaunchOptions | undefined): string[] {
  if (!options) return []
  const out: string[] = []
  const list = (flag: string, values: string[] | undefined): void => {
    if (values && values.length > 0) out.push(flag, values.join(','))
  }
  const repeat = (flag: string, values: string[] | undefined): void => {
    for (const value of values ?? []) out.push(flag, value)
  }
  const bool = (flag: string, on: boolean | undefined): void => {
    if (on) out.push(flag)
  }

  bool('--no-tools', options.noTools)
  bool('--no-builtin-tools', options.noBuiltinTools)
  list('--tools', options.tools)
  list('--exclude-tools', options.excludeTools)
  bool('--no-extensions', options.noExtensions)
  repeat('--extension', options.extensions)
  bool('--no-skills', options.noSkills)
  repeat('--skill', options.skills)
  bool('--no-prompt-templates', options.noPromptTemplates)
  repeat('--prompt-template', options.promptTemplates)
  bool('--no-context-files', options.noContextFiles)
  bool('--no-mcp', options.noMcp)
  if (options.systemPrompt) out.push('--system-prompt', options.systemPrompt)
  repeat('--append-system-prompt', options.appendSystemPrompt)
  list('--models', options.models)
  bool('--offline', options.offline)
  for (const [name, value] of Object.entries(options.extensionFlags ?? {})) {
    if (value === true) out.push(`--${name}`)
    else if (typeof value === 'string' && value.length > 0) out.push(`--${name}`, value)
    else if (Array.isArray(value))
      repeat(
        `--${name}`,
        value.filter((v) => v.length > 0)
      )
  }
  return out
}

/** Global `defaultProjectTrust` setting (agent-dir settings only). */
export type ProjectTrustDefault = 'ask' | 'always' | 'never'

/** A protected project resource (pi security.md "Resources protected by project trust"). */
export type TrustResourceKind =
  | 'settings'
  | 'mcp'
  | 'extensions'
  | 'skills'
  | 'prompts'
  | 'themes'
  | 'system-prompt'
  | 'append-system-prompt'
  | 'agents-skills'

export interface TrustResource {
  kind: TrustResourceKind
  /** Absolute path. */
  path: string
  /** Display path relative to the workspace (forward slashes), e.g. `.pi/settings.json`. */
  label: string
  /** Number of top-level entries when the resource is a folder. */
  entries?: number
}

/** Project-trust state of a workspace, resolved before an engine starts there. */
export interface TrustPreflight {
  cwd: string
  /** The engine found trust-requiring project resources (`hasTrustRequiringProjectResources`). */
  requiresTrust: boolean
  resources: TrustResource[]
  /** Closest saved decision in `trust.json` (this folder or a parent), null when none applies. */
  saved: boolean | null
  /** Folder that owns the saved decision. */
  savedPath: string | null
  defaultTrust: ProjectTrustDefault
  /** Whether the engine loads project resources without an explicit override (RPC cannot prompt: "ask" skips them). */
  engineDefault: boolean
  /** Resources exist, nothing is saved and the default is "ask": the user must decide. */
  needsDecision: boolean
}

/** The four answers of the Trust dialog. */
export type TrustChoice = 'trust-remember' | 'trust-once' | 'distrust-remember' | 'not-now'

/** A flag registered by an extension (`pi.registerFlag`), parsed from the engine's `--help`. */
export interface ExtensionFlagInfo {
  /** Flag name without dashes, e.g. `no-lens` (the key of LaunchOptions.extensionFlags). */
  name: string
  /** `type: "string"` flags take a value; boolean flags are switches. */
  takesValue: boolean
  description: string
  /** Technical name of the package the flag most likely belongs to (inferred), null when unknown. */
  group: string | null
  /** Human label of that package for group headers (`friendlyExtensionName`), null when unknown. */
  groupLabel: string | null
}

export interface EngineToolInfo {
  name: string
  description: string
}

export interface ExtensionFlagsRequest {
  cwd: string
  /** Trust for the probe run; undefined → the workspace's effective trust. */
  approve?: boolean
  /** Ignore the cache and run the engine again. */
  refresh?: boolean
}

export interface ExtensionFlagsResult {
  flags: ExtensionFlagInfo[]
  /** Built-in tool names listed by the engine help (for the Tools allow/deny editors). */
  builtinTools: EngineToolInfo[]
  engineVersion: string
  /** Whether project extensions were loaded for the probe. */
  trusted: boolean
  /** epoch ms of the engine run that produced this result (cached results keep the original time). */
  fetchedAt: number
}

export interface LaunchInvokeMap {
  'engine:trust-preflight': [engine: EngineId, cwd: string, result: TrustPreflight]
  'engine:set-trust': [
    engine: EngineId,
    cwd: string,
    decision: boolean | null,
    result: TrustPreflight
  ]
  'engine:extension-flags': [
    engine: EngineId,
    request: ExtensionFlagsRequest,
    result: ExtensionFlagsResult
  ]
  'engine:reveal-env': [engine: EngineId, cwd: string, key: string, result: string | null]
  'launch:trust-preflight': [cwd: string, result: TrustPreflight]
  /** Save (true/false) the trust decision for a folder, or forget (null) the saved decision that applies to it. */
  'launch:set-trust': [cwd: string, decision: boolean | null, result: TrustPreflight]
  /** Run the engine's `--help` in the workspace and parse extension flags + built-in tools (cached). */
  'launch:extension-flags': [request: ExtensionFlagsRequest, result: ExtensionFlagsResult]
  /**
   * One saved workspace-default env value in clear text, only on explicit user request (Show value). Env values
   * otherwise arrive masked (`app:get-state`, AgentInfo); unchanged masks sent back resolve in main. Null when unset.
   */
  'launch:reveal-env': [cwd: string, key: string, result: string | null]
}

export interface LaunchEventMap {}

/** Persisted under AppPersistedState.features.launch. */
export interface LaunchPrefs {
  /** Default launch options per workspace path, merged into every new session there. */
  workspaces?: Record<string, LaunchOptions>
  /** Defaults isolated by backend; the default engine keeps using workspaces. */
  engineWorkspaces?: Partial<Record<EngineId, Record<string, LaunchOptions>>>
}

export function engineLaunchWorkspaces(
  launch: LaunchPrefs | undefined,
  engine: EngineId
): Record<string, LaunchOptions> {
  return engine === 'pi' ? (launch?.workspaces ?? {}) : (launch?.engineWorkspaces?.[engine] ?? {})
}

// Registers LaunchPrefs under AppPersistedState.features.launch (FeaturePrefs is assembled per lane).
declare module './app' {
  interface FeaturePrefs {
    launch?: LaunchPrefs
  }
}
