/**
 * Response speed (Fast / Ultrafast) for the Engine's OpenAI Responses and Anthropic Messages
 * models.
 *
 * A session requests a speed (`SPEED_ENTRY` custom entries on its branch, latest wins; sessions
 * without one use `VENGEANCE_SPEED_DEFAULT`). The requests of the session's own model that pass
 * through `before_provider_request` (turns and their retries, cache warming) carry the effective
 * mode, and so does the native compaction checkpoint (`withSessionSpeed`):
 *   - OpenAI (`openai` with an API key or Sign in with ChatGPT, `openai-codex`):
 *     `service_tier: "priority"` for Fast, `"ultrafast"` for Ultrafast. An API key offers the
 *     models of OpenAI's pricing page; Sign in with ChatGPT those of the account's model catalog,
 *     fetched in the background unless the Engine is offline (a built-in list until it arrives).
 *   - Anthropic (`anthropic` with an API key): `speed: "fast"` and the `fast-mode-2026-02-01`
 *     beta.
 * The Engine's own compaction summary runs at standard speed: it bypasses
 * `before_provider_request`. A request for another model (a virtual model routes to its own id) is
 * left alone, and a standard session never removes a `service_tier` another extension set.
 *
 * The provider's report (an OpenAI API key's `service_tier` echo, Claude's `usage.speed`) confirms
 * the speed of each response, and the response's cost (a cut-off one's too) is recomputed at that
 * speed's price. Cache-warming requests are logged at standard cost: the Engine records their usage
 * without an event an extension could correct it in. When the provider refuses the faster mode, the
 * session falls back to standard (saved, so a retry goes out at standard speed) with a notice.
 *
 * The `SpeedState` is published as JSON on the hidden status `SPEED_STATUS_KEY` whenever it may
 * have changed. The decisions are in `speed-mode-core.ts`; this file wires them to the Engine.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { calculateCost } from '@earendil-works/pi-ai'
import {
  chatGptCatalogRequest,
  isSpeedMode,
  parseChatGptCatalog,
  reportedMode,
  savedMode,
  settleSpeedRequest,
  SPEED_DEFAULT_ENV,
  SPEED_ENTRY,
  SPEED_STATUS_KEY,
  speedOffer,
  speedRoute,
  speedState,
  startSpeedRequest,
  type ChatGptCatalog,
  type Payload,
  type ResponseSpeed,
  type SpeedMode,
  type SpeedNotice,
  type SpeedOffer,
  type SpeedRequest,
  type SpeedRoute,
  type SpeedState
} from './speed-mode-core'

/** An account's catalog is fetched again after this long. */
const CATALOG_TTL_MS = 60 * 60_000
/** After a failed fetch (signed out, unreachable, malformed), the next try waits this long. */
const CATALOG_RETRY_MS = 5 * 60_000
const CATALOG_TIMEOUT_MS = 10_000

type Model = NonNullable<ExtensionContext['model']>

interface CatalogCacheEntry {
  /** The provider and ChatGPT account the catalog belongs to; undefined when signed out. */
  account: string | undefined
  catalog: ChatGptCatalog | undefined
  refreshAt: number
}

export interface SpeedModeControl {
  /** The session's speed, after requesting `mode` when given. */
  request(ctx: ExtensionContext, mode?: SpeedMode): SpeedState
  /** `payload` of a request the session's model makes outside the Engine's turns, at its speed. */
  withSessionSpeed(ctx: ExtensionContext, payload: unknown): Payload | undefined
}

