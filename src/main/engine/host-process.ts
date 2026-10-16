import { spawn, type ChildProcess } from 'node:child_process'
import { join, sep } from 'node:path'
import type { AuthEventLike, AuthInteractionLike, AuthPromptLike } from '../features/settings/pi-modules'
import type { ProviderHostConfig } from '../features/settings/provider-host-protocol'
import type { EngineLocation } from './locate'
import { engineEnv, killProcessTree } from './runtime'
import type { SdkHostConfig } from './sdk-host/protocol'

/**
 * A child process that runs the installed engine's code for the main process: the SDK host
 * (`sdk-host/client.ts`) and the provider host (`features/settings/provider-host.ts`). Both run
 * the same bundle with the engine's own node and answer over the Node IPC channel. Each call gets
 * one `result` or `error` message; other messages for a call (the provider host's sign-in prompts
 * and notices) go to its `onMessage`. The host exits once it has had no work for `idleMs`, or for
 * longer when a call (`keepAliveMs`) or keepAlive() asked for it.
 */

/** Host → main: every message names the call it belongs to. */
export interface HostReply {
  id: number
  type: string
  value?: unknown
  message?: string
}

/** Texts of the errors a call ends with when the host goes away. */
export interface HostFailureTexts {
  /** The host could not be started (the spawn error, which names the node path, is only logged). */
  start: string
  /** The host exited on its own. */
  crashed: string
  /** dispose(): a deliberate stop. */
  cancelled: string
  /** A call ran past its timeout. */
  timedOut: string
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onMessage?: (message: HostReply) => void
  timer: NodeJS.Timeout | null
  keepAliveMs: number
}

export interface HostCallOptions {
  timeoutMs?: number
  onMessage?: (message: HostReply) => void
  /** Stay up at least this long once the call settles (default: the host's `idleMs`). */
  keepAliveMs?: number
}

/**
 * The host bundle sits next to the main bundle. Packaged builds unpack it next to app.asar, so the engine's node,
 * which cannot read inside the archive, can run it.
 */
