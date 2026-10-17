import { shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ThinkingLevel } from '@shared/engine-types'
import type {
  AuthCheckResult,
  AuthFlowEvent,
  AuthFlowPrompt,
  CredentialSource,
  JsonObject,
  ModelCatalog,
  ModelInfo,
  ModelsJsonState,
  ProviderInfo,
  StartLoginArgs,
  ValidationIssue
} from '@shared/api/settings'
import { MODEL_API_TYPES } from '@shared/api/settings'
import type { EngineManager } from '../../engine/manager'
import { locateEngine, type EngineLocation } from '../../engine/locate'
import { sdkHostCall } from '../../engine/sdk-host/client'
import type { LevelModel, RuntimeCatalog } from '../../engine/sdk-host/protocol'
import { env } from '../../env'
import { childBaseEnv } from '../../shell-env'
import { hideUnofferedModels } from './account-models'
import { agentDir } from './agent-dir'
import { readStoredCatalog, storeCatalog } from './catalog-cache'
import { openEngineModels, withEngineModels } from './engine-models'
import { readJsonFile, serializeJson, updateJsonFile } from './json-file'
import { asJsonObject, maskModelsSecrets, restoreModelsSecrets, unresolvedSecretProviders } from './models-secrets'
import { runPiCli } from './pi-cli'
import { piModelRuntime, piSettingsManager, type AuthEventLike, type AuthPromptLike, type ModelLike, type ModelRuntimeLike } from './pi-modules'
import { cachedExtensionProviders, loginThroughHost, logoutThroughHost, refreshExtensionProviders } from './provider-host'

/**
 * Model catalog, provider readiness and login flows through the engine's ModelRuntime. The catalog comes from the
 * SDK host (`engine/sdk-host`); sign-in and sign-out run the runtime here, in main. Either runtime has the built-in
 * providers and models.json only: providers registered by extensions come from the provider host
 * (`provider-host.ts`), so no extension code runs in the main process.
 */

const ALL_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function authPath(): string {
  return join(agentDir(), 'auth.json')
}

function modelsPath(): string {
  return join(agentDir(), 'models.json')
}

