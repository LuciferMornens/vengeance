import { useEffect, useMemo, useState } from 'react'
import {
  File,
  FileArchive,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Puzzle,
  ScrollText,
  Sparkles
} from 'lucide-react'
import { friendlyExtensionName } from '@shared/display-names'
import type { EngineId } from '@shared/api/engine'
import type { FileMatch } from '@shared/api/system'
import type { RpcSlashCommand } from '@shared/engine-types'
import { invoke } from '../../lib/ipc'
import { useEffectiveSetting } from '../settings/effective'
import { availableBuiltins, type BuiltinCommand } from './builtins'
import { useEngineCapabilities } from '../engines/registry'
import { fuzzyMatch } from './fuzzy'
import type { SuggestionItem } from './SuggestionMenu'

// ─── Slash commands ──────────────────────────────────────────────────────────────────────────

export type SlashEntry =
  { kind: 'builtin'; command: BuiltinCommand } | { kind: 'engine'; command: RpcSlashCommand }

export interface SlashSuggestion extends SuggestionItem {
  entry: SlashEntry
  name: string
  /** Argument hint (`<required>` / `[optional]`): built-in args or a template's `argument-hint`. */
  hint?: string
}

const ENGINE_GROUPS: Record<RpcSlashCommand['source'], string> = {
  extension: 'Extensions',
  prompt: 'Prompt templates',
  skill: 'Skills'
}
const ENGINE_KIND: Record<RpcSlashCommand['source'], string> = {
  extension: 'Extension',
  prompt: 'Prompt',
  skill: 'Skill'
}
const ENGINE_ICON = { extension: <Puzzle />, prompt: <ScrollText />, skill: <Sparkles /> }

/** Where an engine command comes from: its package's friendly name (source as `title`), or "Project" for project-local resources. */
export function engineScope(
  command: RpcSlashCommand
): { label: string; title: string } | undefined {
  const { source, scope } = command.sourceInfo
  if (source.startsWith('npm:') || source.startsWith('git:'))
    return { label: friendlyExtensionName(source), title: source }
  return scope === 'project' ? { label: 'Project', title: 'This project' } : undefined
}

/**
 * The engine commands the slash menu and palette offer. `enableSkillCommands: false` hides skill commands from
 * them, as in the Engine's terminal (RPC `get_commands` lists them regardless); typed ones still run.
 */
export function useOfferedCommands(
  commands: RpcSlashCommand[],
  cwd: string | null,
  engine: EngineId = 'pi'
): RpcSlashCommand[] {
  const skillCommands = useEffectiveSetting('enableSkillCommands', cwd, engine) !== false
  return useMemo(
    () => (skillCommands ? commands : commands.filter((command) => command.source !== 'skill')),
    [commands, skillCommands]
  )
}

/**
 * Slash menu entries: engine commands (get_commands) grouped by source, then the GUI-mapped built-ins. While
 * filtering, the list is flat and ranked, and each row names its kind instead of a group heading.
 */
export function useSlashSuggestions(
  commands: RpcSlashCommand[],
  query: string,
  hints: Map<string, string>,
  engineId: EngineId,
  bridge: boolean
): SlashSuggestion[] {
  const capabilities = useEngineCapabilities(engineId)
  return useMemo(() => {
    const engine: SlashSuggestion[] = commands.map((command) => ({
      key: `${command.source}:${command.name}`,
      name: command.name,
      entry: { kind: 'engine', command },
      icon: ENGINE_ICON[command.source],
      title: `/${command.name}`,
      hint: hints.get(command.name),
      meta: hints.get(command.name),
      description: command.description,
      scope: engineScope(command)?.label,
      scopeTitle: engineScope(command)?.title,
      kind: ENGINE_KIND[command.source],
      group: ENGINE_GROUPS[command.source]
    }))
    const engineNames = new Set(commands.map((c) => c.name))
    const builtins: SlashSuggestion[] = availableBuiltins(engineId, bridge)
      .filter((c) => !engineNames.has(c.name))
      .map((command) => {
        const Icon = command.icon
        return {
          key: `builtin:${command.name}`,
          name: command.name,
          entry: { kind: 'builtin', command },
          icon: <Icon />,
          title: `/${command.name}`,
          hint: command.args,
          meta: command.args,
          description: command.description,
          kind: 'App',
          group: 'App commands'
        }
      })
    const all = [...engine, ...builtins]
    if (!query) return all.map((item) => ({ ...item, kind: undefined }))
    const scored: Array<{ item: SlashSuggestion; score: number }> = []
    for (const item of all) {
      const byName = fuzzyMatch(item.name, query)
      if (byName)
        scored.push({
          item: { ...item, indices: byName.indices.map((i) => i + 1), group: undefined },
          score: byName.score
        })
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.item)
  }, [commands, query, hints, engineId, bridge, capabilities])
}

