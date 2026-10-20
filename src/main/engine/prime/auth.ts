import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AuthCheckResult,
  AuthFlowEvent,
  JsonObject,
  ModelCatalog,
  ModelInfo,
  ModelsJsonState,
  ProviderInfo,
  StartLoginArgs,
  ValidationIssue
} from '@shared/api/settings'
import type { ThinkingLevel } from '@shared/engine-types'
import type { PrimeSettingsContext } from './configuration'
import {
  cancelPrimeOAuth,
  disposePrimeOAuth,
  respondPrimeOAuth,
  startPrimeOAuth
} from './auth-oauth'
import {
  assertSafeKey,
  jsonObject,
  jsonStrings,
  maskPrimeSecret,
  readPrimeJson,
  restorePrimeSecrets,
  safePrimeFileState,
  updatePrimeJson
} from './configuration-store'
import { childEnvVariable } from '../../shell-env'
import { getPrimeAgentDir } from './locate'
import { runPrimeTraces } from './traces'

const PROVIDER_ENVIRONMENT: Record<string, string[]> = {
  'prime-inference': ['PRIME_API_KEY'],
  'prime-agent-traces': ['PRIME_AGENT_TRACES_API_KEY', 'PRIME_API_KEY'],
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': [],
  'github-copilot': ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  'amazon-bedrock': ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_BEARER_TOKEN_BEDROCK'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  serper: ['SERPER_API_KEY']
}

const PROVIDER_NAMES: Record<string, string> = {
  'prime-inference': 'Prime Inference',
  'prime-agent-traces': 'Trace uploads',
  'openai-codex': 'ChatGPT Plus / Pro',
  'github-copilot': 'GitHub Copilot',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  'amazon-bedrock': 'Amazon Bedrock',
  'google-vertex': 'Google Vertex AI',
  xai: 'xAI',
  serper: 'Serper web search'
}

const SUBSCRIPTION_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot', 'xai'])
const NATIVE_ACCOUNT_PROVIDERS = new Set(['prime-inference', 'prime-agent-traces'])
const CREDENTIAL_ONLY_PROVIDERS = new Set(['serper', 'prime-agent-traces'])
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const API_KEY_LOGIN_TIMEOUT_MS = 10 * 60_000

interface ApiKeyLogin {
  promptId: string
  saving: boolean
  emit: (event: AuthFlowEvent) => void
  changed: () => void
  timeout: ReturnType<typeof setTimeout>
  store: (key: string) => Promise<void>
}

const apiKeyLogins = new Map<string, ApiKeyLogin>()

