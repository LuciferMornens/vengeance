/**
 * Pure rules of response speed (`speed-mode.ts`): which faster modes a model offers on its access
 * path, how a mode goes on the wire, what the provider reported back, and what a response costs.
 * No imports, so the offline checks and the desktop app's engine adapters and mocks share these
 * rules without an Engine.
 *
 * Keep the types and constants in sync with `src/shared/api/speed.ts`.
 */

export const SPEED_ENTRY = 'vengeance-speed'
export const SPEED_STATUS_KEY = '__vengeance:speed'
export const SPEED_DEFAULT_ENV = 'VENGEANCE_SPEED_DEFAULT'

export type SpeedMode = 'standard' | 'fast' | 'ultrafast'
export type FasterSpeedMode = Exclude<SpeedMode, 'standard'>

export interface SpeedOption {
  mode: FasterSpeedMode
  description?: string
  costMultiplier?: number
}

/** The faster modes a model offers on one access path. */
export interface SpeedOffer {
  options: SpeedOption[]
  unavailableReason?: string
}

export interface ResponseSpeed {
  mode: SpeedMode
  confirmed: boolean
}

export interface SpeedNotice {
  id: number
  text: string
}

export interface SpeedState {
  requested: SpeedMode
  effective: SpeedMode
  options: SpeedOption[]
  unavailableReason?: string
  lastResponse?: ResponseSpeed
  notice?: SpeedNotice
}

/**
 * How a session reaches a model that has faster modes. `chatgpt` is Sign in with ChatGPT: the
 * `openai` provider with a ChatGPT token, or the `openai-codex` provider.
 */
export type SpeedRoute =
  'openai-api-key' | 'chatgpt' | 'anthropic-api-key' | 'anthropic-subscription'

export interface ModelRef {
  provider: string
  api: string
  id: string
}

export type Payload = Record<string, unknown>

/** The fields of a pi `SessionEntry` read here. */
export interface BranchEntry {
  type: string
  customType?: string
  data?: unknown
}

/**
 * The OpenAI API models with Fast mode and its price relative to standard: the Fast table of the
 * pricing page over its Standard table (developers.openai.com/api/docs/pricing, October 2026). Each
 * model has one ratio for input, cached input, cache writes and output; the ratios that are not
 * round are written as Fast over Standard input $/MTok.
 */
const OPENAI_FAST_COST_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ['gpt-6-astra', 2],
  ['gpt-6.1-sol', 2],
  ['gpt-6-sol', 2],
  ['gpt-6-luna', 2],
  ['gpt-5.6-sol', 2],
  ['gpt-5.6-terra', 2],
  ['gpt-5.6-luna', 2],
  ['gpt-5.5', 2.5],
  ['gpt-5.4', 2],
  ['gpt-5.4-mini', 2],
  ['gpt-5.3-codex', 2],
  ['gpt-5.2', 2],
  ['gpt-5.1', 2],
  ['gpt-5', 2],
  ['gpt-5-mini', 1.8],
  ['gpt-4.1', 1.75],
  ['gpt-4.1-mini', 1.75],
  ['gpt-4.1-nano', 2],
  ['gpt-4o', 1.7],
  // gpt-4o's later snapshots have its standard rates; the first one has rows of its own.
  ['gpt-4o-2024-08-06', 1.7],
  ['gpt-4o-2024-11-20', 1.7],
  ['gpt-4o-2024-05-13', 1.75],
  ['gpt-4o-mini', 0.25 / 0.15],
  ['o3', 1.75],
  ['o4-mini', 2 / 1.1]
])
/** The OpenAI API models with Ultrafast mode and its price relative to standard (pricing page). */
const OPENAI_ULTRAFAST_COST_MULTIPLIERS: ReadonlyMap<string, number> = new Map([
  ['gpt-6-astra', 6],
  ['gpt-6.1-sol', 6]
])

/** Sign in with ChatGPT's Fast models until the account's catalog arrives (or when it can't). */
const CHATGPT_FALLBACK_FAST_MODELS = new Set([
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5'
])

/** Claude fast mode (research preview), first-party Anthropic API only. */
const CLAUDE_FAST_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'])

const CLAUDE_SUBSCRIPTION_REASON = 'Claude fast mode needs an Anthropic API key'

/** Claude fast mode costs twice the standard rates on each of its models (Anthropic pricing). */
const CLAUDE_FAST_COST_MULTIPLIER = 2

