import type { AgentInfo } from '@shared/api/engine'
import { rpc } from '../../lib/engine'
import { invoke } from '../../lib/ipc'
import { samePath } from '../../lib/paths'
import { hydrateMessages } from '../../store/agent-reducer'
import { createAgentState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'

/**
 * After a renderer crash, main keeps the engines running and the reloaded window takes them over: each one is
 * added back to the agents store (live events reach it from then on) and its transcript is read from the engine.
 * Returns how many engines were adopted (0 on a normal start).
 */
export async function adoptEngines(
  activationRevision = useAgents.getState().activationRevision
): Promise<number> {
  const infos = await invoke('engine:adopt').catch(() => [] as AgentInfo[])
  if (infos.length === 0) return 0
  useAgents.setState((state) => ({
    agents: {
      ...state.agents,
      ...Object.fromEntries(infos.map((info) => [info.agentId, createAgentState(info)]))
    },
    order: [
      ...state.order,
      ...infos.map((info) => info.agentId).filter((id) => !state.order.includes(id))
    ]
  }))
  // The window stays in its workspace: its latest session goes in front, or none when it has no open session.
  const { activeWorkspace } = useApp.getState().prefs
  const active = activeWorkspace
    ? infos.filter((info) => samePath(info.cwd, activeWorkspace)).pop()
    : infos.at(-1)
  if (active) useAgents.getState().setActive(active.agentId, activationRevision)
  await Promise.all(
    infos
      .filter((info) => info.status === 'ready')
      .map((info) => rehydrate(info.agentId).catch(() => undefined))
  )
  return infos.length
}

/**
 * An idle engine gets the normal full refresh. A running one keeps streaming into the store, so its transcript so
 * far is read without settling its open tools, and the full refresh runs once the run settles (the authoritative
 * transcript then replaces anything a message that ended during the read could have doubled).
 */
async function rehydrate(agentId: string): Promise<void> {
  const store = useAgents.getState()
  const [state, messages] = await Promise.all([
    rpc(agentId, { type: 'get_state' }),
    rpc(agentId, { type: 'get_messages' })
  ])
  if (!state.isStreaming) {
    await store.refresh(agentId)
    return
  }
  const { entries, tools } = hydrateMessages(messages.messages, false)
  store.patchAgent(agentId, { phase: 'running', entries, tools })
  const unsubscribe = useAgents.subscribe((next) => {
    if (next.agents[agentId]?.phase === 'running') return
    unsubscribe()
    void useAgents
      .getState()
      .refresh(agentId)
      .catch(() => undefined)
  })
  // The run may have settled between the read and the patch above; its agent_settled is then already applied.
  const after = await rpc(agentId, { type: 'get_state' })
  if (!after.isStreaming) useAgents.getState().patchAgent(agentId, { phase: 'idle' })
  await Promise.all([store.refreshCapabilities(agentId), store.refreshStats(agentId)])
}
