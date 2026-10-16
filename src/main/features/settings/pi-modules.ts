import { join } from 'node:path'
import type { SessionEntry, SessionTreeNode } from '@shared/engine-types'
import { locateEngine } from '../../engine/locate'
import { importPiFile } from '../../engine/runtime'

/**
 * Narrow views of the selected Engine SDK, qualified against the base in engines.lock.json.
 * Only the members Vengeance uses are declared; modules come from that engine's `dist` directory.
 *
 * The SDK runs in the SDK host (`engine/sdk-host`): once imported, ES modules stay loaded for the
 * life of the process. Main imports only the small files below. Sign-in and sign-out are the
 * exception: their flows reach providers over the network from main, so
 * the first of them loads the model runtime (with pi-ai) into main.
 */

export interface PiSettings {
  packages?: Array<string | PiPackageObject>
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
  defaultProjectTrust?: 'ask' | 'always' | 'never'
  [key: string]: unknown
}

export interface PiPackageObject {
  source: string
  autoload?: boolean
  extensions?: string[]
  skills?: string[]
  prompts?: string[]
  themes?: string[]
}

export interface SettingsManagerLike {
  getGlobalSettings(): PiSettings
  getProjectSettings(): PiSettings
  getDefaultProjectTrust(): 'ask' | 'always' | 'never'
  getSessionDir(): string | undefined
  /** Stable installation id (writes `deviceId` on first use; call flush() after). */
  getOrCreateDeviceId(): string
  flush(): Promise<void>
}

export interface ConfiguredPackage {
  source: string
  scope: 'user' | 'project'
  filtered: boolean
  installedPath?: string
}

export interface ResolvedResource {
  path: string
  enabled: boolean
  metadata: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin: 'package' | 'top-level'
    baseDir?: string
    packageRoot?: string
  }
}

export interface ResolvedPaths {
  extensions: ResolvedResource[]
  skills: ResolvedResource[]
  prompts: ResolvedResource[]
  themes: ResolvedResource[]
}

export interface PackageUpdate {
  source: string
  displayName: string
  type: 'npm' | 'git'
  scope: 'user' | 'project'
}

export interface PackageManagerLike {
  listConfiguredPackages(): ConfiguredPackage[]
  resolve(
    onMissing?: (source: string) => Promise<'install' | 'skip' | 'error'>
  ): Promise<ResolvedPaths>
  checkForAvailableUpdates(): Promise<PackageUpdate[]>
}

export interface AuthPromptLike {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: readonly { id: string; label: string; description?: string }[]
  signal?: AbortSignal
}

export interface AuthEventLike {
  type: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  links?: readonly { url: string; label?: string }[]
  url?: string
  instructions?: string
  userCode?: string
  verificationUri?: string
  expiresInSeconds?: number
}

export interface AuthInteractionLike {
  signal?: AbortSignal
  prompt(prompt: AuthPromptLike): Promise<string>
  notify(event: AuthEventLike): void
}

export interface ProviderLike {
  readonly id: string
  readonly name: string
  readonly auth: {
    apiKey?: { name: string; login?: unknown }
    oauth?: { name: string; loginLabel?: string; isSubscription?: boolean }
  }
}

export interface ModelLike {
  id: string
  name: string
  api: string
  provider: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  thinkingLevelMap?: Record<string, string | null>
  baseUrl?: string
}

/** pi-ai `AuthResult`: request auth resolved from the stored credential (OAuth refreshed under pi's auth lock). */
export interface AuthResultLike {
  auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }
}

export interface ModelRuntimeLike {
  getProviders(): readonly ProviderLike[]
  getModels(providerId?: string): readonly ModelLike[]
  getAvailableSnapshot(): readonly ModelLike[]
  getError(): string | undefined
  getProviderAuthStatus(providerId: string): {
    configured: boolean
    source?: string
    label?: string
  }
  isUsingOAuth(providerId: string): boolean
  getAuth(providerId: string): Promise<AuthResultLike | undefined>
  login(
    providerId: string,
    type: 'oauth' | 'api_key',
    interaction: AuthInteractionLike,
    options?: { getDeviceId?: () => string; agentName?: string }
  ): Promise<unknown>
  logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>
  /** Re-reads models.json and credentials, then recomputes availability. */
  refresh(options?: { allowNetwork?: boolean }): Promise<unknown>
  // Extension registrations are passed through untouched (pi ProviderConfigInput / Provider / VirtualModelDefinition).
  registerProvider(providerId: string, config: unknown): void
  registerNativeProvider(provider: unknown): void
  registerVirtualModel(definition: unknown): void
}

/** What loading extensions queued for the model runtime (pi `dist/core/extensions/types.d.ts` ExtensionRuntimeState). */
export interface ExtensionRuntimeStateLike {
  pendingProviderRegistrations: Array<{ name: string; config: unknown; extensionPath: string }>
  pendingNativeProviderRegistrations: Array<{ provider: { id: string }; extensionPath: string }>
  pendingVirtualModelRegistrations: Array<{ definition: unknown; extensionPath: string }>
}

export interface ExtensionLoaderModule {
  /** Load extension files (pi `dist/core/extensions/loader.d.ts`); failures are collected, not thrown. */
  loadExtensions(paths: string[], cwd: string): Promise<{ runtime: ExtensionRuntimeStateLike }>
}