// ─── @ file mentions ─────────────────────────────────────────────────────────────────────────

const CODE =
  /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|lua|vue|svelte|astro|css|scss|less|html?|sql|zig|dart|ex|exs|scala)$/i
const DATA = /\.(json|jsonc|json5|ya?ml|toml|xml)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i
const SHELL = /\.(sh|bash|zsh|ps1|bat|cmd)$/i
const CONFIG =
  /(^|\/)(\.[\w.-]+rc|\.env[\w.-]*|\.gitignore|\.editorconfig|dockerfile|makefile|[\w.-]+\.config\.\w+)$/i
const SHEET = /\.(csv|tsv|xlsx?)$/i
const ARCHIVE = /\.(zip|tar|gz|tgz|7z|rar)$/i
const LOCK = /(\.lock|lock\.json|lock\.yaml)$/i
const TEXT = /\.(md|mdx|txt|rst|adoc|log)$/i

export function fileIcon(path: string) {
  if (LOCK.test(path)) return <FileLock />
  if (CODE.test(path)) return <FileCode />
  if (DATA.test(path)) return <FileBraces />
  if (IMAGE.test(path)) return <FileImage />
  if (SHELL.test(path)) return <FileTerminal />
  if (CONFIG.test(path)) return <FileCog />
  if (SHEET.test(path)) return <FileSpreadsheet />
  if (ARCHIVE.test(path)) return <FileArchive />
  if (TEXT.test(path)) return <FileText />
  return <File />
}

export interface MentionSuggestion extends SuggestionItem {
  path: string
}

export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

function toMentionItem(match: FileMatch, query: string): MentionSuggestion {
  const slash = match.path.lastIndexOf('/')
  const name = match.path.slice(slash + 1)
  const dir = slash >= 0 ? match.path.slice(0, slash) : ''
  const hit = query ? fuzzyMatch(name, query.split('/').pop() ?? query) : null
  return {
    key: match.path,
    path: match.path,
    icon: fileIcon(match.path),
    title: name,
    indices: hit?.indices,
    description: dir
  }
}

/** Workspace files for the `@` picker (sys:list-files is git-aware, cached and fuzzy-scored in main). */
export function useFileMentions(
  cwd: string,
  query: string,
  enabled: boolean
): { items: MentionSuggestion[]; loading: boolean } {
  const [result, setResult] = useState<{ key: string; items: MentionSuggestion[] }>({
    key: '',
    items: []
  })
  const key = `${cwd}\u0000${query}`

  useEffect(() => {
    if (!enabled || !cwd) return
    let cancelled = false
    const timer = setTimeout(
      () => {
        invoke('sys:list-files', cwd, query, { limit: 40 })
          .then(
            (matches) =>
              !cancelled && setResult({ key, items: matches.map((m) => toMentionItem(m, query)) })
          )
          .catch(() => !cancelled && setResult({ key, items: [] }))
      },
      query ? 60 : 0
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cwd, query, enabled, key])

  return { items: result.items, loading: enabled && result.key !== key }
}
