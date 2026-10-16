import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  AuthEventLike,
  AuthInteractionLike,
  AuthPromptLike,
  ModelRuntimeLike,
  ProviderLike
} from '../../features/settings/pi-modules'
import type { HostProvider } from '../../features/settings/provider-host-protocol'

/**
 * Engine access shared by both roles of the host bundle (the SDK host and the provider host). Runs in
 * the host process only: the main bundle must not import this file, or the two bundles would share a
 * chunk that the engine's node cannot read from inside app.asar.
 */

// Native dynamic import that survives the CommonJS bundle (rollup must not rewrite it to require()).
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

/** Import a file inside the installed engine package; `T` mirrors that file's `.d.ts`. */
export function importEngineFile<T>(packageDir: string, ...segments: string[]): Promise<T> {
  // SAFETY: protocol boundary — `T` mirrors the matching `.d.ts` of the installed engine.
  return importEsm(pathToFileURL(join(packageDir, 'dist', ...segments)).href) as Promise<T>
}

/** How many folders up from the engine package `@earendil-works/pi-ai` may be installed. */
const PI_AI_SEARCH_DEPTH = 6

/**
 * `@earendil-works/pi-ai` as installed next to (or inside) the engine package. Its `exports` map does not
 * expose package.json, so the entry is located by walking up node_modules folders.
 */
function piAiPackageDir(packageDir: string): string {
  let dir = packageDir
  for (let depth = 0; depth < PI_AI_SEARCH_DEPTH; depth++) {
    for (const candidate of [
      join(dir, 'node_modules', '@earendil-works', 'pi-ai'),
      join(dirname(dir), 'pi-ai')
    ]) {
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    dir = dirname(dir)
  }
  throw new Error('The engine dependency @earendil-works/pi-ai was not found.')
}

type PackageEntry = { exports?: { '.'?: { import?: string } }; main?: string }

/** The package's ESM entry; an unreadable package.json falls back to pi-ai's usual `dist/index.js`. */
function entryOf(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageEntry
    return pkg.exports?.['.']?.import ?? pkg.main ?? 'dist/index.js'
  } catch {
    return 'dist/index.js'
  }
}

/** Import a file of the installed pi-ai; no `segments` imports its package entry. */
export function importPiAiFile<T>(packageDir: string, ...segments: string[]): Promise<T> {
  const dir = piAiPackageDir(packageDir)
  const file = segments.length > 0 ? join(dir, ...segments) : join(dir, entryOf(dir))
  return importEsm(pathToFileURL(file).href) as Promise<T>
}

/** A provider of a model runtime, as the settings catalog describes it. */
export function describeProvider(runtime: ModelRuntimeLike, provider: ProviderLike): HostProvider {
  const { apiKey, oauth } = provider.auth
  const status = runtime.getProviderAuthStatus(provider.id)
  return {
    id: provider.id,
    name: provider.name,
    oauth: oauth
      ? { name: oauth.name, loginLabel: oauth.loginLabel, isSubscription: oauth.isSubscription }
      : undefined,
    apiKey: apiKey ? { name: apiKey.name, interactive: typeof apiKey.login === 'function' } : undefined,
    status: { configured: status.configured, source: status.source, label: status.label },
    usingOAuth: status.configured && runtime.isUsingOAuth(provider.id)
  }
}

/** Host → main messages of a sign-in. */
export type SignInMessage =
  | { id: number; type: 'prompt'; promptId: number; prompt: Omit<AuthPromptLike, 'signal'> }
  | { id: number; type: 'prompt-cancelled'; promptId: number }
  | { id: number; type: 'notice'; event: AuthEventLike }

interface SignIn {
  controller: AbortController
  prompts: Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>
}

/**
 * Sign-ins running in the host. The engine's login flow asks through `interaction(id)`; its prompts
 * travel to main and come back with `respond`, and `cancel` aborts the flow.
 */
export class SignIns {
  private readonly running = new Map<number, SignIn>()
  private nextPromptId = 0

  constructor(private readonly send: (message: SignInMessage) => void) {}

  /** Run `flow` as the sign-in for call `id`, with the interaction the engine's login expects. */
  async run<T>(id: number, flow: (interaction: AuthInteractionLike) => Promise<T>): Promise<T> {
    const state: SignIn = { controller: new AbortController(), prompts: new Map() }
    this.running.set(id, state)
    try {
      return await flow(this.interaction(id, state))
    } finally {
      this.running.delete(id)
    }
  }

  respond(id: number, promptId: number, value: string | null): void {
    const prompts = this.running.get(id)?.prompts
    const pending = prompts?.get(promptId)
    if (!prompts || !pending) return
    prompts.delete(promptId)
    if (value === null) pending.reject(new Error('Login cancelled'))
    else pending.resolve(value)
  }

  cancel(id: number): void {
    const state = this.running.get(id)
    if (!state) return
    state.controller.abort()
    for (const pending of state.prompts.values()) pending.reject(new Error('Login cancelled'))
    state.prompts.clear()
  }

  private interaction(id: number, state: SignIn): AuthInteractionLike {
    return {
      signal: state.controller.signal,
      prompt: (prompt: AuthPromptLike): Promise<string> => {
        const promptId = ++this.nextPromptId
        const { signal, ...wire } = prompt
        return new Promise<string>((resolve, reject) => {
          state.prompts.set(promptId, { resolve, reject })
          signal?.addEventListener(
            'abort',
            () => {
              if (!state.prompts.delete(promptId)) return
              this.send({ id, type: 'prompt-cancelled', promptId })
              reject(new Error('Login cancelled'))
            },
            { once: true }
          )
          this.send({ id, type: 'prompt', promptId, prompt: wire })
        })
      },
      notify: (event: AuthEventLike): void => {
        this.send({ id, type: 'notice', event })
      }
    }
  }
}
