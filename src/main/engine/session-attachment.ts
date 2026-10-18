import { isAbsolute, resolve } from 'node:path'
import { normalizeEngineId, type AgentInfo, type CreateAgentArgs } from '@shared/api/engine'
import type { RpcResponse } from '@shared/engine-types'
import { samePath } from '../paths'

// Native sessionDir settings can make reported paths relative to the engine's workspace.
export function absoluteSessionFile(
  sessionFile: string | undefined,
  cwd: string
): string | undefined {
  return sessionFile && !isAbsolute(sessionFile) ? resolve(cwd, sessionFile) : sessionFile
}

export function withAbsoluteSessionFile(response: RpcResponse, cwd: string): RpcResponse {
  if (!response.success) return response
  if (response.command === 'get_state') {
    return {
      ...response,
      data: { ...response.data, sessionFile: absoluteSessionFile(response.data.sessionFile, cwd) }
    }
  }
  if (response.command === 'get_session_stats') {
    return {
      ...response,
      data: { ...response.data, sessionFile: absoluteSessionFile(response.data.sessionFile, cwd) }
    }
  }
  return response
}

export function prepareEngineAttachment(
  args: CreateAgentArgs,
  agents: Iterable<{ info: AgentInfo; hidden?: boolean }>,
  hidden: boolean
): CreateAgentArgs {
  if (hidden || args.forkFrom) return args
  const engine = normalizeEngineId(args.engine)
  for (const agent of agents) {
    if (agent.hidden || agent.info.engine !== engine) continue
    const current = agent.info
    const currentPath = current.sessionFile || current.args.sessionPath
    const sameNativeId =
      !!args.nativeAgentId &&
      (current.nativeAgentId ?? current.args.nativeAgentId) === args.nativeAgentId
    if (args.sessionPath && currentPath) {
      if (samePath(currentPath, args.sessionPath)) {
        throw new Error('This session is already open in Vengeance.')
      }
    } else if (sameNativeId) {
      throw new Error('This session is already open in Vengeance.')
    }
  }
  // Native IDs are daemon-scoped; a fresh saved-file attachment resolves its concrete path.
  return engine === 'prime' && args.sessionPath && args.nativeAgentId
    ? { ...args, nativeAgentId: undefined }
    : args
}
