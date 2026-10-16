import type { LucideIcon } from 'lucide-react'
import { Braces, File, FileCode2, FileCog, FileImage, FileTerminal, FileText, Folder } from 'lucide-react'
import { useAgents } from '../../store/agents'
import { cn } from '../../lib/cn'
import { languageFromPath } from '../../ui/highlight'
import { useSubagentRun } from '../subagents'
import { baseName, displayPath, shortPath, splitPath } from './tool-utils'

const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i
const TEXT_LANGS = new Set(['markdown', 'mdx', 'txt'])
const CONFIG_LANGS = new Set(['yaml', 'toml', 'ini', 'xml', 'dotenv'])
const SHELL_LANGS = new Set(['shellscript', 'powershell', 'bat', 'cmd'])

function glyphFor(path: string): LucideIcon {
  if (path.endsWith('/')) return Folder
  if (IMAGE.test(path)) return FileImage
  const lang = languageFromPath(path)
  if (!lang) return File
  if (lang === 'json' || lang === 'jsonc' || lang === 'json5') return Braces
  if (TEXT_LANGS.has(lang)) return FileText
  if (CONFIG_LANGS.has(lang)) return FileCog
  if (SHELL_LANGS.has(lang)) return FileTerminal
  return FileCode2
}

/** Working folder of the session (tool paths and `cd` targets are shown relative to it). */
export function useAgentCwd(agentId: string): string | undefined {
  return useAgents((s) => s.agents[agentId]?.info.cwd)
}

/** Workspace-relative display path of a tool argument. */
export function useDisplayPath(agentId: string, path: string | undefined): string {
  const cwd = useAgentCwd(agentId)
  return path ? displayPath(path, cwd) : ''
}

/** Muted 14px file-type glyph (code, data, text, config, shell, image, folder). */
export function FileGlyph({ path, className }: { path: string; className?: string }) {
  const Icon = glyphFor(path)
  return <Icon aria-hidden className={cn('size-3.5 shrink-0 text-fg-3', className)} strokeWidth={1.75} />
}

/** pi-subagents' saved output of a run: `<run id>_<agent>_output.md` in `subagent-artifacts`. */
const RUN_ARTIFACT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([\w-]+)_output\.md$/i
/** pi's temp file for an image pasted into the terminal. */
const PASTED_IMAGE = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i

/** A file named by an id (a run's saved output, a pasted image) as words; the path stays in the tooltip. */
function NamedFile({ agentId, path, name, className }: { agentId: string; path: string; name: string; className?: string }) {
  const artifact = RUN_ARTIFACT.exec(name)
  const run = useSubagentRun(agentId, artifact?.[1]?.toLowerCase())
  const label = artifact ? `${run?.label ?? artifact[2]} output` : 'Pasted image'
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={path}>
      <FileGlyph path={name} />
      <span className="shrink-0 text-fg">{label}</span>
      {run?.title && <span className="min-w-0 truncate text-fg-3">{run.title}</span>}
    </span>
  )
}

/** File path for row subjects: file-type glyph, dim directory, bright file name. */
export function PathChip({ agentId, path, className }: { agentId: string; path: string | undefined; className?: string }) {
  const cwd = useAgentCwd(agentId)
  const relative = useDisplayPath(agentId, path)
  if (!relative || !path) return null
  const fileName = baseName(relative)
  if (RUN_ARTIFACT.test(fileName) || PASTED_IMAGE.test(fileName)) return <NamedFile agentId={agentId} path={path} name={fileName} className={className} />
  // The workspace folder itself reads as its name, not ".".
  const shown = relative.replace(/\/$/, '') === '.' && cwd ? `${baseName(cwd)}/` : shortPath(relative)
  const { dir, name } = splitPath(shown.replace(/\/$/, ''))
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', className)} title={path}>
      <FileGlyph path={shown} />
      <span className="flex min-w-0 font-mono text-[12px]">
        <span className="min-w-0 truncate text-fg-3">{dir}</span>
        <span className="shrink-0 text-fg">{name}</span>
      </span>
    </span>
  )
}
