import type { McpLiveServer, McpLiveState, McpLiveStatus } from '@shared/api/mcp'
import { mcpFailureReason } from '../settings/mcp-error'

/** The dot next to a server, by its live state. */
export const MCP_DOT: Record<McpLiveState, string> = {
  connected: 'bg-success',
  connecting: 'animate-pulse bg-warning',
  idle: 'shadow-[inset_0_0_0_1.25px_var(--fg-3)]',
  'needs-auth': 'bg-warning',
  failed: 'bg-danger',
  disabled: 'bg-fg-4/50',
  blocked: 'bg-fg-4/50'
}

/** Text colour for a server's state line. */
export function mcpStateTone(state: McpLiveState): string {
  return state === 'needs-auth' ? 'text-warning' : state === 'failed' ? 'text-danger' : 'text-fg-3'
}

export function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`
}

/** One server's state in a conversation, in words. */
export function mcpStateText(server: McpLiveServer): string {
  const tools = server.toolCount !== undefined ? plural(server.toolCount, 'tool') : undefined
  switch (server.state) {
    case 'connected':
      return tools ? `Connected · ${tools}` : 'Connected'
    case 'connecting':
      return 'Connecting…'
    case 'idle':
      return [server.note ?? 'Not connected yet', tools].filter(Boolean).join(' · ')
    case 'needs-auth':
      return 'Needs sign-in'
    case 'failed':
      return 'Failed'
    case 'disabled':
      return 'Off'
    case 'blocked':
      return 'Blocked until the project is trusted'
  }
}

/** One server as the folder's open conversations see it. */
export interface WorkspaceMcpServer {
  /**
   * Its copy in the worst state across the conversations, so the dot, the tone and the failure details
   * come from one that has the problem.
   */
  server: McpLiveServer
  /** Every open conversation that lists it, with its own copy and its whole status (for actions). */
  agents: Array<{ agentId: string; status: McpLiveStatus; server: McpLiveServer }>
}

/** Worst first. Off and blocked come last: a row shows them only when no conversation runs the server. */
const WORST_FIRST: readonly McpLiveState[] = [
  'failed',
  'needs-auth',
  'connecting',
  'idle',
  'connected',
  'blocked',
  'disabled'
]

/** The servers of the folder's open conversations by name, from each one's status (in `agentIds` order). */
export function mergeWorkspaceMcp(
  agentIds: readonly string[],
  statuses: ReadonlyArray<McpLiveStatus | undefined>
): Map<string, WorkspaceMcpServer> {
  const servers = new Map<string, WorkspaceMcpServer>()
  agentIds.forEach((agentId, index) => {
    const status = statuses[index]
    if (!status) return
    for (const server of status.servers) {
      const entry = servers.get(server.name)
      if (!entry) {
        servers.set(server.name, { server, agents: [{ agentId, status, server }] })
        continue
      }
      entry.agents.push({ agentId, status, server })
      if (WORST_FIRST.indexOf(server.state) < WORST_FIRST.indexOf(entry.server.state)) {
        entry.server = server
      }
    }
  })
  return servers
}

/** A state after the leading one on a Settings row: "connected" in "… (connected in 2)". */
function laterStateText(server: McpLiveServer): string {
  switch (server.state) {
    case 'connected':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'idle': {
      const note = server.note ?? 'Not connected yet'
      return note.charAt(0).toLowerCase() + note.slice(1)
    }
    case 'needs-auth':
      return 'needs sign-in'
    case 'failed':
      return 'failed'
    case 'disabled':
      return 'off'
    case 'blocked':
      return 'blocked'
  }
}

/**
 * A server's state across the folder's open sessions, for a Settings row. When the sessions disagree it
 * leads with the worst state and counts the others: "Failed in 1 of 3 open sessions (connected in 2): …".
 */
export function workspaceStateText(entry: WorkspaceMcpServer): string {
  const { server, agents } = entry
  const leading = agents.filter((agent) => agent.server.state === server.state).length
  const others = WORST_FIRST.filter((state) => state !== server.state).flatMap((state) => {
    const copies = agents.filter((agent) => agent.server.state === state)
    const first = copies[0]
    return first ? [`${laterStateText(first.server)} in ${copies.length}`] : []
  })
  const where =
    agents.length === 1
      ? 'in the open session'
      : others.length === 0
        ? `in ${agents.length} open sessions`
        : `in ${leading} of ${agents.length} open sessions (${others.join(', ')})`
  const tools = server.toolCount !== undefined ? ` · ${plural(server.toolCount, 'tool')}` : ''
  switch (server.state) {
    case 'connected':
      return `Connected${tools} ${where}`
    case 'connecting':
      return `Connecting ${where}${others.length === 0 ? '…' : ''}`
    case 'needs-auth':
      return `Needs sign-in ${where}`
    case 'failed':
      return `Failed ${where}${server.error ? `: ${mcpFailureReason(server.error)}` : ''}`
    case 'disabled':
      return 'Off'
    case 'blocked':
      return `Blocked ${where} until the project is trusted`
    case 'idle':
      return `${server.note ?? 'Not connected yet'} ${where}`
  }
}
