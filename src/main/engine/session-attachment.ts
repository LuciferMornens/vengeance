import { normalizeEngineId, type AgentInfo, type CreateAgentArgs } from '@shared/api/engine'
import { samePath } from '../paths'

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