export function registerSpeedMode(pi: ExtensionAPI): SpeedModeControl {
  const configuredDefault = process.env[SPEED_DEFAULT_ENV]
  const defaultMode: SpeedMode = isSpeedMode(configuredDefault) ? configuredDefault : 'standard'
  let requested = defaultMode
  let lastResponse: ResponseSpeed | undefined
  let notice: SpeedNotice | undefined
  let pending: SpeedRequest<Model> | undefined
  /** Latest catalog per ChatGPT provider, and the providers with a refresh in flight. */
  const catalogs = new Map<string, CatalogCacheEntry>()
  const refreshing = new Set<string>()

  const routeOf = (ctx: ExtensionContext, model: Model): SpeedRoute | undefined =>
    speedRoute(model, ctx.modelRegistry.isUsingOAuth(model))

  const publish = (ctx: ExtensionContext, model: Model | undefined = ctx.model): SpeedState => {
    const state = speedState(requested, offerFor(ctx, model), lastResponse, notice)
    ctx.ui.setStatus(SPEED_STATUS_KEY, JSON.stringify(state))
    return state
  }

  /** Fetch the account's catalog; publish again when it changes what the session's model offers. */
  const refreshCatalog = async (ctx: ExtensionContext, model: Model): Promise<void> => {
    const remember = (account: string | undefined, catalog: ChatGptCatalog | undefined) =>
      catalogs.set(model.provider, {
        account,
        catalog,
        refreshAt: Date.now() + (catalog ? CATALOG_TTL_MS : CATALOG_RETRY_MS)
      })
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
    if (!auth.ok || !auth.apiKey) {
      remember(undefined, undefined)
      return
    }
    const { url, headers } = chatGptCatalogRequest(model.provider, model.baseUrl, auth.apiKey)
    const account = `${model.provider}:${headers['chatgpt-account-id'] ?? ''}`
    const cached = catalogs.get(model.provider)
    if (cached?.account === account && Date.now() < cached.refreshAt) return
    const before = JSON.stringify(offerFor(ctx, model))
    let catalog: ChatGptCatalog | undefined
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
      })
      catalog = response.ok ? parseChatGptCatalog(await response.json()) : undefined
    } catch {
      // Unreachable or malformed catalog: the built-in list stays in use until the next try.
    }
    remember(account, catalog)
    if (JSON.stringify(offerFor(ctx, model)) !== before) publish(ctx)
  }

  const startRefresh = (ctx: ExtensionContext, model: Model): void => {
    // Offline (`--offline`): no background network activity; the built-in list stays in use.
    if (process.env.PI_OFFLINE || refreshing.has(model.provider)) return
    refreshing.add(model.provider)
    refreshCatalog(ctx, model)
      // A session replaced meanwhile leaves this ctx stale; its successor fetches again.
      .catch(() => undefined)
      .finally(() => refreshing.delete(model.provider))
  }

  const catalogFor = (ctx: ExtensionContext, model: Model): ChatGptCatalog | undefined => {
    const cached = catalogs.get(model.provider)
    if (!cached || Date.now() >= cached.refreshAt) startRefresh(ctx, model)
    return cached?.catalog
  }

  const offerFor = (ctx: ExtensionContext, model: Model | undefined): SpeedOffer => {
    if (!model) return { options: [] }
    const route = routeOf(ctx, model)
    return speedOffer(route, model.id, route === 'chatgpt' ? catalogFor(ctx, model) : undefined)
  }

  /** A request of the session's model at the session's speed; undefined without a model. */
  const startRequest = (ctx: ExtensionContext, payload: unknown) => {
    const model = ctx.model
    if (!model) return undefined
    const route = routeOf(ctx, model)
    return startSpeedRequest(payload, model, route, requested, offerFor(ctx, model).options)
  }

  const choose = (ctx: ExtensionContext, mode: SpeedMode): void => {
    requested = mode
    if (savedMode(ctx.sessionManager.getBranch()) !== mode) pi.appendEntry(SPEED_ENTRY, { mode })
  }

  const sessionChanged = (ctx: ExtensionContext): void => {
    requested = savedMode(ctx.sessionManager.getBranch()) ?? defaultMode
    pending = undefined
    publish(ctx)
    // A fresh catalog of another account (signed in again meanwhile) is replaced.
    if (ctx.model && routeOf(ctx, ctx.model) === 'chatgpt') startRefresh(ctx, ctx.model)
  }

  pi.on('session_start', (_event, ctx) => {
    lastResponse = undefined
    notice = undefined
    sessionChanged(ctx)
  })

  pi.on('session_tree', (_event, ctx) => sessionChanged(ctx))

  pi.on('model_select', (event, ctx) => {
    publish(ctx, event.model)
  })

  pi.on('before_provider_request', (event, ctx) => {
    const started = startRequest(ctx, event.payload)
    if (!started) return undefined
    pending = started.request
    return started.payload
  })

  pi.on('provider_stream_event', (event) => {
    if (!pending?.route || event.model !== pending.model.id) return
    pending.reported = reportedMode(pending.route, event.data) ?? pending.reported
  })

  pi.on('message_end', (event, ctx) => {
    const message = event.message
    const request = pending
    if (message.role !== 'assistant' || !request) return undefined
    const { provider, id } = request.model
    if (message.provider !== provider || message.model !== id) return undefined
    pending = undefined
    // Priced with the request's model: the session may have switched models while it streamed.
    const settled = settleSpeedRequest(request, message, calculateCost)
    if (settled.lastResponse) lastResponse = settled.lastResponse
    if (settled.refusal) {
      choose(ctx, 'standard')
      notice = { id: Math.max(Date.now(), (notice?.id ?? 0) + 1), text: settled.refusal }
    }
    if (settled.lastResponse || settled.refusal) publish(ctx)
    return settled.cost
      ? { message: { ...message, usage: { ...message.usage, cost: settled.cost } } }
      : undefined
  })

  return {
    request(ctx, mode) {
      if (mode) {
        choose(ctx, mode)
        notice = undefined
        return publish(ctx)
      }
      return speedState(requested, offerFor(ctx, ctx.model), lastResponse, notice)
    },
    withSessionSpeed: (ctx, payload) => startRequest(ctx, payload)?.payload
  }
}
