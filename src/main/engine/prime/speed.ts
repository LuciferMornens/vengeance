import type { SpeedMode, SpeedOption, SpeedState } from '@shared/api/speed'
import {
  isClaudeFastModel,
  speedOption,
  speedRefusal,
  speedState,
  type ModelRef,
  type SpeedOffer
} from '../../../../resources/bridge/speed-mode-core'
import { asRecord, asRecords, stringValue, type PrimeRecord } from './transport'

const SERVICE_TIERS: Record<SpeedMode, string> = {
  standard: 'default',
  fast: 'priority',
  ultrafast: 'ultrafast'
}

type NativeCommand = (type: string, payload?: PrimeRecord) => Promise<PrimeRecord>

export function primeSpeedOffer(model: ModelRef, tiers: PrimeRecord[]): SpeedOffer {
  const options = tiers.flatMap<SpeedOption>((entry) => {
    const mode =
      entry.tier === 'priority' ? 'fast' : entry.tier === 'ultrafast' ? 'ultrafast' : null
    if (!mode) return []
    // OpenRouter publishes no fixed multiplier for its priority tier.
    if (model.provider === 'openrouter') return [{ mode }]
    return [speedOption(model.id, mode, stringValue(entry.description))]
  })
  if (options.length === 0 && model.provider === 'anthropic' && isClaudeFastModel(model.id)) {
    return { options, unavailableReason: "Engine 2 doesn't support Claude fast mode" }
  }
  return { options }
}

/** `bridge({ op: 'speed' })` on Engine 2: read the session's speed, or request `mode` first. */
export async function primeSpeed(
  nativeCommand: NativeCommand,
  mode?: SpeedMode
): Promise<SpeedState> {
  const connection = await nativeCommand('get_connection_state', {
    includeServiceTierOptions: true
  })
  const capabilities = asRecord(connection.serviceTierOptions)
  // Residents keep their executable across app updates until explicitly restarted.
  if (!Array.isArray(capabilities.tiers)) {
    return {
      requested: 'standard',
      effective: 'standard',
      options: [],
      unavailableReason: 'Restart this session to use response speed controls'
    }
  }
  if (mode) {
    await nativeCommand('set_service_tier', { serviceTier: SERVICE_TIERS[mode] })
  }
  const session = await nativeCommand('get_session_context')
  const model = asRecord(capabilities.model)
  const offer = primeSpeedOffer(
    {
      provider: stringValue(model.provider) ?? '',
      api: stringValue(model.api) ?? '',
      id: stringValue(model.id) ?? ''
    },
    asRecords(capabilities.tiers)
  )
  const tier = asRecord(session.context).serviceTier
  const requested = tier === 'ultrafast' ? 'ultrafast' : tier === 'priority' ? 'fast' : 'standard'
  return speedState(requested, offer)
}

export class PrimeSpeedControl {
  private notice: SpeedState['notice']
  private correction: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(private readonly command: NativeCommand) {}

  reset(): void {
    this.generation += 1
    this.notice = undefined
  }

  async read(mode?: SpeedMode): Promise<SpeedState> {
    await this.correction
    const state = await primeSpeed(this.command, mode)
    return this.notice ? { ...state, notice: this.notice } : state
  }

  accept(event: PrimeRecord): void {
    const message = asRecord(event.message)
    if (
      event.type !== 'message_end' ||
      message.role !== 'assistant' ||
      message.stopReason !== 'error'
    )
      return
    if (message.provider !== 'openai' && message.provider !== 'openai-codex') return
    const refusal = speedRefusal(
      message.provider === 'openai-codex' ? 'chatgpt' : 'openai-api-key',
      stringValue(message.errorMessage)
    )
    if (!refusal) return
    const generation = this.generation
    this.correction = this.correction
      .then(async () => {
        const session = await this.command('get_session_context')
        if (generation !== this.generation) return
        const tier = asRecord(session.context).serviceTier
        if (tier !== 'priority' && tier !== 'ultrafast') return
        await this.command('set_service_tier', { serviceTier: 'default' })
        if (generation !== this.generation) return
        this.notice = {
          id: Math.max(Date.now(), (this.notice?.id ?? 0) + 1),
          text: `${tier === 'ultrafast' ? 'Ultrafast' : 'Fast'} mode turned off: ${refusal}`
        }
      })
      .catch(() => {
        // A disconnected resident cannot accept a correction; the next read queries its real state.
      })
  }
}
