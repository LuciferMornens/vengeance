import type { RpcCommand, RpcCommandOf, RpcCommandType, RpcResponseData } from '@shared/engine-types'
import { invoke } from './ipc'

export class RpcCommandError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message)
    this.name = 'RpcCommandError'
  }
}

/**
 * Send one RPC command to an agent's engine and return its typed `data`.
 * Throws RpcCommandError when the engine answers `success: false`.
 *
 *   const state = await rpc(agentId, { type: 'get_state' })
 */
export async function rpc<T extends RpcCommandType>(
  agentId: string,
  command: RpcCommandOf<T> & { id?: string }
): Promise<RpcResponseData<T>> {
  const response = await invoke('engine:command', agentId, command as RpcCommand)
  if (!response.success) throw new RpcCommandError(response.command, response.error)
  return (response as { data?: RpcResponseData<T> }).data as RpcResponseData<T>
}

let bashCounter = 0
/** Unique client-side command id (used to correlate `bash_execution_update` events). */
export function clientCommandId(): string {
  bashCounter += 1
  return `r-${Date.now().toString(36)}-${bashCounter}`
}
