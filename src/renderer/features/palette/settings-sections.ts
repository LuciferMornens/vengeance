import {
  Blocks,
  Bot,
  Boxes,
  Braces,
  BrainCircuit,
  Command,
  Cpu,
  FolderClock,
  Keyboard,
  Palette,
  Plug,
  Server,
  SquareTerminal,
  UserRound,
  type LucideIcon
} from 'lucide-react'
import type { SettingsSectionId } from '@shared/api/settings-schema'
import type { EngineCapabilities, EngineId } from '@shared/api/engine'
import { useApp } from '../../store/app'
import { useSettings } from '../settings/store'

/**
 * Palette entries for the settings sheet's sections (labels and icons as in settings/sections). Keyed by
 * `SettingsSectionId`, so a section added or renamed there fails to compile here until the palette follows.
 * The sheet's registry itself is not imported: it pulls every section into the main bundle.
 */
const SECTIONS: Record<SettingsSectionId, { title: string; icon: LucideIcon; keywords: string[] }> =
  {
    general: {
      title: 'General',
      icon: Palette,
      keywords: ['theme', 'accent', 'font', 'density', 'appearance', 'motion']
    },
    shortcuts: { title: 'Keyboard shortcuts', icon: Keyboard, keywords: ['hotkeys', 'keys'] },
    models: {
      title: 'Models',
      icon: BrainCircuit,
      keywords: ['default model', 'thinking', 'scoped', 'cycling', 'response speed', 'fast']
    },
    providers: {
      title: 'Providers & accounts',
      icon: UserRound,
      keywords: ['login', 'sign in', 'api key', 'oauth', 'auth', '/login']
    },
    'custom-models': {
      title: 'Custom models',
      icon: Boxes,
      keywords: ['models.json', 'endpoint', 'ollama', 'local']
    },
    agent: {
      title: 'Agent behavior',
      icon: Bot,
      keywords: ['steering', 'follow-up', 'retry', 'compaction', 'tools', 'shell']
    },
    packages: {
      title: 'Packages',
      icon: Blocks,
      keywords: ['install', 'npm', 'git', 'update', 'extensions']
    },
    resources: {
      title: 'Resources',
      icon: Plug,
      keywords: ['extensions', 'skills', 'prompts', 'themes', 'enable', 'disable']
    },
    mcp: { title: 'MCP servers', icon: Server, keywords: ['model context protocol'] },
    sessions: {
      title: 'Sessions & context',
      icon: FolderClock,
      keywords: ['context files', 'trust', 'session dir', 'agents.md']
    },
    terminal: {
      title: 'Terminal mode',
      icon: SquareTerminal,
      keywords: ['tui', 'terminal', 'editor']
    },
    keybindings: {
      title: 'Terminal keys',
      icon: Command,
      keywords: ['keybindings.json', 'terminal keybindings']
    },
    engine: {
      title: 'Engine',
      icon: Cpu,
      keywords: ['version', 'path', 'diagnostics', 'update', 'stderr']
    },
    raw: { title: 'Raw JSON', icon: Braces, keywords: ['settings.json', 'advanced', 'json'] }
  }

export const SETTINGS_SECTIONS = Object.entries(SECTIONS).map(([id, section]) => ({
  id: id as SettingsSectionId,
  ...section
}))

export function settingsSectionAvailable(
  section: SettingsSectionId,
  capabilities: EngineCapabilities | undefined
): boolean {
  if (!capabilities) return ['general', 'shortcuts', 'engine'].includes(section)
  switch (section) {
    case 'providers':
      return capabilities.providers
    case 'custom-models':
      return capabilities.customModels
    case 'packages':
      return capabilities.packages
    case 'resources':
      return capabilities.resources
    case 'mcp':
      return capabilities.mcp
    case 'keybindings':
      return capabilities.keybindings
    case 'sessions':
      return capabilities.instructions
    case 'models':
    case 'agent':
    case 'terminal':
    case 'raw':
      return capabilities.settings
    default:
      return true
  }
}

export function sectionLabel(id: SettingsSectionId): string {
  return SECTIONS[id].title
}

export function openSettingsSection(section: SettingsSectionId, engine?: EngineId): void {
  useApp.getState().openSettings(section, engine)
}

const REVEAL_TIMEOUT_MS = 3000

/**
 * Open a settings section and pulse one row (`settingKey`, e.g. `doubleEscapeAction` or `provider.anthropic`).
 * The highlight is set once the row is on screen: the sheet scrolls a newly opened section to the top, which
 * would cancel a scroll started while the section was still mounting.
 */
export function revealSetting(
  section: SettingsSectionId,
  settingKey: string,
  engine?: EngineId
): void {
  openSettingsSection(section, engine)
  useSettings.getState().setHighlight(null)
  const started = performance.now()
  const tick = () => {
    if (document.getElementById(`setting-${settingKey}`))
      requestAnimationFrame(() => useSettings.getState().setHighlight(settingKey))
    else if (performance.now() - started < REVEAL_TIMEOUT_MS) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
