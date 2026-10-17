import type { ShareDestination, ShareReadiness, ShareSessionResult } from '@shared/api/sessions'
import type {
  ConfiguredPackage,
  ModelLike,
  PackageUpdate,
  ResolvedPaths
} from '../../features/settings/pi-modules'
import type { HostProvider } from '../../features/settings/provider-host-protocol'

/**
 * Messages between the main process and the SDK host (`host.ts`): a short-lived child process that
 * runs the installed engine's SDK, so the main process never loads it. Types only: the host bundle
 * must not share code with the main bundle.
 */

export interface SdkHostConfig {
  role: 'sdk'
  /** The installed engine package (`<...>/node_modules/@earendil-works/pi-coding-agent`). */
  packageDir: string
}

/** The model facts thinking levels depend on (pi-ai `getSupportedThinkingLevels`). */
export type LevelModel = Pick<ModelLike, 'reasoning' | 'thinkingLevelMap'>

export interface CatalogModel extends ModelLike {
  available: boolean
  thinkingLevels: string[]
}

/** The engine's ModelRuntime with built-in providers and models.json (no extensions). */
export interface RuntimeCatalog {
  providers: HostProvider[]
  models: CatalogModel[]
  /** Environment variables each provider reads, for the runtime's providers and `extraProviderIds`. */
  envVars: Record<string, string[]>
  /** Thinking levels of `extraModels`, in their order. */
  extraLevels: string[][]
  error?: string
}

/** A package manager the way the engine builds it for `cwd` (the project root or the agent dir). */
export interface PackageScope {
  cwd: string
  agentDir: string
  projectTrusted: boolean
}

/** Every operation: `[arguments, result]`. */
export interface SdkHostOps {
  'share-readiness': [args: PackageScope, result: ShareReadiness]
  'share-session': [
    args: PackageScope & {
      sessionPath: string
      expectedDestination?: ShareDestination
    },
    result: ShareSessionResult
  ]
  catalog: [
    args: { agentDir: string; extraModels: LevelModel[]; extraProviderIds: string[] },
    result: RuntimeCatalog
  ]
  /**
   * Whether `openai` uses a ChatGPT sign-in and, with `fetch`, the model ids the account offers. Main decides
   * `fetch` (due, not paused by Work offline); the host never reads its environment for it.
   */
  'account-models': [
    args: { agentDir: string; fetch: boolean },
    result: { usingOAuth: boolean; ids: string[] | null }
  ]
  packages: [
    args: PackageScope,
    result: { configured: ConfiguredPackage[]; resolved: ResolvedPaths }
  ]
  'package-updates': [
    args: PackageScope,
    result: { updates: PackageUpdate[]; configured: ConfiguredPackage[] }
  ]
  'context-files': [
    args: { cwd: string; agentDir: string },
    result: Array<{ path: string; bytes: number }>
  ]
  keybindings: [
    args: { config: Record<string, unknown> | null },
    result: {
      actions: Array<{ id: string; description: string; defaultKeys: string | string[] }>
      config: Record<string, unknown> | null
    }
  ]
  /** `npm view <name> version dist.tarball --json` through the engine package manager's npm runner. */
  'npm-view': [args: PackageScope & { name: string }, result: string | null]
  /** Load the modules Settings sections use (model runtime, settings and package managers) ahead of their calls. */
  warm: [args: Record<string, never>, result: void]
}

export type SdkHostOp = keyof SdkHostOps
export type SdkHostArgs<K extends SdkHostOp> = SdkHostOps[K][0]
export type SdkHostResult<K extends SdkHostOp> = SdkHostOps[K][1]

/** Main → host. */
export interface SdkHostRequest {
  id: number
  type: 'call'
  op: SdkHostOp
  args: unknown
}

/** Host → main, for the request with the same `id`. */
export type SdkHostMessage =
  { id: number; type: 'result'; value: unknown } | { id: number; type: 'error'; message: string }
