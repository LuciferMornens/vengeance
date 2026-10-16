// ─── Response speed (Fast / Ultrafast mode) ─────────────────────────────────────────────────────
//
// A session requests a speed; the engine sends it with every model request when the current model
// supports it on the session's access path:
//   - OpenAI Responses: `service_tier: "priority"` (Fast) or `"ultrafast"` (Ultrafast).
//   - Anthropic Messages: `speed: "fast"` with the `fast-mode-2026-02-01` beta (Fast).
// pi gets this from the bridge (`resources/bridge/speed-mode.ts`); Engine 2 from its native service tier.

export const SPEED_MODES = ['standard', 'fast', 'ultrafast'] as const
export type SpeedMode = (typeof SPEED_MODES)[number]
export type FasterSpeedMode = Exclude<SpeedMode, 'standard'>

export function isSpeedMode(value: unknown): value is SpeedMode {
  return typeof value === 'string' && (SPEED_MODES as readonly string[]).includes(value)
}

/** A faster mode the session's current model offers on its access path. */
export interface SpeedOption {
  mode: FasterSpeedMode
  /** Provider wording when it has one, e.g. OpenAI's catalog "2x speed, increased usage". */
  description?: string
  /** Price relative to standard speed (API-equivalent pricing); unset when no price is published. */
  costMultiplier?: number
}

export interface SpeedState {
  /** The session's choice; kept across model switches. */
  requested: SpeedMode
  /** What the next request uses: `requested` when the current model supports it, else the best supported mode below it. */
  effective: SpeedMode
  /** Faster modes for the current model, slowest first. Empty: the model has no faster mode here. */
  options: SpeedOption[]
  /**
   * The current model has a faster mode, but not through this engine or sign-in (e.g. Claude fast mode
   * needs an Anthropic API key). The control is shown disabled with this text.
   */
  unavailableReason?: string
  /**
   * The speed of the latest model response in this session. `confirmed` is true when the provider
   * reported it; ChatGPT sign-in always reports the default tier, so there `mode` is what was requested.
   */
  lastResponse?: { mode: SpeedMode; confirmed: boolean }
  /**
   * The engine turned the faster mode off because the provider refused it (no fast-mode access,
   * usage credits required, unsupported tier). `id` increases with each notice so it is shown once.
   */
  notice?: { id: number; text: string }
}

/** Hidden status key the pi bridge publishes `SpeedState` JSON on whenever it changes. */
export const SPEED_STATUS_KEY = '__vengeance:speed'

/** Custom session entry with the requested mode (pi). Keep in sync with `resources/bridge/speed-mode-core.ts`. */
export const SPEED_ENTRY = 'vengeance-speed'

/** Engine environment variable: the mode for pi sessions that have no saved choice yet. */
export const SPEED_DEFAULT_ENV = 'VENGEANCE_SPEED_DEFAULT'
