import type { EngineManager } from '../engine/manager'
import type { EngineId } from '@shared/api/engine'
import type { ConversationPromptStore } from '../features/sessions/conversation-prompts'

/** Shared services handed to every feature's IPC registration. */
export interface IpcContext {
  manager: EngineManager
  /** User override for the engine location (Settings → Engine), or null for auto-detect. */
  engineOverridePath: (engine?: EngineId) => string | null
  /** Each conversation's own instructions; only main writes them. */
  conversationPrompts: ConversationPromptStore
}
