import type { AgentInfo, SubagentsRpcMethod, SubagentsRpcReply } from '@shared/api/engine'
import {
  supervisorReplyPrompt,
  type SubagentInspectReply,
  type SubagentInspectRequest,
  type SubagentSupervisorRequest
} from '@shared/subagents'
import { bridge } from '../../lib/bridge'
import { rpc } from '../../lib/engine'
import { invoke } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { linkResumedRun, setRequestState, useSubagentUi, type SubagentTarget } from './store'

/**
 * Fleet management. The primary transport is the Vengeance bridge, which proxies pi-subagents' event-bus
 * RPC: no transcript message, no model turn. When the bridge or pi-subagents' RPC is missing, steer and stop
 * fall back to pi-subagents' slash commands (they post a quiet `subagent-slash-*` notice into the session).
 */

type RpcData = Record<string, unknown>

/** Agents whose engine answered `ping` (pi-subagents' event-bus RPC is reachable through the bridge). */
const reachable = new WeakSet<AgentInfo>()

async function canUseRpc(agentId: string): Promise<boolean> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent || agent.status !== 'ready' || !bridge.available(agentId)) return false
  if (reachable.has(agent.info)) return true
  const reply = await bridge.subagents(agentId, 'ping').catch(() => null)
  if (reply?.success) reachable.add(agent.info)
  return reply?.success === true
}

function asRecord(value: unknown): RpcData {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RpcData)
    : {}
}

async function callRpc(
  agentId: string,
  method: SubagentsRpcMethod,
  params: RpcData
): Promise<RpcData> {
  const reply: SubagentsRpcReply = await bridge.subagents(agentId, method, params)
  if (!reply.success) {
    const info = useAgents.getState().agents[agentId]?.info
    if (reply.error.code === 'timeout' && info) reachable.delete(info)
    throw new Error(reply.error.message)
  }
  return asRecord(reply.data)
}

/**
 * Run a pi-subagents slash command inline. Only commands the engine lists are sent: an unknown one would
 * become a user prompt (a model turn, or a steer while the agent works).
 */
async function slash(agentId: string, name: string, args: string): Promise<void> {
  const known = useAgents
    .getState()
    .agents[agentId]?.commands.some((command) => command.name === name)
  if (!known) throw new Error('The subagents extension is not loaded in this engine')
  await rpc(agentId, {
    type: 'prompt',
    message: args ? `/${name} ${args}` : `/${name}`,
    streamingBehavior: 'steer'
  })
}

/** `step:<n>` children are addressed by index; other children by their own run id. */
function steerTarget(target: SubagentTarget): RpcData {
  const step = target.childId ? /^step:(\d+)$/.exec(target.childId) : null
  if (step) return { id: target.runId, index: Number(step[1]) }
  return { id: target.childId ?? target.runId }
}

function deliveryOf(data: RpcData): 'delivered' | 'queued' {
  const steering = asRecord(asRecord(data.details).steering)
  return steering.deliveryStatus === 'delivered' || steering.state === 'delivered'
    ? 'delivered'
    : 'queued'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const subagentActions = {
  async steer(
    agentId: string,
    target: SubagentTarget,
    message: string,
    mode: 'steer' | 'follow_up' = 'steer'
  ): Promise<{ delivery: 'delivered' | 'queued' | 'failed'; error?: string }> {
    try {
      if (await canUseRpc(agentId)) {
        return {
          delivery: deliveryOf(
            await callRpc(agentId, 'steer', { ...steerTarget(target), message, mode })
          )
        }
      }
      const child = target.childId ? ` --child ${target.childId}` : ''
      await slash(agentId, 'subagents-steer', `${target.runId}${child} ${message}`)
      return { delivery: 'queued' }
    } catch (error) {
      return { delivery: 'failed', error: errorText(error) }
    }
  },

  async stop(agentId: string, target: SubagentTarget): Promise<void> {
    if (await canUseRpc(agentId)) {
      await callRpc(agentId, 'stop', {
        id: target.runId,
        ...(target.childId ? { childId: target.childId } : {})
      })
      return
    }
    await slash(
      agentId,
      'subagents-stop',
      `${target.runId}${target.childId ? ` ${target.childId}` : ''}`
    )
  },

  /** Revive a finished run with a message; the new run is linked to the old one. Needs the bridge. */
  async resume(agentId: string, runId: string, message: string): Promise<{ runId: string }> {
    if (!(await canUseRpc(agentId))) throw new Error('Resuming needs the subagents extension')
    const data = await callRpc(agentId, 'resume', { id: runId, message })
    const details = asRecord(data.details)
    const next =
      typeof details.runId === 'string'
        ? details.runId
        : typeof details.asyncId === 'string'
          ? details.asyncId
          : null
    if (!next) throw new Error('The subagents extension did not report the resumed run')
    linkResumedRun(agentId, runId, next)
    return { runId: next }
  },

  /** Move a running foreground (`async: false`) subagent call to the background. */
  async detachForeground(agentId: string, runId?: string): Promise<void> {
    await slash(agentId, 'subagents-detach', runId ?? '')
  },

  /**
   * Answer a supervisor request through the parent model (pi-subagents has no host reply API): a prompt when
   * idle, a steer while it is working.
   */
  async replyToSupervisor(
    agentId: string,
    request: SubagentSupervisorRequest,
    message: string
  ): Promise<void> {
    setRequestState(agentId, request.requestId, 'sending')
    try {
      await useAgents
        .getState()
        .prompt(agentId, supervisorReplyPrompt(request, message), { whileRunning: 'steer' })
      setRequestState(agentId, request.requestId, 'answered')
    } catch (error) {
      setRequestState(agentId, request.requestId, 'pending')
      throw error
    }
  },

  inspect(agentId: string, request: SubagentInspectRequest): Promise<SubagentInspectReply> {
    return invoke('engine:subagents-inspect', agentId, request)
  },

  /** Show a run's saved output file in the preview dialog. */
  async openOutput(path: string): Promise<void> {
    const { activeAgentId, agents } = useAgents.getState()
    const cwd = activeAgentId ? (agents[activeAgentId]?.info.cwd ?? '') : ''
    useSubagentUi.getState().setPreview({ path, cwd })
  },

  /** pi-subagents' own status text for a run (the detail's "Show raw status"). Needs the bridge. */
  async status(agentId: string, runId: string): Promise<string> {
    if (!(await canUseRpc(agentId))) throw new Error('Status needs the subagents extension')
    const data = await callRpc(agentId, 'status', { id: runId })
    return typeof data.text === 'string' ? data.text : JSON.stringify(data, null, 2)
  },

  /** pi-subagents' parent + child token and cost accounting (on settle and detail open; never on a timer). */
  async cost(agentId: string): Promise<RpcData | null> {
    if (!(await canUseRpc(agentId))) return null
    return callRpc(agentId, 'cost', {}).catch(() => null)
  }
}
