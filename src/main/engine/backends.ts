import { ENGINE_LABELS, type EngineCapabilities, type EngineDescriptor } from '@shared/api/engine'
import { PRIME_CAPABILITIES } from './prime/capabilities'

export const PI_CAPABILITIES: EngineCapabilities = {
  settings: true,
  providers: true,
  customModels: true,
  packages: true,
  resources: true,
  mcp: true,
  instructions: true,
  trust: true,
  keybindings: true,
  updates: true,
  launchOptions: true,
  extensionUi: true,
  subagents: true,
  sessions: {
    fork: true,
    clone: true,
    tree: true,
    labels: true,
    exportHtml: true,
    exportJsonl: true,
    import: true,
    share: true
  },
  commands: [
    'prompt',
    'steer',
    'follow_up',
    'abort',
    'clear_queue',
    'new_session',
    'get_state',
    'set_model',
    'cycle_model',
    'get_available_models',
    'set_thinking_level',
    'cycle_thinking_level',
    'get_available_thinking_levels',
    'set_steering_mode',
    'set_follow_up_mode',
    'compact',
    'set_auto_compaction',
    'set_auto_retry',
    'abort_retry',
    'bash',
    'abort_bash',
    'get_session_stats',
    'export_html',
    'switch_session',
    'fork',
    'clone',
    'get_fork_messages',
    'get_entries',
    'get_tree',
    'get_last_assistant_text',
    'set_session_name',
    'get_messages',
    'get_commands'
  ]
}

export function engineBackends(): EngineDescriptor[] {
  return [
    { id: 'pi', label: ENGINE_LABELS.pi, capabilities: PI_CAPABILITIES },
    { id: 'prime', label: ENGINE_LABELS.prime, capabilities: PRIME_CAPABILITIES }
  ]
}
