import type {
  BridgeRequest,
  BridgeResult,
  CreateAgentArgs,
  EngineRuntimeInfo,
  EngineStatus
} from '@shared/api/engine'
import type {
  EngineEvent,
  RpcCommand,
  RpcCommandType,
  RpcExtensionUIResponse,
  RpcResponse
} from '@shared/engine-types'

export interface EngineExit {
  code: number | null
  signal: string | null
  /** Vengeance requested the shutdown. */
  expected: boolean
}

export interface EngineHandleEvents {
  /** Session events and extension UI requests (anything that is not a correlated response). */
  event: EngineEvent
  status: EngineStatus
  exit: EngineExit
}

export interface SendOptions {
  /** ms; 0 disables the timeout. Defaults depend on the command (see defaultTimeout). */
  timeoutMs?: number
}

/** One session's engine, speaking Vengeance's common command and event protocol. */
export interface EngineHandle {
  readonly pid: number | undefined
  readonly nativeAgentId?: string
  readonly runtime?: EngineRuntimeInfo
  readonly status: EngineStatus
  /** Last spawn/crash error message, if any. */
  readonly error: string | undefined
  start(): Promise<void>
  /** `command.id` is optional; supply one (prefix `r-`) only to correlate streamed events. */
  send(command: RpcCommand, options?: SendOptions): Promise<RpcResponse>
  respondUi(response: RpcExtensionUIResponse): void
  /** Close this connection; resident backends may keep their session running. */
  stop(graceMs?: number): Promise<void>
  /** Apply a backend restart while its current connection can still preserve resident work. */
  prepareRestart?(
    nextArgs: CreateAgentArgs,
    executablePath?: string | null
  ): Promise<CreateAgentArgs | void>
  /** Block side operations while a cross-engine history handoff owns this connection. */
  guardHandoff?(): { assertIdle(): void; release(): void }
  stderr(): string
  /** Native backends implement bridge operations directly, without a loaded extension. */
  bridge?(request: BridgeRequest): Promise<BridgeResult>
  nativeCommand?(type: string, payload?: Record<string, unknown>): Promise<unknown>
  on<K extends keyof EngineHandleEvents>(
    event: K,
    listener: (payload: EngineHandleEvents[K]) => void
  ): () => void
}

/** Minimal typed event emitter used by engine handles. */
export class Emitter<Events> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as (payload: never) => void)
    return () => set.delete(listener as (payload: never) => void)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) (listener as (payload: Events[K]) => void)(payload)
  }
}

const NO_TIMEOUT = new Set<RpcCommandType>([
  // These respond only after long-running work (or after extension dialogs) completes.
  'compact',
  'bash',
  'abort',
  'new_session',
  'switch_session',
  'fork',
  'clone',
  'export_html',
  'share_session'
])

/** Default per-command response timeout in ms (0 = none). */
export function defaultTimeout(type: RpcCommandType): number {
  if (NO_TIMEOUT.has(type)) return 0
  // prompt/steer/follow_up respond after preflight, which can include extension input handlers.
  if (type === 'prompt' || type === 'steer' || type === 'follow_up') return 5 * 60_000
  return 30_000
}
