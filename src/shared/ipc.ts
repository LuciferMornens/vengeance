/**
 * The typed IPC contract — single source of truth for main ↔ renderer channels.
 *
 * Every feature declares its channels in `shared/api/<feature>.ts`; this file only assembles them.
 * Invoke entries are tuples `[...args, result]`; event entries are the payload type.
 * Duplicate channel names across features fail to compile (interface extension conflict).
 */
import type { AppEventMap, AppInvokeMap } from './api/app'
import type { ChatEventMap, ChatInvokeMap } from './api/chat'
import type { ComposerEventMap, ComposerInvokeMap } from './api/composer'
import type { EngineEventMap, EngineInvokeMap } from './api/engine'
import type { GalleryInvokeMap } from './api/gallery'
import type { LaunchEventMap, LaunchInvokeMap } from './api/launch'
import type { SessionsEventMap, SessionsInvokeMap } from './api/sessions'
import type {
  EngineSettingsRequest,
  EngineSettingsResult,
  SettingsChannel,
  SettingsEventMap,
  SettingsInvokeMap
} from './api/settings'
import type { SystemEventMap, SystemInvokeMap } from './api/system'
import type { PrimeTracesEventMap, PrimeTracesInvokeMap } from './api/traces'
import type { UpdatesEventMap, UpdatesInvokeMap } from './api/updates'
import type { PlatformInfo } from './api/app'

export interface InvokeMap
  extends
    EngineInvokeMap,
    SystemInvokeMap,
    AppInvokeMap,
    ChatInvokeMap,
    ComposerInvokeMap,
    SettingsInvokeMap,
    SessionsInvokeMap,
    LaunchInvokeMap,
    PrimeTracesInvokeMap,
    UpdatesInvokeMap,
    GalleryInvokeMap {}

export interface EventMap
  extends
    EngineEventMap,
    SystemEventMap,
    AppEventMap,
    ChatEventMap,
    ComposerEventMap,
    SettingsEventMap,
    SessionsEventMap,
    LaunchEventMap,
    PrimeTracesEventMap,
    UpdatesEventMap {}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export type InvokeArgs<C extends InvokeChannel> = InvokeMap[C] extends [...infer A, unknown]
  ? A
  : never
export type InvokeResult<C extends InvokeChannel> = InvokeMap[C] extends [...unknown[], infer R]
  ? R
  : never

/** Wire envelope used between main handlers and the preload (preload unwraps it and throws on error). */
export type InvokeEnvelope<T> =
  { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

/** The API exposed by the preload as `window.vengeance`. */
export interface VengeanceBridge {
  invoke<C extends SettingsChannel>(
    channel: 'engine:settings',
    request: EngineSettingsRequest<C>
  ): Promise<EngineSettingsResult<C>>
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
  platform: PlatformInfo
  /** Absolute path of a dropped file or folder (Electron's webUtils.getPathForFile). */
  pathForFile(file: File): string
}

/** Channel names must look like `feature:action` (enforced by preload + main). */
export const CHANNEL_PATTERN = /^[a-z][a-z0-9]*:[a-z0-9][a-z0-9:-]*$/
