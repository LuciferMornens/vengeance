import type { AuthEventLike, AuthPromptLike, ModelLike } from './pi-modules'

/**
 * Messages between the main process and the provider host (`provider-host-entry.ts`), a short-lived child process
 * that loads the engine's extensions so the main process never runs extension code. Types only: the host bundle
 * must not share code with the main bundle.
 */

/** What the host needs to load the extensions the engine would load for the active workspace. */
export interface ProviderHostConfig {
  role: 'extensions'
  /** The installed engine package (`<...>/node_modules/@earendil-works/pi-coding-agent`). */
  packageDir: string
  agentDir: string
  /** Project root of the active workspace, or the agent dir without one. */
  cwd: string
  /** Project extensions load only when the engine would trust the project. */
  projectTrusted: boolean
}

/** A provider an extension registers, as the engine's ModelRuntime describes it. */
export interface HostProvider {
  id: string
  name: string
  oauth?: { name: string; loginLabel?: string; isSubscription?: boolean }
  apiKey?: { name: string; interactive: boolean }
  status: { configured: boolean; source?: string; label?: string }
  usingOAuth: boolean
}

export interface HostModel extends ModelLike {
  available: boolean
}

export interface ExtensionProviders {
  /** Providers only extensions register (neither built in nor in models.json). */
  providers: HostProvider[]
  /** Models that exist only through extensions (their providers' models and virtual models). */
  models: HostModel[]
  /** Built-in and models.json providers an extension re-registers, by provider id: the extension's name. */
  modifiedBy: Record<string, string>
}

export type HostPrompt = Omit<AuthPromptLike, 'signal'>

/** A request the host answers with one `result` or `error` message. */
export type HostCall =
  | { type: 'extension-providers' }
  | { type: 'login'; providerId: string; method: 'oauth' | 'api_key' }
  | { type: 'logout'; providerId: string }

/** Main → host. `respond` and `cancel` address the login started by the call with the same `id`. */
export type HostRequest =
  | (HostCall & { id: number })
  | { id: number; type: 'respond'; promptId: number; value: string | null }
  | { id: number; type: 'cancel' }

/** Host → main, for the request with the same `id`. */
export type HostMessage =
  | { id: number; type: 'result'; value?: ExtensionProviders }
  | { id: number; type: 'error'; message: string }
  | { id: number; type: 'prompt'; promptId: number; prompt: HostPrompt }
  | { id: number; type: 'prompt-cancelled'; promptId: number }
  | { id: number; type: 'notice'; event: AuthEventLike }
