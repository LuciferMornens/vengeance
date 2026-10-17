import {
  Brain,
  Bug,
  Copy,
  CopyPlus,
  Cpu,
  FileDown,
  FileUp,
  GitBranch,
  GitFork,
  Info,
  Keyboard,
  Layers,
  LogIn,
  LogOut,
  Pencil,
  Power,
  RefreshCw,
  ScrollText,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Undo2,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { EngineCapabilities, EngineId } from '@shared/api/engine'
import type { RpcCommandType, ThinkingLevel } from '@shared/engine-types'
import type { SettingsSectionId } from '@shared/api/settings-schema'
import { hasAction, runAction } from '../../lib/actions'
import { invoke } from '../../lib/ipc'
import { shortcutText } from '../../lib/keybindings'
import { useAgents } from '../../store/agents'
import { toast } from '../../ui'
import { openSettingsSection, revealSetting } from '../palette/settings-sections'
import { engineDescriptor, supportsEngineCommand } from '../engines/registry'
import { openPalette, openShortcutsSheet } from '../palette/store'
import { renameSession, targetForAgent } from '../sessions/actions'
import {
  importSessionCommand,
  newSessionCommand,
  resumeSessionCommand
} from '../sessions/session-commands'
import {
  compactContext,
  copyLastAssistantText,
  exportSessionTo,
  reloadAgent,
  setModelBySpec,
  setThinkingLevel
} from './operations'
import { openSessionInfo } from './session-info'
import { PRIME_COMMANDS } from './prime-commands'
import { runFastCommand } from './speed'

/**
 * pi's built-in TUI slash commands (slash-commands.md) mapped to GUI behavior. The engine's RPC `prompt`
 * does not understand these, so the composer intercepts them before sending. Commands owned by other
 * features run their registered action ids; a missing id shows a friendly toast instead of failing.
 */
export interface BuiltinCommand {
  name: string
  description: string
  /** Argument hint shown after the name: `<required>` or `[optional]` (prompt-templates.md convention). */
  args?: string
  icon: LucideIcon
  /** Runs through the Vengeance bridge: not offered to a session without it. */
  needsBridge?: boolean
  run(agentId: string, args: string): void | Promise<void>
}

/** Run an app action registered by another feature; tell the user when it is not available. */
function action(id: string, label: string): () => void {
  return () => {
    if (hasAction(id)) runAction(id)
    else toast({ level: 'info', title: `${label} isn’t available in this build`, duration: 2600 })
  }
}

function settings(section: SettingsSectionId, key?: string): BuiltinCommand['run'] {
  return (agentId) => {
    const engine = useAgents.getState().agents[agentId]?.info.engine ?? 'pi'
    if (key) revealSetting(section, key, engine)
    else openSettingsSection(section, engine)
  }
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  // Models and settings
  { name: 'settings', description: 'Open settings', icon: Settings, run: settings('general') },
  {
    name: 'model',
    args: '[provider/model][:thinking]',
    description: 'Switch model, optionally with a thinking level',
    icon: Cpu,
    run: (id, args) => (args ? setModelBySpec(id, args) : openPalette('models'))
  },
  {
    name: 'thinking',
    args: '[level]',
    description: 'Set the thinking level',
    icon: Brain,
    run: (id, args) => {
      if (!args) return openPalette('thinking')
      const levels = useAgents.getState().agents[id]?.thinkingLevels ?? []
      const wanted = args
        .trim()
        .toLowerCase()
        .replace(/^extra[\s-]?high$/, 'xhigh')
      const level = levels.find((l) => l === wanted)
      if (level) return setThinkingLevel(id, level as ThinkingLevel)
      toast({
        level: 'warning',
        title: `Unknown thinking level “${args}”`,
        description: levels.length ? `Available: ${levels.join(', ')}` : undefined
      })
    }
  },
  {
    name: 'fast',
    args: '[on|off|ultrafast]',
    description: 'Turn Fast mode on or off for faster, pricier responses',
    icon: Zap,
    needsBridge: true,
    run: runFastCommand
  },
  {
    name: 'scoped-models',
    description: `Choose the models ${shortcutText('mod+p')} cycles through`,
    icon: SlidersHorizontal,
    run: settings('models', 'enabledModels')
  },
  {
    name: 'login',
    args: '[provider]',
    description: 'Sign in to a provider',
    icon: LogIn,
    run: (agentId, args) =>
      settings(
        'providers',
        args ? `provider.${args.trim().toLowerCase().replace(/\s+/g, '-')}` : undefined
      )(agentId, '')
  },
  {
    name: 'logout',
    description: 'Remove provider authentication',
    icon: LogOut,
    run: settings('providers')
  },
  // Sessions and context
  {
    name: 'new',
    args: '[name]',
    description: 'Start a new session',
    icon: SquarePen,
    run: newSessionCommand
  },
  {
    name: 'resume',
    args: '[session]',
    description: 'Switch to another saved session',
    icon: Undo2,
    run: resumeSessionCommand
  },
  {
    name: 'name',
    args: '[name]',
    description: 'Rename the session',
    icon: Pencil,
    run: (id, args) => {
      const target = targetForAgent(id)
      if (args && target) return renameSession(target, args)
      action('session.rename', 'Rename')()
    }
  },
  {
    name: 'session',
    description: 'Show session information and statistics',
    icon: Info,
    run: (id) => openSessionInfo(id)
  },
  {
    name: 'tree',
    description: 'Navigate the session tree',
    icon: GitBranch,
    run: action('session.tree', 'Session tree')
  },
  {
    name: 'fork',
    description: 'Fork from an earlier user message',
    icon: GitFork,
    run: action('session.fork', 'Fork')
  },
  {
    name: 'clone',
    description: 'Duplicate the session at its current position',
    icon: CopyPlus,
    run: action('session.clone', 'Clone')
  },
  {
    name: 'compact',
    args: '[instructions]',
    description: 'Compact the context, optionally with custom instructions',
    icon: Layers,
    run: (id, args) => compactContext(id, args)
  },
  {
    name: 'import',
    args: '[path]',
    description: 'Import and resume a session file',
    icon: FileUp,
    run: importSessionCommand
  },
  // Export and share
  {
    name: 'copy',
    description: 'Copy the last assistant message',
    icon: Copy,
    run: (id) => copyLastAssistantText(id)
  },
  {
    name: 'export',
    args: '[path.html|path.jsonl]',
    description: 'Export the session as HTML or JSONL',
    icon: FileDown,
    run: (id, args) => (args ? exportSessionTo(id, args) : action('session.export', 'Export')())
  },
  {
    name: 'share',
    description: 'Share the session with a private link',
    icon: Share2,
    run: action('session.share', 'Share')
  },
  // Runtime and project
  {
    name: 'trust',
    description: 'Decide whether this project’s resources load',
    icon: ShieldCheck,
    run: action('workspace.trust', 'Project trust')
  },
  {
    name: 'reload',
    description: 'Reload extensions, skills, prompts and context files',
    icon: RefreshCw,
    run: (id) => reloadAgent(id)
  },
  {
    name: 'hotkeys',
    description: 'Show keyboard shortcuts',
    icon: Keyboard,
    run: () => openShortcutsSheet()
  },
  {
    name: 'bug',
    args: '[description]',
    description: 'Report a bug to the Engine developers (from its terminal)',
    icon: Bug,
    run: (_id, args) => reportEngineBug(args)
  },
  {
    name: 'changelog',
    description: 'What’s new in the engine',
    icon: ScrollText,
    run: action('app.changelog', 'Changelog')
  },
  { name: 'quit', description: 'Quit Vengeance', icon: Power, run: () => void invoke('win:close') }
]

/**
 * The Engine's `/bug` is a terminal flow (consent questions, then an upload to its developers or a zip) with no RPC
 * command, so the app explains where to run it and copies the command with the description.
 */
function reportEngineBug(description: string): void {
  const command = description ? `/bug ${description}` : '/bug'
  toast({
    level: 'info',
    title: 'Bug reports are sent from the Engine\u2019s terminal',
    description:
      'Run /bug there: it collects diagnostics and asks before including this conversation.',
    duration: 9000,
    action: { label: 'Copy command', onClick: () => void navigator.clipboard.writeText(command) }
  })
}

const REQUIRED_COMMANDS: Partial<Record<string, RpcCommandType>> = {
  model: 'set_model',
  thinking: 'set_thinking_level',
  effort: 'set_thinking_level',
  name: 'set_session_name',
  session: 'get_session_stats',
  compact: 'compact',
  copy: 'get_last_assistant_text'
}

function supportsBuiltinCapability(name: string, capabilities: EngineCapabilities): boolean {
  switch (name) {
    case 'login':
    case 'logout':
      return capabilities.providers
    case 'scoped-models':
      return capabilities.settings
    case 'trust':
      return capabilities.trust
    case 'fork':
      return capabilities.sessions.fork
    case 'clone':
      return capabilities.sessions.clone
    case 'tree':
      return capabilities.sessions.tree
    case 'import':
      return capabilities.sessions.import
    case 'export':
      return capabilities.sessions.exportHtml || capabilities.sessions.exportJsonl
    case 'share':
      return capabilities.sessions.share
    case 'mcp':
      return capabilities.mcp
    case 'subagents':
      return capabilities.subagents
    case 'plugins':
      return capabilities.mcp
    case 'update':
    case 'nightly':
      return capabilities.updates
    default:
      return true
  }
}

export function isBuiltinAvailable(command: BuiltinCommand, engine: EngineId): boolean {
  if (engine === 'prime' && ['bug', 'changelog'].includes(command.name)) return false
  const canonical =
    engine === 'prime' ? (PRIME_ALIASES[command.name] ?? command.name) : command.name
  const required = REQUIRED_COMMANDS[canonical]
  if (required && !supportsEngineCommand(engine, required)) return false
  const capabilities = engineDescriptor(engine)?.capabilities
  return capabilities ? supportsBuiltinCapability(canonical, capabilities) : engine === 'pi'
}

/** The built-ins offered to a session of `engine`; `bridge`: the session has the Vengeance bridge. */
export function availableBuiltins(engine: EngineId, bridge: boolean): BuiltinCommand[] {
  const overrides = new Set(PRIME_COMMANDS.map((command) => command.name))
  const commands =
    engine === 'prime'
      ? [...BUILTIN_COMMANDS.filter((command) => !overrides.has(command.name)), ...PRIME_COMMANDS]
      : BUILTIN_COMMANDS
  const aliases =
    engine === 'prime'
      ? Object.keys(PRIME_ALIASES).flatMap((name) => findBuiltin(name, engine) ?? [])
      : []
  return [...commands, ...aliases]
    .filter((command) => isBuiltinAvailable(command, engine) && (bridge || !command.needsBridge))
    .map((command) => (engine === 'prime' ? primeArgs(command) : command))
}

/** Engine 2's `/new` accepts a session name. */
function primeArgs(command: BuiltinCommand): BuiltinCommand {
  if (command.name === 'new') return { ...command, args: '[--name "session name" --] [prompt]' }
  return command
}

const PRIME_ALIASES: Record<string, string> = { clear: 'new', rename: 'name' }

export function findBuiltin(name: string, engine: EngineId = 'pi'): BuiltinCommand | undefined {
  const canonical = engine === 'prime' ? (PRIME_ALIASES[name] ?? name) : name
  const command =
    (engine === 'prime' ? PRIME_COMMANDS.find((item) => item.name === canonical) : undefined) ??
    BUILTIN_COMMANDS.find((item) => item.name === canonical)
  if (!command) return undefined
  if (engine === 'prime' && name === 'clear')
    return {
      ...command,
      name,
      args: undefined,
      run: (agentId, text) => {
        if (!text) return newSessionCommand(agentId, '')
        toast({
          level: 'warning',
          title: 'Use /clear without arguments',
          description: 'Use /new to supply a name or initial prompt.'
        })
      }
    }
  if (canonical !== name) return { ...command, name }
  return engine === 'prime' ? primeArgs(command) : command
}

/** Parse `/name args…` into a built-in command invocation, if the name is one. */
export function matchBuiltin(
  text: string,
  engine: EngineId = 'pi'
): { command: BuiltinCommand; args: string } | null {
  const match = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const command = findBuiltin(match[1]!, engine)
  return command ? { command, args: (match[2] ?? '').trim() } : null
}