/** The remote model catalog engines cache next to models.json (pi `FileModelsStore`). */
function modelsStorePath(): string {
  return join(agentDir(), 'models-store.json')
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function fileRevision(path: string): string {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

/** OAuth fields that change on every token refresh; the catalog never shows them. */
const TOKEN_FIELDS = new Set(['access', 'refresh', 'expires'])

/**
 * What of auth.json the runtime catalog depends on: every credential except the tokens a refresh rewrites, so
 * engines refreshing their sign-in do not invalidate it. An unparsable file counts as its raw text. Hashed: the
 * cache key keeps no key material.
 */
function credentialsRevision(): string {
  const text = readText(authPath())
  if (text === null) return 'missing'
  let revision = text
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>
    revision = JSON.stringify(
      Object.entries(data).map(([provider, credential]) => [
        provider,
        credential && typeof credential === 'object'
          ? Object.entries(credential).filter(([field]) => !TOKEN_FIELDS.has(field))
          : credential
      ])
    )
  } catch {
    // Mid-write or hand-broken: the raw text is the revision.
  }
  return createHash('sha256').update(revision).digest('hex')
}

const levelKey = (model: LevelModel) => JSON.stringify([model.reasoning, model.thinkingLevelMap ?? null])

/** A runtime catalog with the thinking levels known for each (reasoning, level map) pair. */
interface KnownCatalog {
  catalog: RuntimeCatalog
  levels: Map<string, string[]>
}

let catalogCache: { key: string; known: Promise<KnownCatalog> } | null = null
/** The extra models and providers the last catalog asked about, for a background refill. */
let lastCatalogExtras: { extraModels: LevelModel[]; extraProviderIds: string[] } | null = null
let refillTimer: NodeJS.Timeout | null = null
/** A sign-in writes auth.json several times; one refill follows the burst. */
const CATALOG_REFILL_DELAY_MS = 1_000

/**
 * What the runtime catalog is built from: the installed engine, auth.json without refreshed tokens, models.json, the
 * cached remote catalog, the environment's variable names (providers signed in through the environment; never the
 * values) and the extension providers asked about. settings.json is not an input: the host's ModelRuntime reads
 * only auth.json, models.json and models-store.json.
 */
function catalogInputs(location: EngineLocation, extraProviderIds: string[]): string[] {
  return [
    location.packageDir,
    location.version,
    credentialsRevision(),
    fileRevision(modelsPath()),
    fileRevision(modelsStorePath()),
    JSON.stringify(Object.keys(childBaseEnv()).sort()),
    JSON.stringify(extraProviderIds)
  ]
}

/** Positions in catalogInputs() of the two files the engine creates when they are missing. */
const CREDENTIALS_INPUT = 2
const MODELS_STORE_INPUT = 4
/** credentialsRevision() of an auth.json without credentials (what the engine writes when it creates one). */
const NO_CREDENTIALS = createHash('sha256').update(JSON.stringify([])).digest('hex')

/**
 * The input was missing before the read and the read itself created it: an empty auth.json, or the remote catalog
 * the engine fetched while building this catalog. A file the user created meanwhile (first models.json, first
 * sign-in) is a change the older catalog does not know.
 */
function createdByRead(index: number, before: string, after: string): boolean {
  if (before !== 'missing') return false
  if (index === CREDENTIALS_INPUT) return after === NO_CREDENTIALS
  return index === MODELS_STORE_INPUT
}

function catalogKey(inputs: string[]): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

/**
 * Levels of every catalog model plus `extraLevels` (pairs asked about before). Levels depend only on the pair, and an
 * unset level map reads like an empty one (pi-ai `getSupportedThinkingLevels`), the way open engines send it.
 */
function knownLevels(catalog: RuntimeCatalog, extraLevels: Record<string, string[]>): Map<string, string[]> {
  const levels = new Map(Object.entries(extraLevels))
  for (const model of catalog.models) {
    levels.set(levelKey(model), model.thinkingLevels)
    levels.set(levelKey({ reasoning: model.reasoning, thinkingLevelMap: { ...model.thinkingLevelMap } }), model.thinkingLevels)
  }
  return levels
}

/**
 * Build the catalog in the SDK host and store it for the next launch. The engine creates a missing auth.json and
 * models-store.json while it reads them, so the catalog is stored under the inputs after the read, but only when
 * nothing else changed meanwhile (an edit during the read must not be claimed by an older catalog).
 */
function loadRuntimeCatalog(override: string | null, location: EngineLocation, inputs: string[], extraModels: LevelModel[], extraProviderIds: string[]): Promise<KnownCatalog> {
  const known = sdkHostCall(override, 'catalog', { agentDir: agentDir(), extraModels, extraProviderIds }).then((catalog) => {
    const extraLevels = Object.fromEntries(extraModels.map((model, index) => [levelKey(model), catalog.extraLevels[index] ?? []]))
    const after = catalogInputs(location, extraProviderIds)
    const unchanged = after.every(
      (value, index) => value === inputs[index] || createdByRead(index, inputs[index]!, value)
    )
    // A catalog the engine could not fully read is not kept for the next launch.
    if (unchanged && !catalog.error) {
      const key = catalogKey(after)
      storeCatalog({ key, catalog: { ...catalog, extraLevels: [] }, levels: extraLevels })
      if (catalogCache === entry) entry.key = key
    }
    return { catalog, levels: knownLevels(catalog, extraLevels) }
  })
  const entry = { key: catalogKey(inputs), known }
  catalogCache = entry
  known.catch(() => {
    if (catalogCache === entry) catalogCache = null
  })
  return known
}

/**
 * The runtime catalog, kept in memory and in userData while its inputs are unchanged (`catalogKey`). A repeat, a new
 * launch or an open engine's models with known levels are answered without starting the SDK host.
 */
async function runtimeCatalog(override: string | null, extraModels: LevelModel[], extraProviderIds: string[]): Promise<KnownCatalog> {
  const location = await locateEngine(override)
  const inputs = catalogInputs(location, extraProviderIds)
  const key = catalogKey(inputs)
  lastCatalogExtras = { extraModels, extraProviderIds }
  if (catalogCache?.key !== key) {
    const stored = readStoredCatalog(key)
    catalogCache = stored ? { key, known: Promise.resolve({ catalog: stored.catalog, levels: knownLevels(stored.catalog, stored.levels) }) } : null
  }
  const cached = await catalogCache?.known.catch(() => null)
  if (cached && extraModels.every((model) => cached.levels.has(levelKey(model)))) return cached
  return loadRuntimeCatalog(override, location, inputs, extraModels, extraProviderIds)
}

/**
 * models.json or the signed-in providers changed: rebuild the runtime catalog in the background, so the next model
 * picker or Settings visit finds it ready. The catalog operation is local (no model network, no account fetch).
 * Before any catalog was asked for there is nothing to refill.
 */
export function refillModelCatalog(override: string | null): void {
  if (refillTimer) clearTimeout(refillTimer)
  refillTimer = setTimeout(() => {
    refillTimer = null
    if (!lastCatalogExtras) return
    const { extraModels, extraProviderIds } = lastCatalogExtras
    runtimeCatalog(override, extraModels, extraProviderIds).catch(() => undefined)
  }, CATALOG_REFILL_DELAY_MS)
  refillTimer.unref()
}

/** Masked description of a stored credential (never the secret itself). */
function storedCredential(raw: unknown): ProviderInfo['stored'] {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as { type?: unknown; key?: unknown; expires?: unknown }
  if (entry.type === 'oauth') return { type: 'oauth', expiresAt: typeof entry.expires === 'number' ? entry.expires : undefined }
  if (entry.type !== 'api_key') return undefined
  const key = typeof entry.key === 'string' ? entry.key : ''
  if (key.startsWith('!')) return { type: 'api_key', command: true, hint: 'Command' }
  if (/^\$\{?[A-Z0-9_]+\}?$/i.test(key)) return { type: 'api_key', hint: key }
  if (key.length >= 12) return { type: 'api_key', hint: `${key.slice(0, 4)}…${key.slice(-4)}` }
  return { type: 'api_key', hint: key ? '••••' : undefined }
}

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`

function toModelInfo(model: ModelLike, available: boolean, levels: string[], fromExtension: boolean): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
    available,
    thinkingLevels: levels.filter((level): level is ThinkingLevel => (ALL_LEVELS as string[]).includes(level)),
    fromExtension: fromExtension || undefined
  }
}

/** An open engine's model as its thinking levels are read (a missing level map counts as an empty one). */
function engineLevelModel<T extends LevelModel>(model: T): T {
  return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap } }
}

/**
 * Built-in and models.json providers, plus the extension providers the provider host read last (the catalog never
 * starts the provider host), with open engines' model facts.
 */
export async function modelCatalog(override: string | null, manager: EngineManager): Promise<ModelCatalog> {
  const [extensions, engineModels] = await Promise.all([cachedExtensionProviders(override), openEngineModels(manager)])
  // Levels depend only on these two facts, so each distinct pair is asked about once.
  const levelModels = [...(extensions?.models ?? []), ...engineModels.map(engineLevelModel)]
  const extraModels = [...new Map(levelModels.map((model) => [levelKey(model), { reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap }])).values()]
  const extensionProviderIds = (extensions?.providers ?? []).map((provider) => provider.id)
  const { catalog: runtime, levels } = await runtimeCatalog(override, extraModels, extensionProviderIds)
  const levelsOf = (model: LevelModel) => levels.get(levelKey(model)) ?? []
  const stored = readJsonFile(authPath()).data

  const ownModels = hideUnofferedModels(runtime.models).map((model) => toModelInfo(model, model.available, model.thinkingLevels, false))
  const ownKeys = new Set(ownModels.map(modelKey))
  const extensionModels = (extensions?.models ?? [])
    .filter((model) => !ownKeys.has(modelKey(model)))
    .map((model) => toModelInfo(model, model.available, levelsOf(model), true))
  const { models, engineOnly } = withEngineModels([...ownModels, ...extensionModels], engineModels)
  const sessionModels = engineOnly.map(engineLevelModel).map((model) => toModelInfo(model, true, levelsOf(model), true))

  const ownIds = new Set(runtime.providers.map((provider) => provider.id))
  const extensionProviders = (extensions?.providers ?? []).filter((provider) => !ownIds.has(provider.id))
  const extensionIds = new Set(extensionProviders.map((provider) => provider.id))
  const providers: ProviderInfo[] = [...runtime.providers, ...extensionProviders].map((provider) => {
    const providerModels = models.filter((model) => model.provider === provider.id)
    return {
      id: provider.id,
      name: provider.name,
      oauth: provider.oauth ? { name: provider.oauth.name, loginLabel: provider.oauth.loginLabel, subscription: provider.oauth.isSubscription === true } : undefined,
      apiKey: provider.apiKey,
      status: {
        configured: provider.status.configured,
        source: provider.status.source as CredentialSource | undefined,
        label: provider.status.label,
        usingOAuth: provider.usingOAuth
      },
      stored: storedCredential(stored[provider.id]),
      envVars: runtime.envVars[provider.id] ?? [],
      fromExtension: extensionIds.has(provider.id) || undefined,
      modifiedBy: extensions?.modifiedBy[provider.id],
      modelCount: providerModels.length,
      availableCount: providerModels.filter((model) => model.available).length
    }
  })
  providers.sort((a, b) => Number(b.status.configured) - Number(a.status.configured) || a.name.localeCompare(b.name))
  return { providers, models, sessionModels, error: runtime.error }
}

/** Re-read the extension providers; when that fails the catalog keeps every built-in and models.json provider. */
async function refreshCachedExtensionProviders(override: string | null): Promise<void> {
  try {
    await refreshExtensionProviders(override)
  } catch {
    // Extensions that fail to load are reported by the engine in its sessions.
  }
}

/** The catalog with the extension providers re-read: what the Providers page shows. */
export async function catalogWithExtensionProviders(override: string | null, manager: EngineManager): Promise<ModelCatalog> {
  await refreshCachedExtensionProviders(override)
  return modelCatalog(override, manager)
}

// ─── Login flows ──────────────────────────────────────────────────────────

interface PendingPrompt {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

interface LoginSession {
  controller: AbortController
  prompts: Map<string, PendingPrompt>
}

const logins = new Map<string, LoginSession>()

function toFlowPrompt(prompt: AuthPromptLike): AuthFlowPrompt {
  if (prompt.type === 'select') return { type: 'select', message: prompt.message, options: [...(prompt.options ?? [])] }
  return { type: prompt.type, message: prompt.message, placeholder: prompt.placeholder }
}

function openUrl(url: string): void {
  if (env.mock || !/^https?:\/\//i.test(url)) return
  void shell.openExternal(url)
}

function interaction(loginId: string, session: LoginSession, emit: (event: AuthFlowEvent) => void) {
  return {
    signal: session.controller.signal,
    prompt(prompt: AuthPromptLike): Promise<string> {
      const promptId = randomUUID()
      return new Promise<string>((resolve, reject) => {
        session.prompts.set(promptId, { resolve, reject })
        prompt.signal?.addEventListener(
          'abort',
          () => {
            if (!session.prompts.delete(promptId)) return
            emit({ loginId, kind: 'prompt-cancelled', promptId })
            reject(new Error('Login cancelled'))
          },
          { once: true }
        )
        emit({ loginId, kind: 'prompt', promptId, prompt: toFlowPrompt(prompt) })
      })
    },
    notify(event: AuthEventLike): void {
      if (event.type === 'auth_url' && event.url) {
        openUrl(event.url)
        emit({ loginId, kind: 'notice', notice: { type: 'auth_url', url: event.url, instructions: event.instructions } })
      } else if (event.type === 'device_code' && event.userCode && event.verificationUri) {
        emit({ loginId, kind: 'notice', notice: { type: 'device_code', userCode: event.userCode, verificationUri: event.verificationUri, expiresInSeconds: event.expiresInSeconds } })
      } else if (event.type === 'info') {
        emit({ loginId, kind: 'notice', notice: { type: 'info', message: event.message ?? '', links: event.links ? [...event.links] : undefined } })
      } else {
        emit({ loginId, kind: 'notice', notice: { type: 'progress', message: event.message ?? '' } })
      }
    }
  }
}

/** Mock mode: a scripted browser sign-in (no network, nothing written). */
function mockOAuthFlow(providerId: string, ui: ReturnType<typeof interaction>): Promise<void> {
  if (providerId === 'github-copilot') {
    ui.notify({ type: 'device_code', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresInSeconds: 900 })
    ui.notify({ type: 'progress', message: 'Waiting for authorization…' })
    return ui.prompt({ type: 'manual_code', message: 'Waiting for GitHub. Press Continue once you approved the device.' }).then(() => undefined)
  }
  ui.notify({ type: 'auth_url', url: `https://auth.example.com/oauth/authorize?client_id=vengeance&provider=${providerId}&response_type=code`, instructions: 'Complete sign-in in your browser.' })
  ui.notify({ type: 'progress', message: 'Waiting for the browser…' })
  return ui.prompt({ type: 'manual_code', message: 'Browser on another machine? Paste the redirect URL or authorization code.', placeholder: 'https://localhost/callback?code=…' }).then(() => undefined)
}

