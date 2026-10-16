import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appState } from '../../app-state'
import { sdkHostCall } from '../../engine/sdk-host/client'
import { env } from '../../env'
import { agentDir } from './agent-dir'
import { readJsonFile } from './json-file'

/**
 * Models a ChatGPT sign-in can use. The `openai` provider's catalog lists every API model; with Sign in with
 * ChatGPT the account reaches only the models OpenAI lists for it (`GET /v1/models`). The list is fetched with the
 * Engine's own credential handling (pi ModelRuntime in the SDK host: OAuth refresh under pi's auth lock) and cached in userData as
 * model ids only. With an API key, or before the first fetch, nothing is hidden.
 */

export const ACCOUNT_PROVIDER = 'openai'

const MAX_AGE_MS = 6 * 60 * 60 * 1000

interface AccountModels {
  ids: string[]
  fetchedAt: number
}

type ModelRef = { provider: string; id: string }

let cached: AccountModels | null | undefined
let queue: Promise<unknown> = Promise.resolve()

function cachePath(): string {
  return join(app.getPath('userData'), 'account-models.json')
}

function isAccountModels(value: unknown): value is AccountModels {
  if (!value || typeof value !== 'object') return false
  const { ids, fetchedAt } = value as Partial<AccountModels>
  return (
    Array.isArray(ids) && ids.every((id) => typeof id === 'string') && typeof fetchedAt === 'number'
  )
}

function readCache(): AccountModels | null {
  if (cached !== undefined) return cached
  try {
    const value: unknown = JSON.parse(readFileSync(cachePath(), 'utf8'))
    cached = isAccountModels(value) ? value : null
  } catch {
    cached = null
  }
  return cached
}

function writeCache(next: AccountModels | null): void {
  cached = next
  const path = cachePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(next ?? {}), 'utf8')
    renameSync(`${path}.tmp`, path)
  } catch {
    // The in-memory list still applies for this run.
  }
}

/** Hides `openai` models the ChatGPT account does not offer; null when nothing is hidden. */
export function accountModelFilter(): ((model: ModelRef) => boolean) | null {
  const ids = readCache()?.ids
  if (!ids || ids.length === 0) return null
  const offered = new Set(ids)
  return (model) => model.provider !== ACCOUNT_PROVIDER || offered.has(model.id)
}

/**
 * Whether auth.json holds a ChatGPT sign-in for `openai` (pi `ModelRuntime.isUsingOAuth` reads the stored
 * credential's type); null when the file cannot be read, so the SDK host decides. Reads the type only.
 */
function storedAccountSignIn(): boolean | null {
  const file = readJsonFile(join(agentDir(), 'auth.json'))
  if (file.error) return null
  const credential = file.data[ACCOUNT_PROVIDER]
  return !!credential && typeof credential === 'object' && (credential as { type?: unknown }).type === 'oauth'
}

/** Signed out, or signed in with an API key: the account list no longer applies. */
function forgetAccountModels(previous: AccountModels | null): boolean {
  if (!previous) return false
  writeCache(null)
  return true
}

async function refresh(override: string | null, force: boolean): Promise<boolean> {
  const previous = readCache()
  const signedIn = storedAccountSignIn()
  if (signedIn === false) return forgetAccountModels(previous)
  const due = force || !previous || Date.now() - previous.fetchedAt >= MAX_AGE_MS
  // Work offline pauses the background reads; a sign-in through Vengeance (`force`) still reads the list.
  const paused = !force && appState.getPrefs().features.updates?.offline === true
  const shouldFetch = due && !paused
  // Signed in, nothing to read: keep the last list, as when a read fails.
  if (signedIn && !shouldFetch) return false
  const { usingOAuth, ids } = await sdkHostCall(override, 'account-models', {
    agentDir: agentDir(),
    fetch: shouldFetch
  })
  if (!usingOAuth) return forgetAccountModels(previous)
  // Not due, paused, unreachable or refused: keep the last list rather than show models the account may not have.
  if (!ids) return false
  const changed =
    !previous || previous.ids.length !== ids.length || previous.ids.some((id, i) => id !== ids[i])
  writeCache({ ids, fetchedAt: Date.now() })
  return changed
}

/**
 * Re-check the sign-in and re-read the account's models when the cached list is older than six hours (`force`: now,
 * e.g. after a sign-in). Work offline pauses the reads that are not forced. Runs one at a time; resolves true when
 * what is hidden changed. Never rejects.
 */
export function refreshAccountModels(override: string | null, force = false): Promise<boolean> {
  if (env.mock) return Promise.resolve(false)
  const run = queue.then(() => refresh(override, force)).catch(() => false)
  queue = run
  return run
}

export function hideUnofferedModels<T extends ModelRef>(models: readonly T[]): T[] {
  const offered = accountModelFilter()
  return offered ? models.filter(offered) : [...models]
}
