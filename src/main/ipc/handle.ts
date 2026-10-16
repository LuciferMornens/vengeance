import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  EventChannel,
  EventMap,
  InvokeArgs,
  InvokeChannel,
  InvokeEnvelope,
  InvokeResult
} from '@shared/ipc'
import { env } from '../env'
import { limitPayloadDepth } from './payload-depth'

export type InvokeHandler<C extends InvokeChannel> = (
  ...args: [...InvokeArgs<C>, IpcMainInvokeEvent]
) => Promise<InvokeResult<C>> | InvokeResult<C>

type RegisteredHandler = (args: unknown[], event: IpcMainInvokeEvent) => Promise<unknown> | unknown

const registeredHandlers = new Map<InvokeChannel, RegisteredHandler>()

export function isRegisteredInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && registeredHandlers.has(value as InvokeChannel)
}

const devOrigin = env.rendererUrl ? new URL(env.rendererUrl).origin : null

/** Only our own renderer may call main: the packaged/built file:// page, or the dev server in `npm run dev`. */
function trustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  if (!url) return false
  try {
    const parsed = new URL(url)
    return devOrigin ? parsed.origin === devOrigin : parsed.protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * Register a typed invoke handler. Errors are returned as an envelope so the renderer receives the
 * original message (the preload rethrows it as an Error).
 */
export function handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
  const registered: RegisteredHandler = (args, event) =>
    handler(...([...args, event] as [...InvokeArgs<C>, IpcMainInvokeEvent]))
  registeredHandlers.set(channel, registered)
  ipcMain.handle(
    channel,
    async (event, ...args: unknown[]): Promise<InvokeEnvelope<InvokeResult<C>>> => {
      if (!trustedSender(event))
        return {
          ok: false,
          error: {
            message: `Refusing ${channel} from an untrusted frame`,
            code: 'untrusted-sender'
          }
        }
      try {
        const value = await handler(...([...args, event] as [...InvokeArgs<C>, IpcMainInvokeEvent]))
        return { ok: true, value: limitPayloadDepth(value) }
      } catch (error) {
        const err = error as Error & { code?: string }
        return { ok: false, error: { message: err.message ?? String(error), code: err.code } }
      }
    }
  )
}

/** Route a validated internal request through a feature's registered implementation. */
export async function invokeRegistered<C extends InvokeChannel>(
  channel: C,
  args: InvokeArgs<C>,
  event: IpcMainInvokeEvent
): Promise<InvokeResult<C>> {
  const handler = registeredHandlers.get(channel)
  if (!handler) throw new Error(`Unsupported operation: ${channel}`)
  // The channel map owns the argument/result relationship across this IPC dispatch boundary.
  return (await handler(args, event)) as InvokeResult<C>
}

/** Send a typed event to every renderer window. */
export function broadcast<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
  const bounded = limitPayloadDepth(payload)
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, bounded)
  }
}

/** Quit-time cleanup that never throws: an uncaught error while quitting shows Electron's native error dialog. */
export function onQuit(event: 'before-quit' | 'will-quit', cleanup: () => void): void {
  const run = (): void => {
    try {
      cleanup()
    } catch (error) {
      console.warn(`[vengeance] ${event} cleanup failed: ${(error as Error).message}`)
    }
  }
  if (event === 'before-quit') app.on('before-quit', run)
  else app.on('will-quit', run)
}
