import type { RpcSessionState } from '@shared/engine-types'
import { rpc } from '../lib/engine'
import { capabilityStatePatch, type AgentState } from './agent-state'
import { useAgents } from './agents'

const reloads = new Map<string, Promise<void>>()
const mutating = new Set<string>()
type CatalogVersion = Pick<
  AgentState,
  'id' | 'engineGeneration' | 'snapshotRevision' | 'commandsRevision'
>

function catalogKey(agent: Pick<AgentState, 'id' | 'engineGeneration'>): string {
  return `${agent.id}:${agent.engineGeneration}`
}

function currentCatalogAgent(source: CatalogVersion): AgentState | undefined {
  const current = useAgents.getState().agents[source.id]
  return current &&
    current.engineGeneration === source.engineGeneration &&
    current.snapshotRevision === source.snapshotRevision &&
    current.commandsRevision === source.commandsRevision &&
    !mutating.has(catalogKey(source))
    ? current
    : undefined
}

export async function refreshAgentCapabilities(
  agentId: string,
  stateRequest?: Promise<RpcSessionState>
): Promise<void> {
  const source = useAgents.getState().agents[agentId]
  if (!source || mutating.has(catalogKey(source))) return
  try {
    const [state, levels, commands] = await Promise.all([
      stateRequest ?? rpc(agentId, { type: 'get_state' }),
      rpc(agentId, { type: 'get_available_thinking_levels' }),
      rpc(agentId, { type: 'get_commands' })
    ])
    const current = currentCatalogAgent(source)
    if (current) {
      useAgents
        .getState()
        .patchAgent(
          agentId,
          capabilityStatePatch(
            current,
            state,
            levels.levels,
            commands.commands,
            source.modelRevision
          )
        )
    }
  } catch (error) {
    const current = currentCatalogAgent(source)
    if (current && current.commandsStatus !== 'ready') {
      useAgents.getState().patchAgent(agentId, { commandsStatus: 'error' })
    }
    throw error
  }
}

/** Reload mutations invalidate command authority even when their engine and session stay the same. */
export function withCommandCatalogReload(
  agentId: string,
  reloadNative: () => Promise<unknown>
): Promise<void> {
  const source = useAgents.getState().agents[agentId]
  if (!source) return Promise.reject(new Error('This session is closed'))
  const key = catalogKey(source)
  const pending = reloads.get(key)
  if (pending) return pending
  const commandsRevision = source.commandsRevision + 1
  useAgents.getState().patchAgent(agentId, { commandsRevision, commandsStatus: 'loading' })
  mutating.add(key)
  const reload = (async () => {
    let refreshFailure: unknown
    try {
      await reloadNative()
    } finally {
      mutating.delete(key)
      const current = useAgents.getState().agents[agentId]
      if (
        current?.engineGeneration === source.engineGeneration &&
        current.commandsRevision === commandsRevision
      ) {
        useAgents.getState().patchAgent(agentId, {
          commandsRevision: commandsRevision + 1,
          commandsStatus: 'loading'
        })
        await refreshAgentCapabilities(agentId).catch((error) => {
          refreshFailure = error
        })
      }
    }
    if (refreshFailure !== undefined) throw refreshFailure
  })().finally(() => {
    if (reloads.get(key) === reload) reloads.delete(key)
  })
  reloads.set(key, reload)
  return reload
}
