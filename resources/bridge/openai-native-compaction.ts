/**
 * OpenAI native compaction for Responses and Codex Responses (ChatGPT or an API key).
 *
 * A Responses `compaction_trigger` requests an encrypted checkpoint without adding a user turn.
 * The Engine also saves its text summary for other models and recovery from unsupported providers.
 *
 * `session_before_compact` requests a checkpoint beside the text summary, using the session's
 * authenticated model transport and response speed. `session_compact` saves a completed item beside
 * the summary, and `before_provider_request` replays it only for the model and route that made it.
 *
 * Any failure (an unsupported provider, an incomplete response or an aborted compaction) leaves
 * the Engine's summary in place. Extension-owned compactions keep their own result.
 *
 * `VENGEANCE_NATIVE_COMPACTION=off` turns this off (Settings → Agent behavior).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent
} from '@earendil-works/pi-coding-agent'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import type { SpeedModeControl } from './speed-mode'
import {
  isCompactionItem,
  nativeItemForBranch,
  NATIVE_COMPACTION_ENTRY,
  NATIVE_COMPACTION_FORMAT,
  supportsNativeCompaction,
  withNativeItem,
  type CompactionItem,
  type NativeCompactionData,
  type Payload
} from './openai-native-compaction-core'

interface PendingJob {
  firstKeptEntryId: string
  model: NonNullable<ExtensionContext['model']>
  abort: AbortController
  item: Promise<CompactionItem | undefined>
}

async function requestNativeItem(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext['model']>,
  signal: AbortSignal,
  speed: SpeedModeControl,
  tools: ReturnType<ExtensionAPI['getAllTools']>
): Promise<CompactionItem | undefined> {
  const { preparation } = event
  const now = Date.now()
  // Summarized history includes the earlier checkpoint and split-turn prefix, not kept messages.
  const window = [
    ...(preparation.previousSummary !== undefined
      ? [
          {
            role: 'compactionSummary' as const,
            summary: preparation.previousSummary,
            tokensBefore: 0,
            timestamp: now
          }
        ]
      : []),
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages
  ]
  const previousItem = nativeItemForBranch(event.branchEntries, model)
  let item: CompactionItem | undefined
  let itemCount = 0
  let completed = false
  const stream = ctx.modelRegistry.streamSimple(
    model,
    { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(window), tools },
    {
      signal,
      sessionId: ctx.sessionManager.getSessionId(),
      // before_provider_request does not run for this request: the session's speed is applied here.
      onPayload: (payload: unknown) => {
        const withItem =
          (previousItem && withNativeItem(payload, previousItem)) || (payload as Payload)
        const body = speed.withSessionSpeed(ctx, withItem) ?? withItem
        if (!Array.isArray(body.input)) throw new Error('Responses input is missing')
        // A compaction operation has no answer budget or sampling controls.
        const request = { ...body }
        delete request.max_output_tokens
        delete request.temperature
        delete request.top_p
        // Provider defaults avoid streamSimple's potentially unsupported `none` effort.
        delete request.reasoning
        return {
          ...request,
          input: [...body.input, { type: 'compaction_trigger' }]
        }
      },
      onProviderStreamEvent: (data: unknown) => {
        const streamEvent = data as {
          type?: unknown
          item?: { type?: unknown }
          response?: { status?: unknown }
        } | null
        if (streamEvent?.type === 'response.completed') {
          completed = streamEvent.response?.status === 'completed'
        }
        if (
          streamEvent?.type === 'response.output_item.done' &&
          streamEvent.item?.type === 'compaction'
        ) {
          itemCount++
          if (!isCompactionItem(streamEvent.item)) return
          const { id, encrypted_content } = streamEvent.item
          item = { type: 'compaction', ...(id ? { id } : {}), encrypted_content }
        }
      }
    }
  )
  const answer = await stream.result()
  if (signal.aborted || answer.stopReason !== 'stop' || !completed || itemCount !== 1)
    return undefined
  return item
}

export function registerOpenAINativeCompaction(pi: ExtensionAPI, speed: SpeedModeControl): void {
  if (process.env.VENGEANCE_NATIVE_COMPACTION === 'off') return
  let pending: PendingJob | undefined

  const drop = (): void => {
    pending?.abort.abort()
    pending = undefined
  }

  pi.on('session_before_compact', (event, ctx) => {
    drop()
    const model = ctx.model
    if (!model || !supportsNativeCompaction(model)) return undefined
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, event.signal])
    const activeTools = new Set(pi.getActiveTools())
    const tools = pi.getAllTools().filter((tool) => activeTools.has(tool.name))
    const item = requestNativeItem(event, ctx, model, signal, speed, tools).catch(() => undefined)
    pending = { firstKeptEntryId: event.preparation.firstKeptEntryId, model, abort, item }
    // No result: the Engine's own summary runs as well, in parallel with the native request.
    return undefined
  })

  pi.on('session_compact', async (event) => {
    const job = pending
    if (!job) return
    if (event.fromExtension || event.compactionEntry.firstKeptEntryId !== job.firstKeptEntryId) {
      drop()
      return
    }
    const item = await job.item
    if (pending !== job) return
    pending = undefined
    if (!item || job.abort.signal.aborted) return
    const data: NativeCompactionData = {
      format: NATIVE_COMPACTION_FORMAT,
      compactionId: event.compactionEntry.id,
      model: job.model.id,
      provider: job.model.provider,
      api: job.model.api,
      baseUrl: job.model.baseUrl,
      item
    }
    pi.appendEntry(NATIVE_COMPACTION_ENTRY, data)
  })

  pi.on('session_compact_failed', () => drop())
  pi.on('session_shutdown', () => drop())
  pi.on('session_before_switch', () => drop())
  pi.on('session_before_fork', () => drop())
  pi.on('session_before_tree', () => drop())

  pi.on('before_provider_request', (event, ctx) => {
    const model = ctx.model
    if (!model || !supportsNativeCompaction(model)) return undefined
    const item = nativeItemForBranch(ctx.sessionManager.getBranch(), model)
    return item ? withNativeItem(event.payload, item) : undefined
  })
}