const OPENAI_SERVICE_TIER: Record<FasterSpeedMode, string> = {
  fast: 'priority',
  ultrafast: 'ultrafast'
}
const ANTHROPIC_FAST_MODE_BETA = 'fast-mode-2026-02-01'

/** Responses stream events that carry the response object with its `service_tier` echo. */
const OPENAI_RESPONSE_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.incomplete',
  'response.done'
])

/** The Codex release whose catalog format the ChatGPT model catalog answers with. */
const CODEX_CLIENT_VERSION = '0.162.0'
const CODEX_ORIGINATOR = 'codex_cli_rs'
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

export function isSpeedMode(value: unknown): value is SpeedMode {
  return value === 'standard' || value === 'fast' || value === 'ultrafast'
}

export function speedRoute(model: ModelRef, usingOAuth: boolean): SpeedRoute | undefined {
  if (model.provider === 'openai' && model.api === 'openai-responses') {
    return usingOAuth ? 'chatgpt' : 'openai-api-key'
  }
  if (model.provider === 'openai-codex' && model.api === 'openai-codex-responses') return 'chatgpt'
  if (model.provider === 'anthropic' && model.api === 'anthropic-messages') {
    return usingOAuth ? 'anthropic-subscription' : 'anthropic-api-key'
  }
  return undefined
}

export function isOpenAIApiFastModel(modelId: string): boolean {
  return OPENAI_FAST_COST_MULTIPLIERS.has(modelId)
}

export function isClaudeFastModel(modelId: string): boolean {
  return CLAUDE_FAST_MODELS.has(modelId)
}

/**
 * Price of `mode` relative to standard speed (API pricing; Sign in with ChatGPT shows its API
 * equivalent). Undefined when no price is published for the model, e.g. a model the ChatGPT
 * catalog offers Fast for that the pricing page doesn't list.
 */
export function costMultiplier(modelId: string, mode: SpeedMode): number | undefined {
  if (mode === 'standard') return 1
  if (mode === 'ultrafast') return OPENAI_ULTRAFAST_COST_MULTIPLIERS.get(modelId)
  return isClaudeFastModel(modelId)
    ? CLAUDE_FAST_COST_MULTIPLIER
    : OPENAI_FAST_COST_MULTIPLIERS.get(modelId)
}

export function speedOption(
  modelId: string,
  mode: FasterSpeedMode,
  description?: string
): SpeedOption {
  const multiplier = costMultiplier(modelId, mode)
  return {
    mode,
    ...(description ? { description } : {}),
    ...(multiplier === undefined ? {} : { costMultiplier: multiplier })
  }
}

/** Faster modes per model slug, from an account's ChatGPT model catalog. */
export type ChatGptCatalog = ReadonlyMap<string, SpeedOption[]>

function record(value: unknown): Payload | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : undefined
}

/**
 * The catalog response (`{ models: [{ slug, service_tiers, additional_speed_tiers }] }`);
 * undefined when malformed.
 */
export function parseChatGptCatalog(body: unknown): ChatGptCatalog | undefined {
  const models = record(body)?.models
  if (!Array.isArray(models)) return undefined
  const catalog = new Map<string, SpeedOption[]>()
  for (const entry of models) {
    const model = record(entry)
    if (typeof model?.slug !== 'string') continue
    const tiers = Array.isArray(model.service_tiers) ? model.service_tiers.map(record) : []
    const tier = (id: string) => tiers.find((candidate) => candidate?.id === id)
    const description = (id: string) => {
      const text = tier(id)?.description
      return typeof text === 'string' ? text : undefined
    }
    const legacyFast =
      Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.includes('fast')
    const options: SpeedOption[] = []
    if (tier('priority') || legacyFast) {
      options.push(speedOption(model.slug, 'fast', description('priority')))
    }
    if (tier('ultrafast')) {
      options.push(speedOption(model.slug, 'ultrafast', description('ultrafast')))
    }
    catalog.set(model.slug, options)
  }
  return catalog
}

