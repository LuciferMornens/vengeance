import type { BridgeRequest } from '@shared/api/engine'
import type { McpLiveAction } from '@shared/api/mcp'

/**
 * The MCP chip's switches: the Engine turns the server on or off in the running conversation and saves
 * that to mcp.json itself (Vengeance patch 0009). The saved change is already live, so the write is no
 * outside edit and offers no restart (SPEC §3.6): the config watcher passes over MCP changes while a
 * switch runs and a moment after.
 */

const SWITCHES = new Set<McpLiveAction>(['enable', 'disable', 'enable-project', 'disable-project'])

let running = 0
/** When the last switch settled: the OS can report its write a moment after the Engine replied. */
let lastSettledAt = 0

/** Whether the bridge request is a switch the Engine saves to mcp.json. */
export function savesMcpSwitch(request: BridgeRequest): boolean {
  return request.op === 'mcp' && request.action !== undefined && SWITCHES.has(request.action)
}

/** Run a switch, holding the config watcher's MCP changes until it settles. */
export async function whileEngineSavesMcp<T>(run: () => Promise<T>): Promise<T> {
  running++
  try {
    return await run()
  } finally {
    running--
    lastSettledAt = Date.now()
  }
}

/** True while a switch runs or settled less than `withinMs` ago. */
export function engineSavedMcp(withinMs: number): boolean {
  return running > 0 || Date.now() - lastSettledAt < withinMs
}