function providerName(identifier: string): string {
  return PROVIDER_NAMES[identifier] ?? identifier
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function modelInfo(raw: unknown, configured: Set<string>): ModelInfo | undefined {
  const model = jsonObject(raw)
  if (typeof model?.id !== 'string' || typeof model.provider !== 'string') return undefined
  const cost = jsonObject(model.cost) ?? {}
  const thinkingMap = jsonObject(model.thinkingLevelMap)
  const levels = thinkingMap
    ? THINKING_LEVELS.filter((level) => typeof thinkingMap[level] === 'string')
    : model.reasoning === true
      ? THINKING_LEVELS
      : ['off' as const]
  return {
    id: model.id,
    provider: model.provider,
    name: typeof model.name === 'string' ? model.name : model.id,
    api: typeof model.api === 'string' ? model.api : '',
    reasoning: model.reasoning === true,
    input: jsonStrings(model.input).filter((item): item is 'text' | 'image' =>
      ['text', 'image'].includes(item)
    ),
    contextWindow: numeric(model.contextWindow),
    maxTokens: numeric(model.maxTokens),
    cost: {
      input: numeric(cost.input),
      output: numeric(cost.output),
      cacheRead: numeric(cost.cacheRead),
      cacheWrite: numeric(cost.cacheWrite)
    },
    available: configured.has(model.provider),
    thinkingLevels: levels.length ? levels : ['off']
  }
}

function providerInfo(
  identifier: string,
  auth: JsonObject,
  custom: JsonObject,
  models: ModelInfo[],
  configured: Set<string>
): ProviderInfo {
  const stored = jsonObject(auth[identifier])
  const envVars = PROVIDER_ENVIRONMENT[identifier] ?? []
  const environment = envVars.find((variable) => !!childEnvVariable(variable))
  const customKey = jsonObject(custom[identifier])?.apiKey
  const usingOAuth = stored?.type === 'oauth'
  const hasStored = stored?.type === 'api_key' || usingOAuth
  const environmentWins = identifier === 'prime-inference' && !!environment
  const source = environmentWins
    ? 'environment'
    : hasStored
      ? 'stored'
      : environment
        ? 'environment'
        : typeof customKey === 'string'
          ? customKey.startsWith('!')
            ? 'models_json_command'
            : 'models_json_key'
          : undefined
  const credentials: ProviderInfo['stored'] = hasStored
    ? {
        type: usingOAuth ? 'oauth' : 'api_key',
        ...(typeof stored.key === 'string' ? { hint: maskPrimeSecret(stored.key) } : {}),
        ...(typeof stored.expires === 'number' ? { expiresAt: stored.expires } : {}),
        ...(typeof stored.key === 'string' && stored.key.startsWith('!') ? { command: true } : {})
      }
    : undefined
  const providerModels = models.filter((model) => model.provider === identifier)
  return {
    id: identifier,
    name: providerName(identifier),
    ...(SUBSCRIPTION_PROVIDERS.has(identifier) || NATIVE_ACCOUNT_PROVIDERS.has(identifier)
      ? {
          oauth: {
            name: providerName(identifier),
            subscription: SUBSCRIPTION_PROVIDERS.has(identifier)
          }
        }
      : {}),
    ...(identifier !== 'openai-codex' ? { apiKey: { name: 'API key', interactive: true } } : {}),
    status: {
      configured:
        configured.has(identifier) ||
        (CREDENTIAL_ONLY_PROVIDERS.has(identifier) && stored?.type === 'api_key'),
      source,
      label: environmentWins || !hasStored ? environment : usingOAuth ? 'OAuth' : 'API key',
      usingOAuth: usingOAuth && !environmentWins
    },
    stored: credentials,
    envVars,
    modelCount: providerModels.length,
    availableCount: providerModels.filter((model) => model.available).length
  }
}

export async function primeModelCatalog(context: PrimeSettingsContext): Promise<ModelCatalog> {
  const [auth, custom, traces] = await Promise.all([
    readPrimeJson(join(getPrimeAgentDir(), 'auth.json')),
    readPrimeJson(join(getPrimeAgentDir(), 'models.json')),
    runPrimeTraces({ cwd: context.cwd ?? process.cwd(), action: 'status' }).catch(() => null)
  ])
  let response: Record<string, unknown> = {}
  let catalogError: string | undefined
  try {
    if (context.nativeCommand) {
      response = await context.nativeCommand('get_model_catalog', {}, context.cwd)
    } else {
      catalogError = 'Open an Engine 2 session to load its complete model catalog.'
    }
  } catch (error) {
    catalogError = (error as Error).message
  }
  const configured = new Set(jsonStrings(response.configuredProviders))
  const customProviders = jsonObject(custom.data.providers) ?? {}
  const models = (Array.isArray(response.models) ? response.models : [])
    .map((model) => modelInfo(model, configured))
    .filter((model): model is ModelInfo => !!model)
  const identifiers = new Set([
    ...Object.keys(PROVIDER_ENVIRONMENT),
    ...Object.keys(customProviders),
    ...Object.keys(auth.data).filter((identifier) => !identifier.startsWith('mcp:')),
    ...models.map((model) => model.provider)
  ])
  const providers = [...identifiers]
    .map((identifier) => providerInfo(identifier, auth.data, customProviders, models, configured))
    .sort((left, right) => left.name.localeCompare(right.name))
  const traceProvider = providers.find((provider) => provider.id === 'prime-agent-traces')
  if (traceProvider) {
    const label = traces?.credentialLabel
    traceProvider.status = {
      configured: !!label,
      source: label
        ? traceProvider.envVars.includes(label)
          ? 'environment'
          : label === 'Prime Inference credential'
            ? 'fallback'
            : 'stored'
        : undefined,
      label:
        label === 'Prime Agent Traces credential'
          ? 'Trace upload credential'
          : (label ?? undefined),
      usingOAuth: false
    }
  }
  return {
    providers,
    models,
    error: auth.error || custom.error || catalogError
  }
}

export async function startPrimeLogin(
  args: StartLoginArgs,
  context: PrimeSettingsContext
): Promise<string> {
  assertSafeKey(args.providerId)
  const emit = (event: AuthFlowEvent): void => context.broadcast?.('settings:auth-event', event)
  const changed = (): void =>
    context.broadcast?.('settings:changed', {
      area: args.providerId.startsWith('mcp:') ? 'mcp' : 'auth'
    })
  if (args.method === 'oauth' || NATIVE_ACCOUNT_PROVIDERS.has(args.providerId)) {
    return startPrimeOAuth(args, emit, changed, { cwd: args.cwd ?? context.cwd ?? undefined })
  }
  const loginId = `prime-key-${randomUUID()}`
  const promptId = randomUUID()
  const timeout = setTimeout(() => cancelPrimeLogin(loginId), API_KEY_LOGIN_TIMEOUT_MS)
  timeout.unref()
  const server = args.providerId.startsWith('mcp:') ? args.providerId.slice('mcp:'.length) : null
  const nativeCommand = context.nativeCommand
  if (server !== null && (!server || !nativeCommand)) {
    clearTimeout(timeout)
    throw new Error('Engine 2 must be available to verify this MCP token.')
  }
  const store = async (key: string): Promise<void> => {
    if (server !== null) {
      const result = await nativeCommand!(
        'set_mcp_static_token',
        { server, token: key },
        args.cwd ?? context.cwd
      )
      // Engine 2 keeps an unverified token; the prompt stays open so another one can be entered.
      if (result.verified !== true) {
        const reason = typeof result.error === 'string' && result.error ? result.error : null
        throw new Error(
          reason ? `${server} did not accept the token: ${reason}` : `${server} could not verify the token.`
        )
      }
      return
    }
    await updatePrimeJson(join(getPrimeAgentDir(), 'auth.json'), (current) => ({
      ...current,
      [args.providerId]: { type: 'api_key', key }
    }))
  }
  apiKeyLogins.set(loginId, { promptId, saving: false, emit, changed, timeout, store })
  // The renderer registers its flow after the invoke response supplies this id.
  setTimeout(() => {
    if (!apiKeyLogins.has(loginId)) return
    emit({
      loginId,
      kind: 'prompt',
      promptId,
      prompt: {
        type: 'secret',
        message: server
          ? `Enter the token for ${server}.`
          : `Enter your ${providerName(args.providerId)} API key.`
      }
    })
  }, 0)
  return loginId
}

export async function respondPrimeLogin(
  loginId: string,
  promptId: string,
  value: string | null
): Promise<void> {
  if (respondPrimeOAuth(loginId, promptId, value)) return
  const login = apiKeyLogins.get(loginId)
  if (!login || login.promptId !== promptId) throw new Error('This sign-in prompt has expired.')
  if (login.saving) throw new Error('This credential is already being saved.')
  if (value === null) return cancelPrimeLogin(loginId)
  if (!value.trim()) throw new Error('Enter a non-empty API key.')
  login.saving = true
  try {
    await login.store(value.trim())
  } catch (error) {
    login.saving = false
    login.timeout.refresh()
    throw error
  }
  clearTimeout(login.timeout)
  apiKeyLogins.delete(loginId)
  login.changed()
  login.emit({ loginId, kind: 'done', ok: true })
}

export function cancelPrimeLogin(loginId: string): void {
  if (cancelPrimeOAuth(loginId)) return
  const login = apiKeyLogins.get(loginId)
  if (!login || login.saving) return
  clearTimeout(login.timeout)
  apiKeyLogins.delete(loginId)
  login.emit({ loginId, kind: 'done', ok: false, cancelled: true })
}

export function disposePrimeAuth(): void {
  for (const loginId of apiKeyLogins.keys()) cancelPrimeLogin(loginId)
  disposePrimeOAuth()
}

export async function logoutPrimeProvider(providerId: string): Promise<void> {
  assertSafeKey(providerId)
  await updatePrimeJson(join(getPrimeAgentDir(), 'auth.json'), (current) => {
    const next = { ...current }
    delete next[providerId]
    return next
  })
}

export async function checkPrimeAuth(
  providerId: string,
  context: PrimeSettingsContext
): Promise<AuthCheckResult> {
  const catalog = await primeModelCatalog(context)
  const provider = catalog.providers.find((candidate) => candidate.id === providerId)
  if (provider?.status.configured) {
    return { status: 'ready', authType: provider.status.usingOAuth ? 'oauth' : 'api_key' }
  }
  return {
    status: 'not_ready',
    reason: catalog.error || 'The engine has no available models for this provider.'
  }
}

export async function readPrimeModels(): Promise<ModelsJsonState> {
  return safePrimeFileState(await readPrimeJson(join(getPrimeAgentDir(), 'models.json')))
}

export function validatePrimeModels(data: JsonObject): ValidationIssue[] {
  if (data.providers === undefined) return []
  const providers = jsonObject(data.providers)
  if (!providers) {
    return [{ severity: 'error', key: 'providers', message: 'Provide a providers object.' }]
  }
  const issues: ValidationIssue[] = []
  for (const [identifier, raw] of Object.entries(providers)) {
    const provider = jsonObject(raw)
    if (!provider) {
      issues.push({ severity: 'error', key: identifier, message: 'Provider must be an object.' })
      continue
    }
    const models = Array.isArray(provider.models) ? provider.models : []
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      issues.push({
        severity: 'error',
        key: `${identifier}.models`,
        message: 'Models must be an array.'
      })
    }
    if (
      !models.length &&
      provider.baseUrl == null &&
      provider.headers == null &&
      provider.compat == null &&
      !Object.keys(jsonObject(provider.modelOverrides) ?? {}).length
    ) {
      issues.push({
        severity: 'error',
        key: identifier,
        message: 'Set baseUrl, headers, compat, modelOverrides, or models for this provider.'
      })
    }
    for (const key of ['name', 'baseUrl', 'apiKey', 'api']) {
      if (provider[key] != null && typeof provider[key] !== 'string') {
        issues.push({
          severity: 'error',
          key: `${identifier}.${key}`,
          message: `${key} must be text.`
        })
      }
    }
    if (models.length && !(identifier in PROVIDER_ENVIRONMENT)) {
      for (const key of ['baseUrl', 'apiKey']) {
        if (typeof provider[key] !== 'string' || !provider[key]) {
          issues.push({
            severity: 'error',
            key: `${identifier}.${key}`,
            message: `${key} is required.`
          })
        }
      }
    }
    for (const rawModel of models) {
      const model = jsonObject(rawModel)
      if (typeof model?.id !== 'string' || !model.id.trim()) {
        issues.push({ severity: 'error', key: identifier, message: 'Every model needs an id.' })
        continue
      }
      if (
        !(identifier in PROVIDER_ENVIRONMENT) &&
        typeof provider.api !== 'string' &&
        typeof model.api !== 'string'
      ) {
        issues.push({
          severity: 'error',
          key: `${identifier}.${model.id}.api`,
          message: 'Set api at the provider or model level.'
        })
      }
      for (const key of ['contextWindow', 'maxTokens']) {
        const value = model[key]
        if (
          value !== undefined &&
          (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        ) {
          issues.push({
            severity: 'error',
            key: `${identifier}.${model.id}.${key}`,
            message: `${key} must be a positive number.`
          })
        }
      }
    }
  }
  return issues
}

export async function writePrimeModels(data: JsonObject): Promise<ModelsJsonState> {
  const issues = validatePrimeModels(data)
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'))
  await updatePrimeJson(join(getPrimeAgentDir(), 'models.json'), (current) =>
    restorePrimeSecrets(data, current)
  )
  return readPrimeModels()
}
