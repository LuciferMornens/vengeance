import { useEffect } from 'react'
import type { AgentState } from '../../store/agent-state'
import { useAgents, type AgentsStore } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast } from '../../ui'
import { openSubagentDetail } from './open'

/** Only outcomes this fresh are announced; older ones were rebuilt from history. */
const FRESH_MS = 5000

let unsubscribe: (() => void) | undefined
import.meta.hot?.dispose(() => {
  unsubscribe?.()
  unsubscribe = undefined
})

/** The user is not looking at this run: the window is in the background or another session is in front. */
function outOfView(agentId: string, state: AgentsStore): boolean {
  if (!document.hasFocus() || state.activeAgentId !== agentId) return true
  const { open, tab } = useApp.getState().prefs.inspector
  return !(open && tab === 'agents')
}

function announce(agent: AgentState, previous: AgentState | undefined, state: AgentsStore): void {
  if (!previous || previous.subagents === agent.subagents) return
  const now = Date.now()
  for (const [requestId, entry] of Object.entries(agent.subagents.requests)) {
    if (
      previous.subagents.requests[requestId] ||
      entry.state !== 'pending' ||
      now - entry.receivedAt > FRESH_MS
    )
      continue
    if (!document.hasFocus() || state.activeAgentId !== agent.id) {
      toast({
        level: 'warning',
        title: `${entry.request.agent} needs a decision`,
        action: { label: 'Open', onClick: () => openSubagentDetail(agent.id, entry.request.runId) }
      })
    }
  }
  for (const [runId, run] of Object.entries(agent.subagents.runs)) {
    const final = run.final
    if (!final || previous.subagents.runs[runId]?.final || now - final.at > FRESH_MS) continue
    if ((final.state !== 'failed' && final.state !== 'rejected') || !outOfView(agent.id, state))
      continue
    toast({
      level: 'error',
      title: `${run.label} failed${final.reason ? ` · ${final.reason}` : ''}`,
      action: { label: 'Open', onClick: () => openSubagentDetail(agent.id, runId) }
    })
  }
}

/** Toast decisions and failures the user would otherwise miss (once per app, for every session). */
export function useSubagentNotifications(): void {
  useEffect(() => {
    // Keep background-session notifications active when another engine hides the fleet pill.
    unsubscribe ??= useAgents.subscribe((state, previous) => {
      for (const agent of Object.values(state.agents))
        announce(agent, previous.agents[agent.id], state)
    })
  }, [])
}
