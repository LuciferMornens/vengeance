import { Brain, Copy, Cpu, Info, Layers, RefreshCw } from 'lucide-react'
import type { AppAction } from '../../lib/actions'
import type { RpcCommandType } from '@shared/engine-types'
import { platform } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import {
  activeAgentId,
  compactContext,
  copyLastAssistantText,
  cycleModel,
  cycleModelBackward,
  cycleThinkingLevel,
  reloadAgent,
  supportsAgentCommand
} from './operations'
import { openSessionInfo } from './session-info'

function withActiveAgent(run: (agentId: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const id = activeAgentId()
    if (id) await run(id)
  }
}

const hasReadyAgent = (): boolean => {
  const { activeAgentId: id, agents } = useAgents.getState()
  return !!id && agents[id]?.status === 'ready'
}

const hasReadyCommand = (command: RpcCommandType) => (): boolean => {
  const agentId = activeAgentId()
  return hasReadyAgent() && !!agentId && supportsAgentCommand(agentId, command)
}

/** The Engine's `app.model.cycleBackward` key: Alt+P on Windows (where terminals swallow Shift+Ctrl+P). */
export const CYCLE_MODEL_BACKWARD_HOTKEY = platform.os === 'win32' ? 'alt+p' : 'mod+shift+p'

const hasIdleAgent = (): boolean =>
  hasReadyAgent() && useAgents.getState().agents[activeAgentId()!]?.phase === 'idle'

/**
 * Palette actions backed by composer operations (compact, copy, cycle model/thinking, reload, session info).
 * Registered as fallbacks by the palette: another feature registering the same id takes precedence.
 * Session export belongs to the sessions feature (`session.export`).
 */
export const COMPOSER_ACTIONS: AppAction[] = [
  {
    id: 'session.compact',
    title: 'Compact context',
    group: 'Session',
    keywords: ['summarize', 'context', 'tokens', '/compact'],
    icon: Layers,
    when: hasReadyCommand('compact'),
    run: withActiveAgent((id) => compactContext(id))
  },
  // Ctrl+X: pi's app.message.copy (keybindings.md); only when nothing is selected, so cut keeps working.
  {
    id: 'session.copyLast',
    title: 'Copy last response',
    group: 'Session',
    hotkey: 'mod+x',
    keywords: ['clipboard', 'assistant', '/copy'],
    icon: Copy,
    when: hasReadyCommand('get_last_assistant_text'),
    run: withActiveAgent(copyLastAssistantText)
  },
  {
    id: 'session.info',
    title: 'Session info',
    group: 'Session',
    keywords: ['statistics', 'tokens', 'cost', 'file', '/session'],
    icon: Info,
    when: hasReadyCommand('get_session_stats'),
    run: withActiveAgent(openSessionInfo)
  },
  {
    id: 'engine.reload',
    title: 'Reload extensions and resources',
    group: 'Session',
    keywords: ['reload', 'restart', 'extensions', 'skills', 'prompts', 'context files', '/reload'],
    icon: RefreshCw,
    when: hasIdleAgent,
    run: withActiveAgent(reloadAgent)
  },
  {
    id: 'model.cycle',
    title: 'Cycle model',
    group: 'Model',
    hotkey: 'mod+p',
    keywords: ['next model', 'switch'],
    icon: Cpu,
    when: hasReadyCommand('cycle_model'),
    run: withActiveAgent(cycleModel)
  },
  {
    id: 'model.cycleBackward',
    title: 'Cycle model backward',
    group: 'Model',
    hotkey: CYCLE_MODEL_BACKWARD_HOTKEY,
    keywords: ['previous model', 'switch'],
    icon: Cpu,
    when: hasReadyCommand('set_model'),
    run: withActiveAgent(cycleModelBackward)
  },
  {
    id: 'thinking.cycle',
    title: 'Cycle thinking level',
    group: 'Model',
    hotkey: 'shift+tab',
    keywords: ['reasoning', 'effort'],
    icon: Brain,
    when: hasReadyCommand('cycle_thinking_level'),
    run: withActiveAgent(cycleThinkingLevel)
  }
]
