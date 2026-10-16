import {
  SPEED_DEFAULT_ENV,
  SPEED_ENTRY,
  isSpeedMode,
  type SpeedMode,
  type SpeedState
} from '@shared/api/speed'
import type { Model, SessionEntry } from '@shared/engine-types'
import {
  savedMode,
  speedOffer,
  speedRoute,
  speedState,
  type ResponseSpeed,
  type SpeedNotice
} from '../../../resources/bridge/speed-mode-core'

/** The mock model whose provider refuses its faster mode, like an account without Priority processing. */
const REFUSING_MODEL_ID = 'gpt-6-sol'
const REFUSAL_TEXT = 'Fast mode turned off: Unsupported service_tier: priority'

/** The custom entry that saves a requested mode on the branch. */
interface SpeedEntry {
  customType: string
  data: { mode: SpeedMode }
}

/**
 * The bridge's response speed in mock mode, with the Engine's model rules. Every provider is
 * reached with an API key, so OpenAI API models offer Fast (and Ultrafast on gpt-6.1-sol and
 * gpt-6-astra) and Claude Opus fast models offer Fast. Like the bridge, the requested mode is a
 * custom entry on the branch, and a refused faster mode (gpt-6-sol) falls back to standard with a
 * notice; the mock's turn still answers.
 */
export class MockSpeed {
  private readonly defaultMode: SpeedMode
  private lastResponse: ResponseSpeed | undefined
  private notice: SpeedNotice | undefined
  /** Notice ids increase for the engine process, like the bridge's. */
  private noticeCount = 0

  constructor(env: Record<string, string | undefined>) {
    const configured = env[SPEED_DEFAULT_ENV]
    this.defaultMode = isSpeedMode(configured) ? configured : 'standard'
  }

  state(model: Model, branch: readonly SessionEntry[]): SpeedState {
    const requested = savedMode(branch) ?? this.defaultMode
    const offer = speedOffer(speedRoute(model, false), model.id)
    return speedState(requested, offer, this.lastResponse, this.notice)
  }

  /** The custom entry saving `mode` on the branch; undefined when the branch already saved it. */
  entryFor(mode: SpeedMode, branch: readonly SessionEntry[]): SpeedEntry | undefined {
    return savedMode(branch) === mode ? undefined : { customType: SPEED_ENTRY, data: { mode } }
  }

  /** A choice from the app clears the notice, like the bridge. */
  chose(): void {
    this.notice = undefined
  }

  /**
   * A response arrived at the effective speed; mock providers always report it. Returns the entry
   * saving standard when the model's provider refused the faster mode.
   */
  responded(model: Model, branch: readonly SessionEntry[]): SpeedEntry | undefined {
    const effective = this.state(model, branch).effective
    if (model.id === REFUSING_MODEL_ID && effective !== 'standard') {
      this.notice = { id: ++this.noticeCount, text: REFUSAL_TEXT }
      return this.entryFor('standard', branch)
    }
    this.lastResponse = { mode: effective, confirmed: true }
    return undefined
  }

  /** A new session has no response or notice yet. */
  sessionChanged(): void {
    this.lastResponse = undefined
    this.notice = undefined
  }
}