/** What `modelId` offers on `route`. ChatGPT sign-in uses the account's catalog once known. */
export function speedOffer(
  route: SpeedRoute | undefined,
  modelId: string,
  catalog?: ChatGptCatalog
): SpeedOffer {
  switch (route) {
    case 'openai-api-key': {
      const options: SpeedOption[] = []
      if (isOpenAIApiFastModel(modelId)) options.push(speedOption(modelId, 'fast'))
      if (OPENAI_ULTRAFAST_COST_MULTIPLIERS.has(modelId)) {
        options.push(speedOption(modelId, 'ultrafast'))
      }
      return { options }
    }
    case 'chatgpt':
      if (catalog) return { options: catalog.get(modelId) ?? [] }
      return {
        options: CHATGPT_FALLBACK_FAST_MODELS.has(modelId) ? [speedOption(modelId, 'fast')] : []
      }
    case 'anthropic-api-key':
      return { options: isClaudeFastModel(modelId) ? [speedOption(modelId, 'fast')] : [] }
    case 'anthropic-subscription':
      return isClaudeFastModel(modelId)
        ? { options: [], unavailableReason: CLAUDE_SUBSCRIPTION_REASON }
        : { options: [] }
    case undefined:
      return { options: [] }
  }
}

/** `requested` when offered, else Fast for a requested Ultrafast when offered, else standard. */
export function effectiveMode(requested: SpeedMode, options: readonly SpeedOption[]): SpeedMode {
  if (options.some((option) => option.mode === requested)) return requested
  if (requested === 'ultrafast' && options.some((option) => option.mode === 'fast')) return 'fast'
  return 'standard'
}

export function speedState(
  requested: SpeedMode,
  offer: SpeedOffer,
  lastResponse?: ResponseSpeed,
  notice?: SpeedNotice
): SpeedState {
  return {
    requested,
    effective: effectiveMode(requested, offer.options),
    options: offer.options,
    ...(offer.unavailableReason ? { unavailableReason: offer.unavailableReason } : {}),
    ...(lastResponse ? { lastResponse } : {}),
    ...(notice ? { notice } : {})
  }
}

/** The mode saved last on the branch; undefined when the session never chose one. */
export function savedMode(branch: readonly BranchEntry[]): SpeedMode | undefined {
  const entry = branch.findLast(
    (candidate) =>
      candidate.type === 'custom' &&
      candidate.customType === SPEED_ENTRY &&
      isSpeedMode(record(candidate.data)?.mode)
  )
  return record(entry?.data)?.mode as SpeedMode | undefined
}

/** The request is for `modelId` itself (a virtual model sends another model's id). */
export function isRequestFor(payload: unknown, modelId: string): boolean {
  return record(payload)?.model === modelId
}

/**
 * A request the session's model makes, followed until its assistant message ends. It keeps the
 * model it was sent for: the session may switch models while the response streams.
 */
export interface SpeedRequest<Model extends PricedModel = PricedModel> {
  model: Model
  route: SpeedRoute | undefined
  /** The mode the request goes out at. */
  sent: SpeedMode
  /** The payload was changed to carry `sent`; a standard request is left as it is. */
  modified: boolean
  /** The speed the provider reported while streaming the response. */
  reported?: SpeedMode
}

/**
 * A request of the session's `model` at its `requested` mode: the payload to send (undefined
 * leaves it as it is) and the request to follow. Undefined for a request another model makes.
 */
export function startSpeedRequest<Model extends PricedModel>(
  payload: unknown,
  model: Model,
  route: SpeedRoute | undefined,
  requested: SpeedMode,
  options: readonly SpeedOption[]
): { payload: Payload | undefined; request: SpeedRequest<Model> } | undefined {
  if (!isRequestFor(payload, model.id)) return undefined
  const sent = effectiveMode(requested, options)
  const next = route ? withSpeed(payload, route, sent) : undefined
  return { payload: next, request: { model, route, sent, modified: next !== undefined } }
}

/**
 * The request payload with `mode` applied; undefined leaves it as it is (standard, or no faster
 * mode on `route`).
 */
export function withSpeed(
  payload: unknown,
  route: SpeedRoute,
  mode: SpeedMode
): Payload | undefined {
  const body = record(payload)
  if (!body || mode === 'standard') return undefined
  if (route === 'openai-api-key' || route === 'chatgpt') {
    return { ...body, service_tier: OPENAI_SERVICE_TIER[mode] }
  }
  if (route === 'anthropic-api-key' && mode === 'fast') {
    const betas = Array.isArray(body.betas) ? body.betas : []
    return {
      ...body,
      speed: 'fast',
      betas: betas.includes(ANTHROPIC_FAST_MODE_BETA) ? betas : [...betas, ANTHROPIC_FAST_MODE_BETA]
    }
  }
  return undefined
}

