import { useMemo, type ReactNode } from 'react'
import {
  Brain,
  ChevronRight,
  Cpu,
  FolderGit2,
  FolderOpen,
  MessageSquare,
  Puzzle,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { ENGINE_LABELS, type EngineId } from '@shared/api/engine'
import { SETTINGS } from '@shared/api/settings-schema'
import type { RpcSlashCommand } from '@shared/engine-types'
import type { AppAction } from '../../lib/actions'
import { basename } from '../../lib/format'
import { useAgents } from '../../store/agents'
import { selectWorkspaceEngine, useApp } from '../../store/app'
import { useShownWorkspaces } from '../../store/shown-workspaces'
import { toast } from '../../ui'
import { setDraftText } from '../composer'
import { isBuiltinAvailable } from '../composer/builtins'
import { activeAgentId } from '../composer/operations'
import { PRIME_COMMANDS } from '../composer/prime-commands'
import { findSpeedOption, formatSpeedPrice, toggleFastMode } from '../composer/speed'
import { engineScope, useOfferedCommands } from '../composer/suggestions'
import { THINKING_LABELS } from '../composer/thinking-pill'
import { supportsEngineCommand, useEngineCapabilities } from '../engines/registry'
import { PRIME_SETTINGS_GROUPS } from '../engines/prime-schema'
import { agentTitle } from '../sessions/model'
import { openWorkspace } from '../shell/workspace'
import {
  openSettingsSection,
  revealSetting,
  SETTINGS_SECTIONS,
  sectionLabel,
  settingsSectionAvailable
} from './settings-sections'
import type { PalettePage } from './store'

const SUPERSEDED_ACTIONS = new Set([
  'settings.providers',
  'settings.packages',
  'settings.shortcuts'
])
const NO_COMMANDS: RpcSlashCommand[] = []
const COMMAND_ICON: Record<RpcSlashCommand['source'], LucideIcon> = {
  extension: Puzzle,
  prompt: ScrollText,
  skill: Sparkles
}

export interface PaletteEntry {
  id: string
  group: string
  title: string
  subtitle?: string
  icon: ReactNode
  keywords?: string[]
  hotkey?: string
  trailing?: ReactNode
  /** Navigates to a nested page instead of closing. */
  page?: PalettePage
  /** Extension command that can also run with arguments (Tab). */
  command?: RpcSlashCommand
  /** Technical id (a settings.json key), shown faintly only while the query is typed like one. */
  technical?: string
  run?: () => void
}

export function runCommand(command: RpcSlashCommand, args = ''): void {
  const id = activeAgentId()
  if (!id) return
  const text = `/${command.name}${args.trim() ? ` ${args.trim()}` : ''}`
  // Extension commands run right away; templates and skills go to the composer for arguments.
  if (command.source === 'extension')
    void useAgents
      .getState()
      .prompt(id, text)
      .catch((error: Error) =>
        toast({ level: 'error', title: 'Command failed', description: error.message })
      )
  else setDraftText(id, `${text} `)
}

/**
 * Root entries, built once per open. Agents are read through a key of the fields the palette shows, so a
 * streaming agent (one store update per frame) does not rebuild the list.
 */
export function useRootEntries(actions: AppAction[]): PaletteEntry[] {
  const activeId = useAgents((s) => s.activeAgentId)
  const allCommands = useAgents((s) => (activeId ? s.agents[activeId]?.commands : undefined))
  const activeCwd = useAgents((s) => (activeId ? (s.agents[activeId]?.info.cwd ?? null) : null))
  const workspaceEngine = useApp((state) =>
    selectWorkspaceEngine(state, state.prefs.activeWorkspace)
  )
  const sessionEngine = useAgents((state) =>
    activeId ? state.agents[activeId]?.info.engine : undefined
  )
  const engine = sessionEngine ?? workspaceEngine
  const capabilities = useEngineCapabilities(engine)
  const settingsCapabilities = useEngineCapabilities(workspaceEngine)
  const commands = useOfferedCommands(allCommands ?? NO_COMMANDS, activeCwd, engine)
  const modelName = useAgents((s) => (activeId ? s.agents[activeId]?.model?.name : undefined))
  const thinkingLevel = useAgents((s) => (activeId ? s.agents[activeId]?.thinkingLevel : undefined))
  // Primitives: the session's speed is republished after every response.
  const fastOffered = useAgents((s) => {
    const speed = activeId ? s.agents[activeId]?.speed : undefined
    return !!speed && !!findSpeedOption(speed, 'fast')
  })
  const fastPrice = useAgents((s) => {
    const speed = activeId ? s.agents[activeId]?.speed : undefined
    return speed && formatSpeedPrice(findSpeedOption(speed, 'fast'))
  })
  const fasterOn = useAgents((s) => {
    const effective = activeId ? s.agents[activeId]?.speed?.effective : undefined
    return !!effective && effective !== 'standard'
  })
  const sessionsKey = useAgents((s) =>
    s.order
      .map((id) => {
        const a = s.agents[id]
        return a
          ? `${id}\u0001${agentTitle(a)}\u0001${a.phase}\u0001${a.ext.dialogs.length}\u0001${a.info.engine}`
          : id
      })
      .join('\u0000')
  )
  const workspaces = useShownWorkspaces()
  const activeWorkspace = useApp((s) => s.prefs.activeWorkspace)

  return useMemo(() => {
    const entries: PaletteEntry[] = []
    for (const action of actions) {
      if (SUPERSEDED_ACTIONS.has(action.id) || (action.when && !action.when())) continue
      const Icon = action.icon
      entries.push({
        id: `action:${action.id}`,
        group: action.group,
        title: action.title,
        icon: Icon ? <Icon /> : <ChevronRight />,
        keywords: action.keywords,
        hotkey: action.hotkey,
        run: () => {
          if (action.id.startsWith('settings.')) {
            useApp.getState().openSettings(undefined, workspaceEngine)
          }
          void action.run()
        }
      })
    }
    if (activeId) {
      if (supportsEngineCommand(engine, 'set_model'))
        entries.push({
          id: 'page:models',
          group: 'Model',
          title: 'Change model',
          subtitle: modelName,
          icon: <Cpu />,
          keywords: ['switch model', 'provider', '/model'],
          hotkey: 'mod+l',
          page: 'models'
        })
      if (supportsEngineCommand(engine, 'set_thinking_level'))
        entries.push({
          id: 'page:thinking',
          group: 'Model',
          title: 'Thinking level',
          subtitle: thinkingLevel ? THINKING_LABELS[thinkingLevel] : undefined,
          icon: <Brain />,
          keywords: ['reasoning', 'effort', '/thinking'],
          page: 'thinking'
        })
      if (fastOffered)
        entries.push({
          id: 'speed:fast',
          group: 'Model',
          title: fasterOn ? 'Turn off Fast mode' : 'Turn on Fast mode',
          subtitle: fasterOn ? undefined : fastPrice,
          icon: <Zap />,
          // Not "speed": Engine 2's /speed is the token speed readout.
          keywords: ['faster responses', 'priority', 'service tier', 'ultrafast', '/fast'],
          run: () => void toggleFastMode(activeId)
        })
      if (engine === 'prime') {
        for (const command of PRIME_COMMANDS) {
          if (!isBuiltinAvailable(command, engine)) continue
          const Icon = command.icon
          entries.push({
            id: `native:${command.name}`,
            group: 'Commands',
            title: `/${command.name}`,
            subtitle: command.description,
            icon: <Icon />,
            keywords: [ENGINE_LABELS[engine], command.name],
            run: () => void command.run(activeId, '')
          })
        }
      }
      for (const command of commands) {
        const Icon = COMMAND_ICON[command.source]
        const extension = command.source === 'extension'
        entries.push({
          id: `command:${command.source}:${command.name}`,
          group: 'Commands',
          title: `/${command.name}`,
          subtitle: command.description,
          icon: <Icon />,
          keywords: [command.source, command.sourceInfo.source, engineScope(command)?.label ?? ''],
          trailing: <span className="text-2xs text-fg-3">{extension ? 'Run' : 'Insert'}</span>,
          command: extension ? command : undefined,
          run: () => runCommand(command)
        })
      }
    }
    const { agents, order } = useAgents.getState()
    for (const id of order) {
      const agent = agents[id]
      if (!agent) continue
      const current = id === activeId
      entries.push({
        id: `session:${id}`,
        group: 'Open sessions',
        title: agentTitle(agent),
        subtitle: `${basename(agent.info.cwd)} · ${ENGINE_LABELS[agent.info.engine]}`,
        icon:
          agent.phase === 'running' ? (
            <span className="size-2 animate-[v-pulse_1.6s_ease-in-out_3] rounded-full bg-accent" />
          ) : (
            <MessageSquare />
          ),
        keywords: ['session', 'switch'],
        trailing: current ? (
          <span className="text-2xs text-fg-3">Current</span>
        ) : agent.ext.dialogs.length > 0 ? (
          <span className="text-2xs font-medium text-warning">Needs input</span>
        ) : undefined,
        run: () => useAgents.getState().setActive(id)
      })
    }
    for (const section of SETTINGS_SECTIONS) {
      if (!settingsSectionAvailable(section.id, settingsCapabilities)) continue
      const Icon = section.icon
      entries.push({
        id: `settings:${section.id}`,
        group: 'Settings',
        title: section.id === 'engine' ? ENGINE_LABELS[workspaceEngine] : section.title,
        icon: <Icon />,
        keywords: ['settings', 'preferences', ...section.keywords],
        run: () => openSettingsSection(section.id, workspaceEngine)
      })
    }
    for (const workspace of workspaces) {
      entries.push({
        id: `workspace:${workspace.path}`,
        group: 'Workspaces',
        title: workspace.name || basename(workspace.path),
        subtitle: workspace.path,
        icon: workspace.path === activeWorkspace ? <FolderOpen /> : <FolderGit2 />,
        keywords: ['workspace', 'project', 'folder'],
        run: () => void openWorkspace(workspace.path)
      })
    }
    return entries
    // sessionsKey stands in for the agent fields read through getState() above.
  }, [
    actions,
    activeId,
    commands,
    modelName,
    thinkingLevel,
    fastOffered,
    fastPrice,
    fasterOn,
    sessionsKey,
    workspaces,
    activeWorkspace,
    engine,
    capabilities,
    workspaceEngine,
    settingsCapabilities
  ])
}

/** Individual engine settings (searched by label, key and description); open the section and pulse the row. */
const SETTING_ENTRIES: PaletteEntry[] = SETTINGS.map((def) => ({
  id: `setting:${def.key}`,
  group: 'Settings',
  title: def.label,
  subtitle: `${sectionLabel(def.section)} · ${def.group}`,
  icon: <SlidersHorizontal />,
  keywords: [def.key, ...(def.alsoKeys ?? []), def.description, ...(def.keywords ?? [])],
  technical: def.key,
  run: () => revealSetting(def.section, def.key, 'pi')
}))

const PRIME_SETTING_ENTRIES: PaletteEntry[] = PRIME_SETTINGS_GROUPS.flatMap((group) =>
  group.fields.map((field) => ({
    id: `prime-setting:${field.key}`,
    group: 'Settings',
    title: field.label,
    subtitle: `${sectionLabel(group.section)} · ${group.title}`,
    icon: <SlidersHorizontal />,
    keywords: [field.key, field.description ?? '', 'Engine 2'],
    technical: field.key,
    run: () => revealSetting(group.section, field.key, 'prime')
  }))
)

export function settingsEntries(engine: EngineId): PaletteEntry[] {
  return engine === 'prime' ? PRIME_SETTING_ENTRIES : SETTING_ENTRIES
}
