import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc'

/**
 * Electron's own copy failures: contextBridge's depth limit, or main's structured clone giving up on a reply. Main
 * bounds payloads, so these are a backstop; their text is Electron's, not something to show.
 */
const COPY_ERROR = /contextBridge recursion depth exceeded|could not be cloned/i
/** The prefix Electron puts on errors raised outside our handlers' envelope. */
const ELECTRON_INVOKE_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/

/** Typed IPC client (thin wrapper over the preload bridge). */
export async function invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<InvokeResult<C>> {
  try {
    return await window.vengeance.invoke(channel, ...args)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (COPY_ERROR.test(error.message)) throw new Error('The answer was too large or nested too deeply to show.')
    if (ELECTRON_INVOKE_PREFIX.test(error.message)) throw new Error(error.message.replace(ELECTRON_INVOKE_PREFIX, ''))
    throw error
  }
}

export function on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void {
  return window.vengeance.on(channel, listener)
}

export const platform = window.vengeance.platform