function serviceTierMode(serviceTier: unknown): SpeedMode | undefined {
  if (serviceTier === 'priority' || serviceTier === 'fast') return 'fast'
  if (serviceTier === 'ultrafast') return 'ultrafast'
  return serviceTier === 'default' ? 'standard' : undefined
}

/**
 * The speed a provider stream event reports for the response, if it reports one: the
 * `service_tier` echo of an OpenAI API key response, or Claude's `usage.speed`. Sign in with
 * ChatGPT always echoes the default tier, so it reports none.
 */
export function reportedMode(route: SpeedRoute, event: unknown): SpeedMode | undefined {
  const data = record(event)
  if (!data) return undefined
  if (route === 'openai-api-key') {
    if (typeof data.type !== 'string' || !OPENAI_RESPONSE_EVENTS.has(data.type)) return undefined
    return serviceTierMode(record(data.response)?.service_tier)
  }
  if (route === 'anthropic-api-key' || route === 'anthropic-subscription') {
    const usage =
      data.type === 'message_start'
        ? record(record(data.message)?.usage)
        : data.type === 'message_delta'
          ? record(data.usage)
          : undefined
    if (usage?.speed === 'fast') return 'fast'
    return usage?.speed === 'standard' ? 'standard' : undefined
  }
  return undefined
}

/**
 * The mode a response is billed at. A whole Claude response is fast only when its usage says so;
 * a cut-off response is billed at what the provider reported, else at what was sent.
 */
function billedMode(request: SpeedRequest, complete: boolean): SpeedMode {
  const claude = request.route === 'anthropic-api-key' || request.route === 'anthropic-subscription'
  if (claude && complete) return request.reported === 'fast' ? 'fast' : 'standard'
  return request.reported ?? request.sent
}

/** pi-ai's `Usage.cost`. */
export interface UsageCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** The fields of pi-ai's `Usage` read here. */
export interface SpeedUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: UsageCost
}

/** The fields of a pi-ai assistant message read here. */
export interface SpeedResponse<Usage extends SpeedUsage> {
  model: string
  /** The model that answered, when the provider reports another id (an Anthropic fallback). */
  responseModel?: string
  stopReason: string
  errorMessage?: string
  usage: Usage
}

/** The fields of a pi-ai model `calculateCost` prices with. */
export interface PricedModel {
  id: string
  provider: string
  cost: unknown
  compat?: unknown
}

/**
 * The model pi-ai priced a response with: a response from one of the model's configured
 * Anthropic fallbacks (`compat.allowedFallbackModels`) at the fallback's rates, else the model.
 */
function pricingModel<Model extends PricedModel>(model: Model, responseModel?: string): Model {
  if (!responseModel || responseModel === model.id) return model
  const fallbacks = record(model.compat)?.allowedFallbackModels
  const fallback = Array.isArray(fallbacks)
    ? fallbacks
        .map(record)
        .find((entry) => entry?.provider === model.provider && entry.model === responseModel)
    : undefined
  // pi-ai's fallback entries carry rates of the model's own cost shape.
  return fallback?.cost
    ? { ...model, id: responseModel, cost: fallback.cost as Model['cost'] }
    : model
}

function hasTokens(usage: SpeedUsage): boolean {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0
}

/** What a finished request changes: the session's speed report, a refusal, the response's cost. */
export interface SpeedSettlement {
  /** The latest response's speed; unset for an errored or aborted response. */
  lastResponse?: ResponseSpeed
  /** The provider refused the faster mode: the session falls back to standard with this notice. */
  refusal?: string
  /** The response's cost at the speed it ran at; unset keeps the cost the Engine computed. */
  cost?: UsageCost
}

/**
 * Settle `request` once its assistant message ends, priced with the model it was sent for.
 * `calculateCost` is pi-ai's, which sets `usage.cost` from the model's standard rates: recomputing
 * from them keeps a multiplier the provider package already applied from being doubled. Without a
 * published price for the mode the cost the Engine computed stays.
 */
