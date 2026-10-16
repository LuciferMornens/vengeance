import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { activateAgent } from '../sessions/actions'
import { markSeen, useSubagentUi } from './store'

/**
 * Open a run in the inspector's Agents tab (switching to its session first when it is in the background).
 * `intent: 'steer'` opens the detail with the steer box ready.
 */
export function openSubagentDetail(agentId: string, runId: string, childId?: string, intent?: 'steer'): void {
  if (useAgents.getState().activeAgentId !== agentId) activateAgent(agentId)
  markSeen(agentId, runId)
  useSubagentUi.getState().select({ agentId, runId, childId, intent })
  useApp.getState().setInspectorTab('agents')
}