/** A runtime of the built-in providers and models.json for one sign-in or sign-out (see pi-modules.ts). */
async function signInRuntime(override: string | null): Promise<ModelRuntimeLike> {
  const { ModelRuntime } = await piModelRuntime(override)
  return ModelRuntime.create({ authPath: authPath(), modelsPath: modelsPath(), allowModelNetwork: false })
}

function hasProvider(runtime: ModelRuntimeLike, providerId: string): boolean {
  return runtime.getProviders().some((provider) => provider.id === providerId)
}

export async function startLogin(override: string | null, args: StartLoginArgs, emit: (event: AuthFlowEvent) => void, onSuccess: () => void): Promise<string> {
  const loginId = randomUUID()
  const session: LoginSession = { controller: new AbortController(), prompts: new Map() }
  logins.set(loginId, session)
  const ui = interaction(loginId, session, emit)
  const run = async () => {
    if (env.mock && args.method === 'oauth') return mockOAuthFlow(args.providerId, ui)
    const runtime = await signInRuntime(override)
    if (!hasProvider(runtime, args.providerId)) {
      await loginThroughHost(override, args.providerId, args.method, ui)
      await refreshCachedExtensionProviders(override)
      return
    }
    const { SettingsManager } = await piSettingsManager(override)
    const settings = SettingsManager.create(agentDir(), agentDir())
    await runtime.login(args.providerId, args.method, ui, { getDeviceId: () => settings.getOrCreateDeviceId(), agentName: 'Vengeance' })
    await settings.flush()
  }
  void run().then(
    () => {
      logins.delete(loginId)
      emit({ loginId, kind: 'done', ok: true })
      onSuccess()
    },
    (error: Error) => {
      logins.delete(loginId)
      const cancelled = session.controller.signal.aborted || /cancel/i.test(error.message)
      emit({ loginId, kind: 'done', ok: false, cancelled, error: cancelled ? undefined : error.message })
    }
  )
  return loginId
}

