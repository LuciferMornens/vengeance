import type { BridgeRequest } from '@shared/api/engine'
import type { McpLiveAction, McpLiveStatus } from '@shared/api/mcp'
import { rpc } from '../../lib/engine'
import { invoke } from '../../lib/ipc'
import { useAgents } from '../../store/agents'

/**
 * Each conversation's newest MCP request whose reply is shown, so a slower, older reply never
 * replaces it.
 */
const shown = new Map<string, number>()
let requests = 0

/** Ask for the status (after `request`'s action), and show it unless something newer already is. */
async function requestMcp(
  agentId: string,
  request: Extract<BridgeRequest, { op: 'mcp' }>
): Promise<McpLiveStatus | null> {
  const order = ++requests
  const generation = useAgents.getState().agents[agentId]?.engineGeneration
  const status = (await invoke('engine:bridge', agentId, request, undefined)) as McpLiveStatus | null
  const agent = useAgents.getState().agents[agentId]
  if (!agent) {
    shown.delete(agentId)
    return status
  }
  // A reply from before a restart describes an engine process that is gone.
  if (agent.engineGeneration === generation && order > (shown.get(agentId) ?? 0)) {
    shown.set(agentId, order)
    useAgents.getState().patchAgent(agentId, { mcp: status ?? undefined })
  }
  return status
}

interface McpReads {
  current: Promise<McpLiveStatus | null>
  /** The read that starts when `current` ends, shared by every caller that came during it. */
  next?: Promise<McpLiveStatus | null>
}

const reads = new Map<string, McpReads>()

function startRead(agentId: string): Promise<McpLiveStatus | null> {
  const current: Promise<McpLiveStatus | null> = requestMcp(agentId, { op: 'mcp' }).finally(() => {
    const reading = reads.get(agentId)
    if (reading?.current === current && !reading.next) reads.delete(agentId)
  })
  reads.set(agentId, { current })
  return current
}

/**
 * Read the conversation's MCP status again. The Engine's bridge also publishes every change; Engine 2
 * reports only when asked. One read runs at a time per conversation: a caller that comes during one
 * gets the next, which starts when it ends, so no caller sees a state older than its call.
 */
export function refreshMcp(agentId: string): Promise<McpLiveStatus | null> {
  const reading = reads.get(agentId)
  if (!reading) return startRead(agentId)
  reading.next ??= reading.current.catch(() => null).then(() => startRead(agentId))
  return reading.next
}

/**
 * Run an action on one server of the conversation. pi-mcp-adapter takes no requests from the bridge,
 * so its `/mcp` subcommands go to the conversation as prompts; extension commands run at once, even
 * while the agent works, and report back as notifications.
 */
export async function runMcpAction(
  agentId: string,
  status: McpLiveStatus,
  server: string,
  action: McpLiveAction
): Promise<void> {
  if (status.source === 'adapter') {
    await rpc(agentId, { type: 'prompt', message: `/mcp ${action} ${server}` })
    return
  }
  await requestMcp(agentId, { op: 'mcp', action, server })
}

/** The Engine signs in with its MCP extension's own flow: the browser link and paste prompt arrive as dialogs. */
export async function signInInConversation(agentId: string, status: McpLiveStatus, server: string): Promise<void> {
  const message = status.source === 'adapter' ? `/mcp-auth ${server}` : `/mcp login ${server}`
  await rpc(agentId, { type: 'prompt', message })
}
