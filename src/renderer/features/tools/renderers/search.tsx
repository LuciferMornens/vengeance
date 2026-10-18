import { useMemo, type ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import { useAgents } from '../../../store/agents'
import { useDisclosure, useToolsExpanded } from '../disclosure'
import { FileGlyph, PathChip, useDisplayPath } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailEmpty, DetailNote, MonoSubject, RowDetail, ShowMore, ToolRow, usePreviewExpanded } from '../ToolRow'
import { bool, firstLine, isActive, payloadText, plural, resultPayload, splitPath, splitTrailingNotes, str, toolPhase, type ToolPhase } from '../tool-utils'

const LIST_LIMIT = 60
const GREP_GROUP_LIMIT = 30
const EMPTY_RESULTS = /^(No matches found|No files found matching pattern|\(empty directory\))$/

function useSearchResult(agentId: string, props: ToolRendererProps): { phase: ToolPhase; body: string; notes: string[]; empty: boolean } {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(props.execution, running)
  const payload = resultPayload(props.execution)
  const { trimmed, notes } = useMemo(() => {
    const split = splitTrailingNotes(payloadText(payload))
    return { trimmed: split.body.trim(), notes: split.notes }
  }, [payload])
  return { phase, body: trimmed, notes, empty: phase === 'done' && (trimmed === '' || EMPTY_RESULTS.test(trimmed)) }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matcher(pattern: string, literal: boolean, ignoreCase: boolean): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? 'gi' : 'g')
  } catch {
    try {
      return new RegExp(escapeRegExp(pattern), ignoreCase ? 'gi' : 'g')
    } catch {
      return null
    }
  }
}

function highlightMatches(text: string, re: RegExp | null): ReactNode {
  if (!re) return text
  const out: ReactNode[] = []
  let last = 0
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <mark key={m.index} className="rounded-xs bg-accent-soft px-px text-fg">
        {m[0]}
      </mark>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface GrepLine {
  line: number
  text: string
  match: boolean
}

function countGrep(body: string): { matches: number; files: number } {
  let matches = 0
  let files = 0
  let lastFile = ''
  for (const raw of body.split('\n')) {
    const match = /^(.+?):(\d+):/.exec(raw)
    const context = match ? null : /^(.+?)-(\d+)-/.exec(raw)
    const m = match ?? context
    if (!m) continue
    if (match) matches++
    const file = m[1]!
    if (file !== lastFile) {
      lastFile = file
      files++
    }
  }
  return { matches, files }
}

function countNonEmptyLines(text: string): number {
  if (!text) return 0
  let count = 0
  let lineStart = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i > lineStart) count++
      lineStart = i + 1
    }
  }
  return count
}

function parseGrep(body: string): Array<{ file: string; lines: GrepLine[] }> {
  const files: Array<{ file: string; lines: GrepLine[] }> = []
  for (const raw of body.split('\n')) {
    const match = /^(.+?):(\d+):\s?(.*)$/.exec(raw)
    const context = match ? null : /^(.+?)-(\d+)-\s?(.*)$/.exec(raw)
    const m = match ?? context
    if (!m) continue
    const file = m[1]!
    let group = files[files.length - 1]
    if (!group || group.file !== file) {
      group = { file, lines: [] }
      files.push(group)
    }
    group.lines.push({ line: Number(m[2]), text: m[3]!, match: !!match })
  }
  return files
}

function FileHeading({ path, count }: { path: string; count?: number }) {
  const { dir, name } = splitPath(path.replace(/\\/g, '/'))
  return (
    <div className="flex h-7 items-center gap-1.5 px-3.5 font-mono text-[11.5px]">
      <FileGlyph path={path} />
      <span className="flex min-w-0">
        <span className="min-w-0 truncate text-fg-3">{dir}</span>
        <span className="shrink-0 text-fg">{name}</span>
      </span>
      {count !== undefined && <span className="ml-auto font-sans text-2xs text-fg-3 tabular">{count}</span>}
    </div>
  )
}