export function respondLogin(loginId: string, promptId: string, value: string | null): void {
  const pending = logins.get(loginId)?.prompts.get(promptId)
  if (!pending) return
  logins.get(loginId)!.prompts.delete(promptId)
  if (value === null) pending.reject(new Error('Login cancelled'))
  else pending.resolve(value)
}

export function cancelLogin(loginId: string): void {
  const session = logins.get(loginId)
  if (!session) return
  session.controller.abort()
  for (const pending of session.prompts.values()) pending.reject(new Error('Login cancelled'))
  session.prompts.clear()
}

export async function logout(override: string | null, providerId: string): Promise<void> {
  const runtime = await signInRuntime(override)
  if (hasProvider(runtime, providerId)) {
    await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) })
    return
  }
  await logoutThroughHost(override, providerId)
  await refreshCachedExtensionProviders(override)
}

/** `pi auth check --provider <id> --json` — the engine's own readiness check (refreshes OAuth tokens). */
export async function checkAuth(override: string | null, providerId: string): Promise<AuthCheckResult> {
  const args = ['auth', 'check', '--provider', providerId, '--json']
  if (env.mock) args.push('--no-refresh')
  const result = await runPiCli(override, args, { cwd: agentDir(), timeoutMs: 30_000 })
  const line = result.stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'))
  if (line) {
    try {
      const parsed = JSON.parse(line) as { status?: string; authType?: string; reason?: string }
      if (parsed.status === 'ready' || parsed.status === 'not_ready' || parsed.status === 'invalid') {
        return { status: parsed.status, authType: parsed.authType, reason: parsed.reason }
      }
    } catch {
      // Fall through to the diagnostic result.
    }
  }
  return { status: 'invalid', detail: (result.stderr || result.stdout).trim().slice(0, 600) || `Exited with code ${result.code}` }
}

