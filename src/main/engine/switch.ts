import { randomUUID } from 'node:crypto'
import type { AgentInfo, CreateAgentArgs } from '@shared/api/engine'
import type { AgentMessage, RpcSessionState, SessionEntry } from '@shared/engine-types'
import type { EngineHandle } from './handle'
import { asRecord, asRecords, stringValue } from './prime/transport'

export interface HandoffSnapshot {
  state: RpcSessionState
  messages: AgentMessage[]
  entries: SessionEntry[]
  leafId: string | null
}

export function hasHandoffHistory(snapshot: HandoffSnapshot): boolean {
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
  const visited = new Set<string>()
  for (let entryId = snapshot.leafId; entryId;) {
    const entry = entries.get(entryId)
    if (!entry || visited.has(entryId)) throw new Error('The source session has an invalid branch')
    visited.add(entryId)
    if (!['model_change', 'thinking_level_change', 'session_info', 'label'].includes(entry.type)) {
      return true
    }
    entryId = entry.parentId
  }
  return false
}

export function assertSwitchTarget(source: AgentInfo, target: CreateAgentArgs): void {
  if (target.sessionPath || target.forkFrom || target.nativeAgentId) {
    throw new Error('Engine switching creates its own destination session')
  }
  if (target.extraArgs?.length) {
    throw new Error('Remove extra launch arguments before switching engines')
  }
  const sessionFlags = new Set([
    'session',
    'session-dir',
    'no-session',
    'fork',
    'continue',
    'resume'
  ])
  if (Object.keys(target.launch?.extensionFlags ?? {}).some((flag) => sessionFlags.has(flag))) {
    throw new Error('Remove session overrides from extension flags before switching engines')
  }
  if (source.status !== 'ready' || source.busy) {
    throw new Error('Wait until this session is idle before switching engines')
  }
}

function assertIdle(state: RpcSessionState): void {
  if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
    throw new Error(
      'Finish or clear this session’s active and queued work before switching engines'
    )
  }
}

export async function captureHandoffSnapshot(handle: EngineHandle): Promise<HandoffSnapshot> {
  const state = await handle.send({ type: 'get_state' })
  if (!state.success || state.command !== 'get_state') {
    throw new Error('The source engine could not report its current session')
  }
  assertIdle(state.data)
  const [messages, entries] = await Promise.all([
    handle.send({ type: 'get_messages' }),
    handle.send({ type: 'get_entries' })
  ])
  if (!messages.success || messages.command !== 'get_messages') {
    throw new Error('The source engine could not export its conversation')
  }
  if (!entries.success || entries.command !== 'get_entries') {
    throw new Error('The source engine could not export its complete session history')
  }
  return structuredClone({
    state: state.data,
    messages: messages.data.messages,
    entries: entries.data.entries,
    leafId: entries.data.leafId
  })
}

export async function pausePrimeHandoff(handle: EngineHandle): Promise<() => Promise<void>> {
  if (!handle.nativeCommand) throw new Error('The source engine cannot pause incoming work')
  const result = asRecord(
    await handle.nativeCommand('acquire_session_input_pause', {
      leaseKey: `vengeance-handoff-${randomUUID()}`
    })
  )
  if (typeof result.pauseId !== 'string') {
    throw new Error('The source engine could not pause incoming work')
  }
  const release = async (): Promise<void> => {
    await handle.nativeCommand?.('release_session_input_pause', { pauseId: result.pauseId })
  }
  try {
    await assertPrimeHandoffIdle(handle)
  } catch (error) {
    await release()
    throw error
  }
  return release
}

export async function assertPrimeHandoffIdle(
  handle: Pick<EngineHandle, 'nativeAgentId' | 'nativeCommand'>
): Promise<void> {
  const result = asRecord(
    await handle.nativeCommand?.('list', {
      all: false,
      includeClientOwned: true
    })
  )
  const state = asRecords(result.sessions ?? result.agents).find(
    (session) =>
      (stringValue(session.activeSessionId) ?? stringValue(session.id)) === handle.nativeAgentId
  )
  if (!state) throw new Error('The source engine could not verify its resident session')
  if (typeof state.hasRunningSubagents !== 'boolean' || typeof state.isRunningTools !== 'boolean') {
    throw new Error('The source engine cannot verify whether its child agents and tools are idle')
  }
  const flags = [
    'isStreaming',
    'isCompacting',
    'isBashRunning',
    'hasRunningSubagents',
    'isRunningTools'
  ]
  if (flags.some((key) => state[key] === true) || state.isQuotaParked === true) {
    throw new Error(
      'Wait until this session and its child agents are idle before switching engines'
    )
  }
}

export function sameHandoffSnapshot(first: HandoffSnapshot, second: HandoffSnapshot): boolean {
  return (
    first.state.sessionId === second.state.sessionId &&
    first.state.sessionFile === second.state.sessionFile &&
    first.leafId === second.leafId &&
    JSON.stringify(first.entries) === JSON.stringify(second.entries) &&
    JSON.stringify(first.messages) === JSON.stringify(second.messages)
  )
}
