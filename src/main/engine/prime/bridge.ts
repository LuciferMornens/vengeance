import type { BridgeRequest, BridgeResult, BridgeToolsState } from '@shared/api/engine'
import type { McpLiveStatus } from '@shared/api/mcp'
import type { SpeedMode, SpeedState } from '@shared/api/speed'
import {
  PRIME_MCP_READ_TIMEOUT_MS,
  PRIME_MCP_RECONNECT_TIMEOUT_MS,
  primeKernelIds,
  primeLiveMcpStatus,
  type PrimeMcpTimeouts
} from './mcp-live'
import { PrimeCommandError, stringValue, type PrimeRecord } from './transport'

type NativeCommand = (type: string, payload?: PrimeRecord) => Promise<PrimeRecord>

export async function callPrimeBridge(
  request: BridgeRequest,
  nativeCommand: NativeCommand,
  toolState: () => Promise<BridgeToolsState>,
  readSpeed: (mode?: SpeedMode) => Promise<SpeedState>,
  mcpTimeouts: PrimeMcpTimeouts
): Promise<BridgeResult> {
  switch (request.op) {
    case 'tree': {
      const result = await nativeCommand('navigate_tree', {
        targetId: request.entryId,
        summarize: request.summarize,
        customInstructions: request.customInstructions,
        replaceInstructions: request.replaceInstructions,
        label: request.label
      })
      const state = await nativeCommand('get_state')
      return {
        cancelled: result.cancelled === true,
        leafId: stringValue(result.leafId) ?? stringValue(state.leafId) ?? null,
        editorText: stringValue(result.editorText) ?? stringValue(result.selectedText)
      }
    }
    case 'label':
      await nativeCommand('set_session_entry_label', {
        entryId: request.entryId,
        label: request.label ?? null
      })
      return null
    case 'reload':
      await nativeCommand('reload')
      return null
    case 'tools-get':
      return toolState()
    case 'tools-set': {
      const state = await toolState()
      if (
        request.names.length !== state.active.length ||
        request.names.some((name) => !state.active.includes(name))
      ) {
        throw new Error(
          'Engine 2 manages its core tools. Configure skills and connections in settings.'
        )
      }
      return state
    }
    case 'subagents':
      if (request.method === 'status' || request.method === 'ping') {
        return { success: true, data: await nativeCommand('get_rlm_children') }
      }
      return {
        success: false,
        error: {
          code: 'unavailable',
          message: 'Use the native agent controls for this operation.'
        }
      }
    case 'speed':
      return readSpeed(request.mode)
    case 'system-prompt': {
      const response = await nativeCommand('get_system_prompt')
      if (typeof response.systemPrompt !== 'string') {
        throw new Error('Engine 2 did not return its active system instructions')
      }
      return { text: response.systemPrompt }
    }
    case 'mcp':
      return primeMcp(request, nativeCommand, mcpTimeouts)
    case 'sign-ins':
      // Main sends it to the Engine only: Engine 2 reads its sign-ins again at every lookup.
      return null
  }
}

/** Patch 0024's refusal of a name the conversation's kernel does not run. */
const NOT_IN_SESSION = /is not enabled in this session$/

/**
 * Reconnect one row of the status in the kernel: every connection it stands for, so each account
 * of a catalog service. Names the conversation does not run are skipped. Each connection gets the
 * longer bound to open, so a server that starts slowly can finish once and stays open.
 */
async function reconnectPrimeServer(
  server: string,
  nativeCommand: NativeCommand,
  timeouts: PrimeMcpTimeouts
): Promise<void> {
  const ids = primeKernelIds(await nativeCommand('get_mcp_connections'), server)
  timeouts.forget(ids)
  const replies = await Promise.allSettled(
    ids.map((id) =>
      nativeCommand('reconnect_mcp_server', {
        server: id,
        timeoutMs: PRIME_MCP_RECONNECT_TIMEOUT_MS
      })
    )
  )
  const answered: PrimeRecord[] = []
  for (const reply of replies) {
    if (reply.status === 'fulfilled') answered.push(reply.value)
    else if (!(reply.reason instanceof Error && NOT_IN_SESSION.test(reply.reason.message))) {
      throw reply.reason
    }
  }
  // A reconnect lists its server: one that did not answer reads as failed if the next read agrees.
  for (const reply of answered) timeouts.settle(reply)
  // Patch 0024 never starts a kernel for a reconnect: without one it answers and changes nothing.
  if (answered.some((reply) => reply.kernelRunning === false)) {
    throw new Error(
      'Engine 2 has not started this conversation’s Python runtime yet, so there is no connection to reconnect. It opens MCP servers when it starts.'
    )
  }
  if (answered.length === 0) {
    throw new Error(
      `This conversation does not run ${server}, so there is no connection to reconnect.`
    )
  }
}

/** The conversation's MCP status, after running the requested action first. */
export async function primeMcp(
  request: Extract<BridgeRequest, { op: 'mcp' }>,
  nativeCommand: NativeCommand,
  timeouts: PrimeMcpTimeouts
): Promise<McpLiveStatus> {
  if (request.action) {
    if (!request.server) throw new Error('Choose the MCP server to change')
    if (request.action === 'reconnect') {
      await reconnectPrimeServer(request.server, nativeCommand, timeouts)
    } else if (request.action === 'logout') {
      await nativeCommand('remove_mcp_connection', { server: request.server })
    } else {
      throw new Error(
        'Engine 2 turns MCP servers on or off in Settings; open conversations pick it up after a restart.'
      )
    }
  }
  const connections = await nativeCommand('get_mcp_connections')
  const live = await nativeCommand('get_mcp_status', {
    timeoutMs: PRIME_MCP_READ_TIMEOUT_MS
  }).catch((error: unknown) => {
    // Builds without live status (before patch 0024) report configured states only. Any other
    // failure is the running kernel's listing: configured states would misreport it as not started.
    if (error instanceof PrimeCommandError && error.message.startsWith('Unknown daemon command')) {
      return null
    }
    throw error
  })
  return primeLiveMcpStatus(connections, live, timeouts.settle(live))
}
