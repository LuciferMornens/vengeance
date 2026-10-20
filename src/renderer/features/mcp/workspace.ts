import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { EngineId } from '@shared/api/engine'
import { samePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { toast } from '../../ui'
import { refreshMcp, runMcpAction } from './actions'
import { mergeWorkspaceMcp, plural, type WorkspaceMcpServer } from './status'

/**
 * Live MCP state of the folder's open conversations of one engine, by server name. Only the folder's
 * conversations count: another folder's project configuration can turn a server off or name a different
 * one the same. Engine 2 reports only when asked, so its conversations are asked when the folder or
 * their number changes.
 */
export function useWorkspaceMcp(engine: EngineId, cwd: string | null): Map<string, WorkspaceMcpServer> {
  const agentIds = useAgents(
    useShallow((s) =>
      s.order.filter((id) => {
        const agent = s.agents[id]
        return agent?.info.engine === engine && agent.status === 'ready' && samePath(agent.info.cwd, cwd)
      })
    )
  )
  const statuses = useAgents(useShallow((s) => agentIds.map((id) => s.agents[id]?.mcp)))
  useEffect(() => {
    if (engine !== 'prime') return
    for (const agentId of agentIds) void refreshMcp(agentId).catch(() => undefined)
  }, [engine, agentIds])
  return useMemo(() => mergeWorkspaceMcp(agentIds, statuses), [agentIds, statuses])
}

/**
 * Open sessions whose engine runs the server's connection now: it is on there, and the engine runs its
 * MCP connections (Engine 2 opens them with its kernel, and reconnects only the servers it lists).
 */
function runningSessions(entry: WorkspaceMcpServer | undefined): WorkspaceMcpServer['agents'] {
  return (
    entry?.agents.filter(
      ({ status, server }) =>
        status.live &&
        server.state !== 'disabled' &&
        server.state !== 'blocked' &&
        server.reconnectable !== false
    ) ?? []
  )
}

/** Whether Reconnect can act on the server: an open session of the folder runs its connection now. */
export function canReconnectInSessions(entry: WorkspaceMcpServer | undefined): entry is WorkspaceMcpServer {
  return runningSessions(entry).length > 0
}

/** Whether the server is connecting in every open session that runs it, so Reconnect waits. */
export function connectingInSessions(entry: WorkspaceMcpServer): boolean {
  return runningSessions(entry).every(({ server }) => server.state === 'connecting')
}

/** Reconnect the server in every open session of the folder that runs it, reporting progress as toasts. */
export async function reconnectInSessions(name: string, entry: WorkspaceMcpServer | undefined): Promise<void> {
  const sessions = runningSessions(entry)
  if (sessions.length === 0) {
    toast({
      level: 'info',
      title: `No open session in this folder runs ${name}`,
      description: 'New sessions connect with the current configuration.'
    })
    return
  }
  toast({
    level: 'info',
    title: `Reconnecting ${name}`,
    description: `In ${plural(sessions.length, 'open session')} in this folder`
  })
  const results = await Promise.allSettled(
    sessions.map(({ agentId, status, server }) => runMcpAction(agentId, status, server.name, 'reconnect'))
  )
  const failures = results.filter((result) => result.status === 'rejected')
  const failure = failures[0]
  if (failure) {
    const where = sessions.length === 1 ? '' : `In ${failures.length} of ${sessions.length} sessions: `
    toast({
      level: 'warning',
      title: `Could not reconnect ${name}`,
      description: `${where}${(failure.reason as Error).message}`
    })
  }
}