// ─── models.json ──────────────────────────────────────────────────────────

export function readModelsJson(): ModelsJsonState {
  const path = modelsPath()
  const file = readJsonFile(path)
  if (file.error) return { path, exists: file.exists, data: {}, text: '', error: file.error }
  const data = maskModelsSecrets(file.data)
  return { path, exists: file.exists, data, text: file.exists ? serializeJson(data) : '' }
}

const KNOWN_APIS = new Set<string>(MODEL_API_TYPES)

export function validateModelsJson(data: JsonObject): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const providers = data.providers
  if (providers === undefined) return issues
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [{ severity: 'error', key: 'providers', message: 'providers must be an object.' }]
  for (const [id, raw] of Object.entries(providers)) {
    const key = `providers.${id}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ severity: 'error', key, message: `${id} must be an object.` })
      continue
    }
    const provider = raw as JsonObject
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) issues.push({ severity: 'error', key, message: `Provider id "${id}" may only contain letters, digits, ".", "_" and "-".` })
    if (provider.baseUrl !== undefined && (typeof provider.baseUrl !== 'string' || !/^https?:\/\//.test(provider.baseUrl))) {
      issues.push({ severity: 'error', key: `${key}.baseUrl`, message: `${id}: base URL must start with http:// or https://.` })
    }
    if (provider.api !== undefined && (typeof provider.api !== 'string' || !KNOWN_APIS.has(provider.api))) {
      issues.push({ severity: 'warning', key: `${key}.api`, message: `${id}: "${String(provider.api)}" is not a built-in API type.` })
    }
    const overrides = provider.modelOverrides
    if (overrides !== undefined) {
      const entries = asJsonObject(overrides)
      if (!entries) issues.push({ severity: 'error', key: `${key}.modelOverrides`, message: `${id}: modelOverrides must be an object keyed by model id.` })
      for (const [modelId, raw] of Object.entries(entries ?? {})) {
        const ok = `${key}.modelOverrides.${modelId}`
        const override = asJsonObject(raw)
        if (!override) {
          issues.push({ severity: 'error', key: ok, message: `${id}/${modelId}: the override must be an object.` })
          continue
        }
        for (const field of ['contextWindow', 'maxTokens'] as const) {
          const value = override[field]
          if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
            issues.push({ severity: 'error', key: `${ok}.${field}`, message: `${id}/${modelId}: ${field} must be a positive whole number.` })
          }
        }
      }
    }
    const models = provider.models
    if (models !== undefined) {
      if (!Array.isArray(models)) {
        issues.push({ severity: 'error', key: `${key}.models`, message: `${id}: models must be a list.` })
        continue
      }
      const seen = new Set<string>()
      models.forEach((m, index) => {
        const mk = `${key}.models.${index}`
        if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.id !== 'string' || !m.id.trim()) {
          issues.push({ severity: 'error', key: mk, message: `${id}: model #${index + 1} needs an id.` })
          return
        }
        if (seen.has(m.id)) issues.push({ severity: 'error', key: mk, message: `${id}: duplicate model id "${m.id}".` })
        seen.add(m.id)
        for (const field of ['contextWindow', 'maxTokens'] as const) {
          const value = m[field]
          if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
            issues.push({ severity: 'error', key: `${mk}.${field}`, message: `${id}/${m.id}: ${field} must be a positive whole number.` })
          }
        }
      })
    }
  }
  return issues
}

export async function writeModelsJson(override: string | null, data: JsonObject): Promise<ModelsJsonState> {
  const errors = validateModelsJson(data).filter((i) => i.severity === 'error')
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('\n'))
  await updateJsonFile(
    modelsPath(),
    override,
    (current) => {
      const restored = restoreModelsSecrets(data, current)
      const unresolved = unresolvedSecretProviders(restored)
      if (unresolved.length > 0) throw new Error(`Re-enter the API key for ${unresolved.join(', ')}.`)
      return restored
    },
    { private: true }
  )
  return readModelsJson()
}
