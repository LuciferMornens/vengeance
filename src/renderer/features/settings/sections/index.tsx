import type { ReactNode } from 'react'
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
  Sparkles,
  SquareTerminal,
  UserRound
} from 'lucide-react'
import type { SettingsSectionId } from '@shared/api/settings-schema'
import type { EngineCapabilities, EngineId } from '@shared/api/engine'
import { shortcutText } from '../../../lib/keybindings'
import { PrimeResourcesSection, PrimeSettingsGroups } from '../../engines/prime-settings'
import { PrimeMcpSection } from '../../engines/prime-mcp'
import { SchemaGroups } from '../fields'
import { CustomModelsSection } from './custom-models'
import { EngineSection } from './engine'
import { ExtensionsSection } from './extensions'
import { GeneralSection } from './general'
import { KeybindingsSection } from './keybindings'
import { McpSection } from './mcp'
import { NativeCompactionRow } from './native-compaction'
import { PackagesSection } from './packages'
import { ProvidersSection } from './providers'
import { RawSection } from './raw'
import { ResourcesSection } from './resources'
import { ContextGroup, SessionsSection } from './sessions'
import { SpeedDefaultRow } from './speed-default'
import { InstructionsGroup } from './instructions'
import { ShortcutsSection } from './shortcuts'

/** Section registry: nav order, header copy, and whether the Global/Project scope applies. */

export interface SectionDef {
  id: SettingsSectionId
  label: string
  icon: ReactNode
  description: string
  /** Edits engine settings.json — shows the Global/Project scope switch. */
  scoped?: boolean
  /** Nav group divider label shown above this section. */
  groupLabel?: string
  render: () => ReactNode
}

export const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: <Palette />,
    description: 'Appearance, motion and how Vengeance behaves.',
    groupLabel: 'Vengeance',
    render: () => <GeneralSection />
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: <Keyboard />,
    description: 'Every shortcut in Vengeance. Actions are also in the command palette.',
    render: () => <ShortcutsSection />
  },
  {
    id: 'models',
    label: 'Models',
    icon: <BrainCircuit />,
    description:
      `Default model, thinking levels, response speed and which models ${shortcutText('mod+p')} cycles through.`,
    scoped: true,
    groupLabel: 'Engine',
    render: () => <SchemaGroups section="models" extras={{ Defaults: <SpeedDefaultRow /> }} />
  },
  {
    id: 'providers',
    label: 'Providers & accounts',
    icon: <UserRound />,
    description:
      'Sign in with subscriptions or add API keys. Keys never leave the engine’s auth file.',
    render: () => <ProvidersSection />
  },
  {
    id: 'custom-models',
    label: 'Custom models',
    icon: <Boxes />,
    description: 'Local servers, proxies and custom endpoints from models.json.',
    render: () => <CustomModelsSection />
  },
  {
    id: 'agent',
    label: 'Agent behavior',
    icon: <Bot />,
    description: 'Queues, retries, compaction, tools, shell and network.',
    scoped: true,
    render: () => <SchemaGroups section="agent" extras={{ Compaction: <NativeCompactionRow /> }} />
  },
  {
    id: 'extensions',
    label: 'Extensions',
    icon: <Sparkles />,
    description: 'Find community extensions, or add your own from a file or folder.',
    render: () => <ExtensionsSection />
  },
  {
    id: 'packages',
    label: 'Packages',
    icon: <Blocks />,
    description: 'Extensions, skills, prompts and themes bundled from npm, git or local folders.',
    render: () => <PackagesSection />
  },
  {
    id: 'resources',
    label: 'Resources',
    icon: <Plug />,
    description: 'Turn individual extensions, skills, prompt templates and themes on or off.',
    scoped: true,
    render: () => <ResourcesSection />
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: <Server />,
    description: 'Model Context Protocol servers the engine connects to.',
    render: () => <McpSection />
  },
  {
    id: 'sessions',
    label: 'Sessions & context',
    icon: <FolderClock />,
    description: 'Where sessions live, project trust, and the files loaded into every prompt.',
    scoped: true,
    render: () => <SessionsSection />
  },
  {
    id: 'engine',
    label: 'Engine',
    icon: <Cpu />,
    description: 'Version, location, updates and diagnostics.',
    groupLabel: 'Advanced',
    render: () => <EngineSection />
  },
  {
    id: 'terminal',
    label: 'Terminal mode',
    icon: <SquareTerminal />,
    description:
      'Applies when you run the engine in a terminal. Settings marked “Also in Vengeance” apply here too.',
    scoped: true,
    render: () => <SchemaGroups section="terminal" />
  },
  {
    id: 'keybindings',
    label: 'Terminal keys',
    icon: <Command />,
    description: 'Keys of the engine’s terminal interface, from keybindings.json.',
    render: () => <KeybindingsSection />
  },
  {
    id: 'raw',
    label: 'Raw JSON',
    icon: <Braces />,
    description:
      'Edit settings.json directly. Changes are validated and shown as a diff before saving.',
    scoped: true,
    render: () => <RawSection />
  }
]

function availableSection(section: SectionDef, capabilities?: EngineCapabilities): boolean {
  if (!capabilities) return true
  switch (section.id) {
    case 'providers':
      return capabilities.providers
    case 'custom-models':
      return capabilities.customModels
    case 'extensions':
      return capabilities.packages && capabilities.extensionUi
    case 'packages':
      return capabilities.packages
    case 'resources':
      return capabilities.resources
    case 'mcp':
      return capabilities.mcp
    case 'keybindings':
      return capabilities.keybindings
    default:
      return true
  }
}

export function getSections(engine: EngineId, capabilities?: EngineCapabilities): SectionDef[] {
  return SECTIONS.filter(
    (section) =>
      availableSection(section, capabilities) &&
      (engine === 'pi' || section.id !== 'keybindings' || capabilities?.keybindings)
  ).map((section) => {
    if (engine === 'pi') return section
    switch (section.id) {
      case 'models':
        return {
          ...section,
          groupLabel: 'Engine 2',
          description: 'Default models, reasoning, service tier and model cycling.',
          render: () => <PrimeSettingsGroups section="models" />
        }
      case 'agent':
        return {
          ...section,
          description: 'Execution, goals, autonomous runs, retries, compaction and subagents.',
          render: () => <PrimeSettingsGroups section="agent" />
        }
      case 'resources':
        return {
          ...section,
          description: 'Skills, prompt templates and resources loaded by Engine 2.',
          render: () => <PrimeResourcesSection />
        }
      case 'sessions':
        return {
          ...section,
          description: 'Session storage, context and instruction files for Engine 2.',
          render: () => (
            <>
              <PrimeSettingsGroups section="sessions" />
              <InstructionsGroup />
              <ContextGroup />
            </>
          )
        }
      case 'terminal':
        return {
          ...section,
          description: 'Display, input and notifications in the engine’s terminal interface.',
          render: () => <PrimeSettingsGroups section="terminal" />
        }
      case 'mcp':
        return {
          ...section,
          scoped: true,
          description: 'Servers and tools configured for Engine 2.',
          render: () => <PrimeMcpSection />
        }
      case 'packages':
        return { ...section, description: 'Install and manage the packages used by Engine 2.' }
      case 'engine':
        return { ...section, label: 'Engine 2' }
      default:
        return section
    }
  })
}

export function findSection(
  id: string | null | undefined,
  engine: EngineId = 'pi',
  capabilities?: EngineCapabilities
): SectionDef {
  const sections = getSections(engine, capabilities)
  return sections.find((section) => section.id === id) ?? sections[0]!
}
