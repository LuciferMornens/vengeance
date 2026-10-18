import type { AgentInfo, CreateAgentArgs, EngineId } from '@shared/api/engine'
import { EXTENSION_UI_DIALOG_METHODS, type EngineEvent } from '@shared/engine-types'
import type { EngineHandle } from './handle'
import { locateEngine, type EngineLocation } from './locate'

export interface RestartDialog {
  deadline: number
  duringRun: boolean
}

export async function locateRestartEngine(
  engine: EngineId,
  mock: boolean,
  overridePath: string | null
): Promise<EngineLocation | undefined> {
  if (mock) return undefined
  if (engine === 'pi') return locateEngine(overridePath)
  // The native locator imports Electron, while offline manager checks run in plain Node.
  const { primeEngineInfo } = await import('./prime/locate')
  const details = await primeEngineInfo(overridePath)
  if (!details.found) throw new Error(details.error ?? 'Engine 2 could not be found')
  return undefined
}

export function observeRestartDialog(
  dialogs: Map<string, RestartDialog>,
  event: EngineEvent,
  duringRun: boolean
): void {
  if (event.type === 'agent_settled' && event.aborted) {
    for (const [id, dialog] of dialogs) {
      if (dialog.duringRun) dialogs.delete(id)
    }
    return
  }
  if (
    event.type !== 'extension_ui_request' ||
    !EXTENSION_UI_DIALOG_METHODS.some((method) => method === event.method)
  ) {
    return
  }
  const timeout = 'timeout' in event ? event.timeout : undefined
  dialogs.set(event.id, {
    deadline: timeout ? Date.now() + timeout : Number.POSITIVE_INFINITY,
    duringRun
  })
}

export function assertRestartIdle(
  info: AgentInfo,
  operations: number,
  dialogs: Map<string, RestartDialog>
): void {
  if (info.status === 'starting' || info.status === 'stopping' || operations) {
    throw new Error('Wait for the current session operation to finish before restarting')
  }
  if (info.busy) {
    throw new Error('Wait until this session finishes its active work before restarting')
  }
  for (const [id, dialog] of dialogs) {
    if (Date.now() >= dialog.deadline) dialogs.delete(id)
  }
  if (info.status === 'ready' && dialogs.size) {
    throw new Error('Finish this session’s extension dialog before restarting')
  }
}

export async function prepareRestartArgs(
  info: AgentInfo,
  handle: EngineHandle | null,
  patch?: Partial<CreateAgentArgs>
): Promise<CreateAgentArgs> {
  const stored = { ...info.args, ...patch, cwd: info.cwd, engine: info.engine }
  let resume = info.sessionFile
  if (handle && info.status === 'ready') {
    const response = await handle.send({ type: 'get_state' })
    if (!response.success || response.command !== 'get_state') {
      throw new Error('The engine could not verify that this session is idle before restarting')
    }
    const state = response.data
    if (
      typeof state.isStreaming !== 'boolean' ||
      typeof state.isCompacting !== 'boolean' ||
      !Number.isSafeInteger(state.messageCount) ||
      state.messageCount < 0 ||
      !Number.isSafeInteger(state.pendingMessageCount) ||
      state.pendingMessageCount < 0
    ) {
      throw new Error('The engine could not verify this session’s active and queued work')
    }
    if (state.isStreaming || state.isCompacting) {
      throw new Error('Wait until this session finishes its active work before restarting')
    }
    if (info.engine === 'pi' && state.pendingMessageCount > 0) {
      throw new Error('Finish or clear this session’s queued messages before restarting')
    }
    if (!state.sessionFile && state.messageCount > 0) {
      throw new Error('Temporary conversations with messages cannot be restarted safely')
    }
    resume = state.sessionFile
    if (info.engine === 'pi') {
      if (!patch || !Object.hasOwn(patch, 'provider')) {
        stored.provider = state.model?.provider ?? stored.provider
      }
      if (!patch || !Object.hasOwn(patch, 'model')) {
        stored.model = state.model?.id ?? stored.model
      }
      if (!patch || !Object.hasOwn(patch, 'thinking')) stored.thinking = state.thinkingLevel
    }
  }
  return resume
    ? { ...stored, sessionPath: resume, forkFrom: undefined, noSession: undefined }
    : stored
}
