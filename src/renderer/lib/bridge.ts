import type {
  BridgeCallOptions,
  BridgeOp,
  BridgeRequest,
  BridgeResultMap,
  BridgeToolsState,
  BridgeTreeResult,
  SubagentsRpcMethod,
  SubagentsRpcReply
} from '@shared/api/engine'
import type { SpeedMode, SpeedState } from '@shared/api/speed'
import { useAgents } from '../store/agents'
import { invoke } from './ipc'

/**
 * Client for the Vengeance bridge extension: engine features RPC has no command for. Check
 * `bridge.available(agentId)` first and fall back when it is false (bridge failed to load, mock off,
 * or an older engine): tree navigation → new session file, reload → engine restart.
 * Each call rejects with the engine's error message, or on timeout.
 */

function call<O extends BridgeOp>(
  agentId: string,
  request: Extract<BridgeRequest, { op: O }>,
  options?: BridgeCallOptions
): Promise<BridgeResultMap[O]> {
  // SAFETY: the main process answers `engine:bridge` with the result type of `request.op`.
  return invoke('engine:bridge', agentId, request, options) as Promise<BridgeResultMap[O]>
}

export interface NavigateTreeOptions extends BridgeCallOptions {
  /** Summarize the branch being left (model call; honour the `branchSummary.skipPrompt` setting in the UI). */
  summarize?: boolean
  customInstructions?: string
  replaceInstructions?: boolean
  label?: string
}

export const bridge = {
  /** The bridge is loaded in this agent's engine. */
  available(agentId: string): boolean {
    return useAgents.getState().agents[agentId]?.info.bridge === true
  },

  /**
   * Move the session leaf to `entryId` in place (same session file, like the TUI's /tree), then reload
   * the transcript. Selecting a user message returns its text as `editorText` for the composer.
   */
  async navigateTree(
    agentId: string,
    entryId: string,
    options: NavigateTreeOptions = {}
  ): Promise<BridgeTreeResult> {
    const { timeoutMs, ...rest } = options
    const result = await call(agentId, { op: 'tree', entryId, ...rest }, { timeoutMs })
    if (!result.cancelled) await useAgents.getState().refresh(agentId)
    return result
  },

  /** Reload extensions, skills, prompts, themes and context files in the running engine, then refresh. */
  async reload(agentId: string, options?: BridgeCallOptions): Promise<void> {
    await call(agentId, { op: 'reload' }, options)
    await useAgents.getState().refreshCapabilities(agentId)
  },

  /** Active tools (declared to the model) and every configured tool. */
  getTools(agentId: string, options?: BridgeCallOptions): Promise<BridgeToolsState> {
    return call(agentId, { op: 'tools-get' }, options)
  },

  /** Replace the active tool set (unknown and hidden names are ignored by the engine); returns the new state. */
  setTools(
    agentId: string,
    names: string[],
    options?: BridgeCallOptions
  ): Promise<BridgeToolsState> {
    return call(agentId, { op: 'tools-set', names }, options)
  },

  /** Set (or clear with undefined/empty) a label on a session entry. */
  async setLabel(
    agentId: string,
    entryId: string,
    label: string | undefined,
    options?: BridgeCallOptions
  ): Promise<void> {
    await call(agentId, { op: 'label', entryId, label }, options)
  },

  /** The session's response speed; with `mode`, request that speed first (Engine 2: natively). */
  speed(agentId: string, mode?: SpeedMode, options?: BridgeCallOptions): Promise<SpeedState> {
    return call(agentId, { op: 'speed', mode }, options)
  },

  /**
   * One pi-subagents event-bus RPC call (no transcript message, no model turn). Resolves with pi-subagents'
   * reply, including `success: false` errors (`timeout` when the extension is not installed).
   */
  subagents(
    agentId: string,
    method: SubagentsRpcMethod,
    params?: Record<string, unknown>,
    options?: BridgeCallOptions
  ): Promise<SubagentsRpcReply> {
    return call(agentId, { op: 'subagents', method, params }, options)
  }
}
