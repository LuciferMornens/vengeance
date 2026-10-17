import { useMemo } from 'react'
import { ArrowRight, SearchX } from 'lucide-react'
import { SETTINGS, type SettingDef, type SettingsSectionId } from '@shared/api/settings-schema'
import type { EngineId } from '@shared/api/engine'
import { PrimeSettingsSearch, primeSettingsMatchCount } from '../engines/prime-settings'
import { useEngineCapabilities } from '../engines/registry'
import { SYSTEM_NAME } from '../../lib/platform-copy'
import { useApp } from '../../store/app'
import { SettingField } from './fields'
import { Group, Highlight, SearchQueryContext } from './layout'
import { getSections } from './sections'
import { useSettings } from './store'

/** Global settings search: every engine key renders as a live, editable row; app rows jump to their section. */

interface JumpEntry {
  key: string
  section: SettingsSectionId
  label: string
  description: string
  keywords?: string[]
}

/** Rows that live outside the engine schema (app prefs, accounts, files). */
const JUMPS: JumpEntry[] = [
  {
    key: 'app.theme',
    section: 'general',
    label: 'Theme',
    description: `Obsidian (dark), Bone (light) or follow ${SYSTEM_NAME}.`,
    keywords: ['dark', 'light', 'appearance']
  },
  {
    key: 'app.accent',
    section: 'general',
    label: 'Accent color',
    description: 'Ember, violet, cyan, lime, rose or mono.',
    keywords: ['color']
  },
  {
    key: 'app.fontScale',
    section: 'general',
    label: 'Text size',
    description: 'Scale the interface and transcript.',
    keywords: ['font', 'zoom']
  },
  {
    key: 'app.density',
    section: 'general',
    label: 'Density',
    description: 'Comfortable or compact rows.'
  },
  {
    key: 'app.motion',
    section: 'general',
    label: 'Motion',
    description: 'Reduce animations.',
    keywords: ['animation', 'reduced motion', 'accessibility']
  },
  {
    key: 'app.restartPolicy',
    section: 'general',
    label: 'Apply engine changes',
    description: 'Ask, restart automatically, or wait.',
    keywords: ['restart']
  },
  {
    key: 'app.updates',
    section: 'general',
    label: 'Automatic updates',
    description: 'Off, notify, or update automatically.',
    keywords: ['update', 'auto-update']
  },
  {
    key: 'app.updateInterval',
    section: 'general',
    label: 'Update check interval',
    description: 'How often to look for updates.',
    keywords: ['update']
  },
  {
    key: 'app.feedUrl',
    section: 'general',
    label: 'Vengeance update feed',
    description: 'Generic update server for the app itself.',
    keywords: ['self-update', 'electron']
  },
  {
    key: 'app.nativeCompaction',
    section: 'agent',
    label: 'OpenAI native compaction',
    description: 'OpenAI compacts the context itself for OpenAI models.',
    keywords: ['compaction', 'openai', 'chatgpt', 'context', 'native']
  },
  {
    key: 'app.speedDefault',
    section: 'models',
    label: 'Response speed for new sessions',
    description: 'Standard, Fast or Ultrafast for sessions without a choice of their own.',
    keywords: ['speed', 'fast', 'ultrafast', 'priority', 'service tier', 'default']
  },
  {
    key: 'app.about',
    section: 'general',
    label: 'About Vengeance',
    description: 'Version of Vengeance and the Engine.',
    keywords: ['version', 'about', 'engine']
  },
  {
    key: 'provider.anthropic',
    section: 'providers',
    label: 'Sign in / API keys',
    description: 'Connect subscriptions and API keys.',
    keywords: ['oauth', 'login', 'account', 'key', 'auth', 'claude', 'openai', 'copilot']
  },
  {
    key: 'custom-models',
    section: 'custom-models',
    label: 'Custom models (models.json)',
    description: 'Ollama, LM Studio, proxies and custom endpoints.',
    keywords: ['ollama', 'lm studio', 'local', 'base url']
  },
  {
    key: 'extensions',
    section: 'extensions',
    label: 'Discover extensions',
    description: 'Browse community extensions, or add one from a file or folder.',
    keywords: ['gallery', 'browse', 'marketplace', 'community', 'add extension', 'plugin']
  },
  {
    key: 'packages',
    section: 'packages',
    label: 'Install packages',
    description: 'Install from npm, git or a local path.',
    keywords: ['extension', 'install', 'npm', 'update']
  },
  {
    key: 'mcp',
    section: 'mcp',
    label: 'MCP servers',
    description: 'Add, enable and sign in to MCP servers.',
    keywords: ['model context protocol', 'server', 'tools']
  },
  {
    key: 'projectTrust',
    section: 'sessions',
    label: 'Project trust',
    description: 'Trust this folder to load its settings and extensions.',
    keywords: ['security']
  },
  {
    key: 'engine.override',
    section: 'engine',
    label: 'Engine location',
    description: 'Use a custom engine install.',
    keywords: ['path', 'pi', 'version', 'diagnostics', 'stderr']
  },
  {
    key: 'raw',
    section: 'raw',
    label: 'Raw settings.json',
    description: 'Edit the JSON directly.',
    keywords: ['json', 'file']
  }
]