function hostScript(): string {
  return join(__dirname, 'provider-host.js').replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`
  )
}

/** Start the host bundle with the engine's node; `config` is its first argument (it picks the role). */
export function spawnHost(
  location: EngineLocation,
  config: ProviderHostConfig | SdkHostConfig,
  cwd?: string
): ChildProcess {
  return spawn(location.node.path, [hostScript(), JSON.stringify(config)], {
    cwd,
    env: engineEnv(location),
    windowsHide: true,
    // The engine's code may print while it loads; only the IPC channel carries the protocol.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json'
  })
}

/** The sign-in messages the provider host sends for a login call (`sdk-host/host-engine.ts` SignIns). */
type SignInReply =
  | { id: number; type: 'prompt'; promptId: number; prompt: Omit<AuthPromptLike, 'signal'> }
  | { id: number; type: 'prompt-cancelled'; promptId: number }
  | { id: number; type: 'notice'; event: AuthEventLike }

/**
 * Run a login call on `host`, relaying its prompts and notices to `ui`: answers go back as `respond`, and aborting
 * `ui.signal` sends `cancel`. Resolves with the call's result.
 */
export async function callWithSignIn<Request extends { type: string }>(
  host: HostProcess,
  request: Request,
  ui: AuthInteractionLike
): Promise<unknown> {
  const promptControllers = new Map<number, AbortController>()
  const { id, done } = host.call(request, {
    onMessage(reply) {
      // SAFETY: protocol boundary: non-result messages of a login call are sign-in messages.
      const message = reply as SignInReply
      if (message.type === 'prompt') {
        const controller = new AbortController()
        promptControllers.set(message.promptId, controller)
        ui.prompt({ ...message.prompt, signal: controller.signal }).then(
          (value) => host.send({ id, type: 'respond', promptId: message.promptId, value }),
          () => host.send({ id, type: 'respond', promptId: message.promptId, value: null })
        )
      } else if (message.type === 'prompt-cancelled') {
        promptControllers.get(message.promptId)?.abort()
      } else if (message.type === 'notice') {
        ui.notify(message.event)
      }
    }
  })
  const cancel = () => host.send({ id, type: 'cancel' })
  ui.signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await done
  } finally {
    ui.signal?.removeEventListener('abort', cancel)
  }
}

export class HostProcess {
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 0
  private idleTimer: NodeJS.Timeout | null = null
  /** The host exits once it is idle and this time has passed. */
  private keepAliveUntil = 0
  private exited = false

  constructor(
    readonly key: string,
    private readonly child: ChildProcess,
    private readonly idleMs: number,
    private readonly texts: HostFailureTexts,
    /** `reason`: the text pending calls ended with (`texts.cancelled` for dispose()). */
    private readonly onExit: (host: HostProcess, reason: string) => void
  ) {
    child.on('message', (message: HostReply) => this.receive(message))
    // Without a pid the process never started; otherwise the error is a send to a host that just died.
    child.on('error', (error) => {
      if (child.pid === undefined && !this.exited) {
        console.error(`[vengeance] ${texts.start} ${error.message}`)
      }
      this.exit(child.pid === undefined ? texts.start : texts.crashed)
    })
    child.on('exit', () => this.exit(texts.crashed))
    this.keepAlive(idleMs)
  }

  get alive(): boolean {
    return !this.exited
  }

  get busy(): boolean {
    return this.pending.size > 0
  }

  /** Start a call; `done` settles with the host's answer. */
  call<Request extends { type: string }>(
    request: Request,
    options: HostCallOptions = {}
  ): { id: number; done: Promise<unknown> } {
    const id = ++this.nextId
    const done = new Promise<unknown>((resolve, reject) => {
      if (this.exited) {
        reject(new Error(this.texts.crashed))
        return
      }
      const timer = options.timeoutMs
        ? setTimeout(() => this.timeOut(id), options.timeoutMs)
        : null
      const keepAliveMs = options.keepAliveMs ?? this.idleMs
      this.pending.set(id, { resolve, reject, onMessage: options.onMessage, timer, keepAliveMs })
      this.cancelIdleExit()
      this.send({ ...request, id })
    })
    return { id, done }
  }

  send<Request extends { id: number; type: string }>(request: Request): void {
    if (!this.exited && this.child.connected) this.child.send(request)
  }

  /** Stay up at least `ms` from now (an idle host exits then; a busy one once its calls settle). */
  keepAlive(ms: number): void {
    this.keepAliveUntil = Math.max(this.keepAliveUntil, Date.now() + ms)
    if (this.pending.size === 0 && !this.exited) this.scheduleIdleExit()
  }

  /** A deliberate stop: calls still running end with the `cancelled` text. */
  dispose(): void {
    if (this.exited) return
    killProcessTree(this.child)
    this.exit(this.texts.cancelled)
  }

  /** A call that hangs means the engine's code hangs: the host is of no further use. */
  private timeOut(id: number): void {
    this.fail(id, new Error(this.texts.timedOut))
    this.dispose()
  }

  private receive(message: HostReply): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.type === 'result') this.settle(message.id, () => pending.resolve(message.value))
    else if (message.type === 'error') this.fail(message.id, new Error(message.message))
    else pending.onMessage?.(message)
  }

  private fail(id: number, error: Error): void {
    const pending = this.pending.get(id)
    if (pending) this.settle(id, () => pending.reject(error))
  }

  private settle(id: number, finish: () => void): void {
    const pending = this.pending.get(id)
    if (pending?.timer) clearTimeout(pending.timer)
    this.pending.delete(id)
    finish()
    if (pending) this.keepAlive(pending.keepAliveMs)
  }

  private scheduleIdleExit(): void {
    this.cancelIdleExit()
    this.idleTimer = setTimeout(() => this.dispose(), Math.max(0, this.keepAliveUntil - Date.now()))
    this.idleTimer.unref()
  }

  private cancelIdleExit(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private exit(reason: string): void {
    if (this.exited) return
    this.exited = true
    this.cancelIdleExit()
    for (const id of [...this.pending.keys()]) this.fail(id, new Error(reason))
    this.onExit(this, reason)
  }
}