export function settleSpeedRequest<Model extends PricedModel, Usage extends SpeedUsage>(
  request: SpeedRequest<Model>,
  response: SpeedResponse<Usage>,
  calculateCost: (model: Model, usage: Usage) => unknown
): SpeedSettlement {
  const settlement: SpeedSettlement = {}
  const complete = response.stopReason !== 'error' && response.stopReason !== 'aborted'
  if (complete) {
    settlement.lastResponse = request.reported
      ? { mode: request.reported, confirmed: true }
      : { mode: request.sent, confirmed: false }
  }
  if (response.stopReason === 'error' && request.sent !== 'standard' && request.route) {
    const providerText = speedRefusal(request.route, response.errorMessage)
    if (providerText) settlement.refusal = refusalText(request.sent, providerText)
  }
  if (request.modified && request.route && (complete || hasTokens(response.usage))) {
    const pricing = pricingModel(request.model, response.responseModel)
    const multiplier = costMultiplier(pricing.id, billedMode(request, complete))
    if (multiplier !== undefined) {
      const usage = { ...response.usage, cost: { ...response.usage.cost } }
      calculateCost(pricing, usage)
      settlement.cost = scaledCost(usage.cost, multiplier)
    }
  }
  return settlement
}

function scaledCost(cost: UsageCost, multiplier: number): UsageCost {
  const input = cost.input * multiplier
  const output = cost.output * multiplier
  const cacheRead = cost.cacheRead * multiplier
  const cacheWrite = cost.cacheWrite * multiplier
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/**
 * The HTTP status and the provider's own words of an Engine error text:
 * `OpenAI API error (400): {"message":"..."}`, `429 {"type":"error","error":{"message":"..."}}`,
 * `400 Unsupported service_tier: fast`, or a bare message without a status (the Codex transport).
 */
function providerError(errorMessage: string): { status?: number; text: string } {
  const match = /^(?:[^(:]*\((\d{3})\):\s*|(\d{3}):?\s+)/.exec(errorMessage)
  const status = match ? Number(match[1] ?? match[2]) : undefined
  const text = errorMessage.slice(match?.[0].length ?? 0).trim()
  if (!text.startsWith('{')) return { status, text }
  try {
    const body = record(JSON.parse(text))
    const message = record(body?.error)?.message ?? body?.message
    return { status, text: typeof message === 'string' ? message : text }
  } catch {
    return { status, text }
  }
}

/** OpenAI refuses a tier with a 400 naming `service_tier` (in the message or as the `param`). */
const OPENAI_TIER_REFUSED = /service_tier/i
/** Claude refuses the `speed` parameter (unsupported model) with a 400. */
const CLAUDE_SPEED_REFUSED = /`speed`|speed parameter|fast mode/i
/** Claude answers 429 without fast-mode access; a plain fast-pool rate limit is retried instead. */
const CLAUDE_NO_FAST_ACCESS = /usage credits|not (?:available|enabled)|access|waitlist/i

/** The provider message when an error refuses the faster mode that was sent, else undefined. */
export function speedRefusal(
  route: SpeedRoute,
  errorMessage: string | undefined
): string | undefined {
  if (!errorMessage) return undefined
  const { status, text } = providerError(errorMessage)
  const refused =
    route === 'openai-api-key' || route === 'chatgpt'
      ? (status === undefined || status === 400) && OPENAI_TIER_REFUSED.test(errorMessage)
      : status === 400
        ? CLAUDE_SPEED_REFUSED.test(text)
        : status === 429 && CLAUDE_NO_FAST_ACCESS.test(text)
  return refused ? text : undefined
}

function refusalText(mode: FasterSpeedMode, providerText: string): string {
  return `${mode === 'fast' ? 'Fast' : 'Ultrafast'} mode turned off: ${providerText}`
}

/** The ChatGPT account id claim of a ChatGPT access token (a JWT). */
export function chatGptAccountId(token: string): string | undefined {
  const claims = token.split('.')[1]
  if (!claims) return undefined
  try {
    const json = atob(claims.replace(/-/g, '+').replace(/_/g, '/'))
    const accountId = record(record(JSON.parse(json))?.[OPENAI_AUTH_CLAIM])?.chatgpt_account_id
    return typeof accountId === 'string' ? accountId : undefined
  } catch {
    return undefined
  }
}

/** The account's model catalog: Codex's catalog on `openai-codex`, the models list on `openai`. */
export function chatGptCatalogRequest(
  provider: string,
  baseUrl: string,
  token: string
): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, '')
  const accountId = chatGptAccountId(token)
  return {
    url:
      provider === 'openai-codex'
        ? `${base}/codex/models?client_version=${CODEX_CLIENT_VERSION}`
        : `${base}/models`,
    headers: {
      Authorization: `Bearer ${token}`,
      originator: CODEX_ORIGINATOR,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {})
    }
  }
}