/** pi `SessionHeader` (first line of a session file). */
export interface PiSessionHeader {
  type: 'session'
  version?: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

export interface SessionManagerLike {
  getSessionId(): string
  getCwd(): string
  getLeafId(): string | null
  getBranch(fromId?: string): SessionEntry[]
  getTree(): SessionTreeNode[]
  appendSessionInfo(name: string): string
  appendLabelChange(targetId: string, label: string | undefined): string
  createBranchedSession(leafId: string): string | undefined
}

export interface PiSdkSurface {
  VERSION: string
  /** `CURRENT_SESSION_VERSION` (header version of exported files). */
  CURRENT_SESSION_VERSION?: number
  SessionManager: { open(path: string): SessionManagerLike }
  /** Header + entries of a session file, tolerant of bad lines. */
  parseSessionEntries(content: string): Array<PiSessionHeader | SessionEntry>
  SettingsManager: {
    create(
      cwd: string,
      agentDir: string,
      options?: { projectTrusted?: boolean }
    ): SettingsManagerLike
  }
  ModelRuntime: {
    create(options: {
      authPath: string
      modelsPath: string
      allowModelNetwork?: boolean
    }): Promise<ModelRuntimeLike>
  }
  DefaultPackageManager: new (options: {
    cwd: string
    agentDir: string
    settingsManager: SettingsManagerLike
    builtinExtensions?: string[]
  }) => PackageManagerLike
  loadProjectContextFiles(options: {
    cwd: string
    agentDir: string
  }): Array<{ path: string; content: string }>
  hasTrustRequiringProjectResources(cwd: string): boolean
}

export interface McpConfigModule {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
    servers: Array<{
      name: string
      config: Record<string, unknown>
      source: string
      scope?: 'global' | 'project' | 'extension'
      override?: string
    }>
    autoEnableCodemode?: boolean
    errors: string[]
    projectConfig?: string
  }
  updateMcpServerConfig(
    path: string,
    name: string,
    patch: { enabled?: boolean; exposure?: string },
    options?: { override?: boolean }
  ): void
  addMcpServerConfig(path: string, name: string, config: Record<string, unknown>): boolean
  removeMcpServerConfig(path: string, name: string): boolean
}

export interface KeybindingsModule {
  /** Every TUI + app action with its platform default keys (pi `dist/core/keybindings.d.ts`). */
  KEYBINDINGS: Record<string, { defaultKeys: string | readonly string[]; description: string }>
  /** Renames legacy action ids and orders the config like pi does. */
  migrateKeybindingsConfig(raw: Record<string, unknown>): {
    config: Record<string, unknown>
    migrated: boolean
  }
}

export interface PiAiModule {
  /** Thinking levels a model supports (pi-ai models.d.ts). */
  getSupportedThinkingLevels(model: Pick<ModelLike, 'reasoning' | 'thinkingLevelMap'>): string[]
}

export interface PiAiEnvKeysModule {
  /** API-key variables of a provider that are set in `env` (pi-ai `dist/env-api-keys.d.ts`). */
  findEnvKeys(provider: string, env?: Record<string, string | undefined>): string[] | undefined
}

/** `dist/config.js`: paths and constants (not part of the typed package exports). */
export interface PiConfigModule {
  VERSION: string
  getAgentDir(): string
  /** The engine's share viewer link for a gist (honours `PI_SHARE_VIEWER_URL`). */
  getShareViewerUrl?: (gistId: string) => string
}

/** `dist/core/trust-manager.js` (exported from `dist/index.d.ts`). */
export interface TrustModule {
  hasTrustRequiringProjectResources(cwd: string): boolean
  ProjectTrustStore: new (agentDir: string) => {
    getEntry(cwd: string): { path: string; decision: boolean } | null
    set(cwd: string, decision: boolean | null): void
  }
}

/** `dist/utils/paths.js`. */
export interface PathsModule {
  /** Expands `~`, `file://` URLs and Git Bash drive paths (`/c/...`) the way settings paths are read. */
  normalizePath(input: string): string
}

/** Import a file inside the installed pi package (`dist/...`); `T` mirrors that file's `.d.ts`. */
async function importPiDist<T>(override: string | null, ...segments: string[]): Promise<T> {
  const location = await locateEngine(override)
  return importPiFile<T>(join(location.packageDir, 'dist', ...segments))
}

export function piConfig(override: string | null): Promise<PiConfigModule> {
  return importPiDist<PiConfigModule>(override, 'config.js')
}

export function piTrust(override: string | null): Promise<TrustModule> {
  return importPiDist<TrustModule>(override, 'core', 'trust-manager.js')
}

export function piPaths(override: string | null): Promise<PathsModule> {
  return importPiDist<PathsModule>(override, 'utils', 'paths.js')
}

/** `dist/core/session-manager.js`: reading and editing saved sessions (loaded on the first such operation). */
export function piSessions(
  override: string | null
): Promise<
  Pick<PiSdkSurface, 'SessionManager' | 'CURRENT_SESSION_VERSION' | 'parseSessionEntries'>
> {
  return importPiDist(override, 'core', 'session-manager.js')
}

/** `dist/core/model-runtime.js`: loads pi-ai with every provider; only sign-in and sign-out import it. */
export function piModelRuntime(
  override: string | null
): Promise<Pick<PiSdkSurface, 'ModelRuntime'>> {
  return importPiDist(override, 'core', 'model-runtime.js')
}

/** `dist/core/settings-manager.js`: the device id a sign-in reports. */
export function piSettingsManager(
  override: string | null
): Promise<Pick<PiSdkSurface, 'SettingsManager'>> {
  return importPiDist(override, 'core', 'settings-manager.js')
}

export function piMcpConfig(override: string | null): Promise<McpConfigModule> {
  return importPiDist<McpConfigModule>(override, 'extensions', 'mcp', 'config.js')
}