/** "in src · *.ts" after a pattern. */
function Scope({ where }: { where: string }) {
  if (!where) return null
  return (
    <span className="min-w-0 shrink truncate text-xs text-fg-3">
      in <span className="font-mono text-fg-2">{where}</span>
    </span>
  )
}

function GrepFiles({ files, re }: { files: Array<{ file: string; lines: GrepLine[] }>; re: RegExp | null }) {
  const [all, setAll] = usePreviewExpanded('files')
  const shown = all ? files : files.slice(0, GREP_GROUP_LIMIT)
  return (
    <>
      <div className="py-1.5">
        {shown.map((f) => (
          <div key={f.file} className="pb-1">
            <FileHeading path={f.file} count={f.lines.filter((l) => l.match).length} />
            {f.lines.map((l, i) => (
              <div key={i} className={cn('flex font-mono text-[12px] leading-[1.65]', !l.match && 'opacity-55')}>
                <span className="w-14 shrink-0 pr-3 text-right text-fg-3 tabular select-none">{l.line}</span>
                <span className="selectable min-w-0 pr-3 break-all whitespace-pre-wrap text-fg-2">{highlightMatches(l.text.trimEnd(), l.match ? re : null)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {files.length > GREP_GROUP_LIMIT && (
        <ShowMore expanded={all} onToggle={() => setAll(!all)} hidden={files.length - GREP_GROUP_LIMIT} unit="files" />
      )}
    </>
  )
}

function GrepRow(props: ToolRendererProps) {
  const { agentId, call, execution } = props
  const { phase, body, notes, empty } = useSearchResult(agentId, props)
  const pattern = str(call.arguments.pattern) ?? ''
  const glob = str(call.arguments.glob)
  const where = useDisplayPath(agentId, str(call.arguments.path))
  const toolsExpanded = useToolsExpanded()
  const [open] = useDisclosure(`tool:${call.id}`, toolsExpanded)
  const re = useMemo(
    () => (open ? matcher(pattern, bool(call.arguments.literal) ?? false, bool(call.arguments.ignoreCase) ?? false) : null),
    [open, call.arguments, pattern]
  )
  const counts = useMemo(
    () => (phase === 'error' || empty ? { matches: 0, files: 0 } : countGrep(body)),
    [body, phase, empty]
  )
  const files = useMemo(() => (!open || phase === 'error' || empty ? [] : parseGrep(body)), [open, body, phase, empty])
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Searching' : 'Searched'}
      subject={
        <>
          <MonoSubject className="shrink-0 text-fg">{pattern}</MonoSubject>
          <Scope where={[where, glob].filter(Boolean).join(' \u00b7 ')} />
        </>
      }
      meta={phase === 'done' ? <span>{empty ? 'no matches' : `${plural(counts.matches, 'match', 'matches')} \u00b7 ${plural(counts.files, 'file')}`}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(body) || 'Search failed' : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={body}>
            {failed ? (
              <DetailNote tone="danger">{body || 'Search failed'}</DetailNote>
            ) : empty ? (
              <DetailEmpty>No matches for “{pattern}”.</DetailEmpty>
            ) : files.length > 0 ? (
              <GrepFiles files={files} re={re} />
            ) : (
              body && <pre className="selectable px-3.5 py-2.5 font-mono text-[12px] whitespace-pre-wrap text-fg-2">{body}</pre>
            )}
            {notes.map((note) => (
              <DetailNote key={note}>{note}</DetailNote>
            ))}
          </RowDetail>
        )
      }
    />
  )
}

function PathRows({ paths }: { paths: string[] }) {
  const [all, setAll] = usePreviewExpanded('paths')
  const shown = all ? paths : paths.slice(0, LIST_LIMIT)
  return (
    <>
      <div className="py-1.5">
        {shown.map((p) => {
          const { dir, name } = splitPath(p.replace(/\\/g, '/').replace(/\/$/, ''))
          return (
            <div key={p} className="flex h-[26px] items-center gap-2 px-3.5 font-mono text-[12px]">
              <FileGlyph path={p} />
              <span className="selectable flex min-w-0">
                <span className="min-w-0 truncate text-fg-3">{dir}</span>
                <span className="shrink-0 text-fg-2">{name}</span>
              </span>
            </div>
          )
        })}
      </div>
      {paths.length > LIST_LIMIT && <ShowMore expanded={all} onToggle={() => setAll(!all)} hidden={paths.length - LIST_LIMIT} unit="paths" />}
    </>
  )
}

function PathListDetail({ phase, body, notes, empty, paths, emptyText }: { phase: ToolPhase; body: string; notes: string[]; empty: boolean; paths: string[]; emptyText: string }) {
  if (isActive(phase)) return null
  return (
    <RowDetail copy={body}>
      {phase === 'error' ? (
        <DetailNote tone="danger">{body || 'Failed'}</DetailNote>
      ) : empty ? (
        <DetailEmpty>{emptyText}</DetailEmpty>
      ) : (
        paths.length > 0 && <PathRows paths={paths} />
      )}
      {notes.map((note) => (
        <DetailNote key={note}>{note}</DetailNote>
      ))}
    </RowDetail>
  )
}

function FindRow(props: ToolRendererProps) {
  const { agentId, call, execution } = props
  const result = useSearchResult(agentId, props)
  const { phase, body, empty } = result
  const pattern = str(call.arguments.pattern) ?? ''
  const where = useDisplayPath(agentId, str(call.arguments.path))
  const toolsExpanded = useToolsExpanded()
  const [open] = useDisclosure(`tool:${call.id}`, toolsExpanded)
  const count = useMemo(() => (phase === 'done' && !empty ? countNonEmptyLines(body) : 0), [body, phase, empty])
  const paths = useMemo(() => (open && phase === 'done' && !empty ? body.split('\n').filter(Boolean) : []), [open, body, phase, empty])
  return (
    <ToolRow
      verb={isActive(phase) ? 'Finding' : 'Found'}
      subject={
        <>
          <MonoSubject className="shrink-0 text-fg">{pattern}</MonoSubject>
          <Scope where={where} />
        </>
      }
      meta={phase === 'done' ? <span>{empty ? 'no files' : plural(count, 'file')}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? firstLine(body) || 'Find failed' : undefined}
      sublineTone="danger"
      detail={<PathListDetail {...result} paths={paths} emptyText={`No files match “${pattern}”.`} />}
    />
  )
}

function LsRow(props: ToolRendererProps) {
  const { agentId, call, execution } = props
  const result = useSearchResult(agentId, props)
  const { phase, body, empty } = result
  const path = str(call.arguments.path) ?? '.'
  const toolsExpanded = useToolsExpanded()
  const [open] = useDisclosure(`tool:${call.id}`, toolsExpanded)
  const count = useMemo(() => (phase === 'done' && !empty ? countNonEmptyLines(body) : 0), [body, phase, empty])
  const entries = useMemo(() => (open && phase === 'done' && !empty ? body.split('\n').filter(Boolean) : []), [open, body, phase, empty])
  return (
    <ToolRow
      verb={isActive(phase) ? 'Listing' : 'Listed'}
      subject={<PathChip agentId={agentId} path={/[\\/]$/.test(path) ? path : `${path}/`} />}
      meta={phase === 'done' ? <span>{empty ? 'empty' : plural(count, 'entry', 'entries')}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? firstLine(body) || 'Listing failed' : undefined}
      sublineTone="danger"
      detail={<PathListDetail {...result} paths={entries} emptyText="This folder is empty." />}
    />
  )
}

registerToolRenderer('grep', GrepRow)
registerToolRenderer(['find', 'glob'], FindRow)
registerToolRenderer('ls', LsRow)