function score(
  haystack: {
    label: string
    description: string
    key: string
    keywords?: string[]
    group?: string
  },
  terms: string[]
): number {
  const label = haystack.label.toLowerCase()
  const rest =
    `${haystack.key} ${haystack.description} ${haystack.group ?? ''} ${(haystack.keywords ?? []).join(' ')}`.toLowerCase()
  let total = 0
  for (const term of terms) {
    if (label.startsWith(term)) total += 6
    else if (label.includes(term)) total += 4
    else if (haystack.key.toLowerCase().includes(term)) total += 3
    else if (rest.includes(term)) total += 1
    else return 0
  }
  return total
}

export interface SearchResults {
  settings: Array<{ def: SettingDef; score: number }>
  jumps: Array<{ entry: JumpEntry; score: number }>
}

export function searchSettings(query: string, engine: EngineId = 'pi'): SearchResults {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { settings: [], jumps: [] }
  return {
    settings: (engine === 'pi' ? SETTINGS : [])
      .map((def) => ({
        def,
        score: score({ ...def, key: [def.key, ...(def.alsoKeys ?? [])].join(' ') }, terms)
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score),
    jumps: JUMPS.filter(
      (entry) =>
        engine === 'pi' ||
        !['projectTrust', 'app.nativeCompaction', 'app.speedDefault'].includes(entry.key)
    )
      .map((entry) => ({ entry, score: score(entry, terms) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
  }
}

export function SearchView({ query }: { query: string }) {
  const engine = useSettings((state) => state.engine)
  const capabilities = useEngineCapabilities(engine)
  const results = useMemo(() => searchSettings(query, engine), [query, engine])
  const nativeMatches = engine === 'prime' ? primeSettingsMatchCount(query) : 0
  const openSettings = useApp((s) => s.openSettings)
  const setQuery = useSettings((s) => s.setQuery)
  const setHighlight = useSettings((s) => s.setHighlight)

  const jump = (section: SettingsSectionId, key: string) => {
    setQuery('')
    openSettings(section)
    setHighlight(key)
  }

  const bySection = getSections(engine, capabilities)
    .map((section) => ({
      section,
      settings: results.settings.filter((r) => r.def.section === section.id),
      jumps: results.jumps.filter((r) => r.entry.section === section.id)
    }))
    .filter((g) => g.settings.length + g.jumps.length > 0)
    .sort(
      (a, b) =>
        Math.max(0, ...b.settings.map((s) => s.score), ...b.jumps.map((j) => j.score)) -
        Math.max(0, ...a.settings.map((s) => s.score), ...a.jumps.map((j) => j.score))
    )

  if (bySection.length === 0 && nativeMatches === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <SearchX className="size-8 text-fg-4" />
        <div className="mt-3 text-md font-medium text-fg-2">No settings match “{query}”</div>
        <div className="mt-1 text-sm text-fg-3">
          Try a key like compaction or a word like retry.
        </div>
      </div>
    )
  }

  const total = bySection.reduce(
    (count, group) => count + group.settings.length + group.jumps.length,
    nativeMatches
  )
  return (
    <SearchQueryContext.Provider value={query}>
      <div className="mb-6 text-sm text-fg-3">
        <span className="tabular font-medium text-fg-2">{total}</span>{' '}
        {total === 1 ? 'result' : 'results'} for “{query}”
      </div>
      {engine === 'prime' && <PrimeSettingsSearch query={query} />}
      {bySection.map(({ section, settings, jumps }) => (
        <Group
          key={section.id}
          title={
            <span className="flex items-center gap-2 [&_svg]:size-3.5">
              {section.icon}
              {section.label}
            </span>
          }
        >
          {jumps.map(({ entry }) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => jump(entry.section, entry.key)}
              className="group/jump flex w-full items-center gap-4 border-b border-hairline-soft px-4 py-3.5 text-left last:border-b-0 hover:bg-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="text-ui font-medium text-fg">
                  <Highlight text={entry.label} />
                </div>
                <div className="mt-0.5 text-sm text-fg-3">
                  <Highlight text={entry.description} />
                </div>
              </div>
              <ArrowRight className="size-4 text-fg-4 transition-transform group-hover/jump:translate-x-0.5 group-hover/jump:text-fg-2" />
            </button>
          ))}
          {settings.map(({ def }) => (
            <SettingField key={def.key} def={def} />
          ))}
        </Group>
      ))}
    </SearchQueryContext.Provider>
  )
}
