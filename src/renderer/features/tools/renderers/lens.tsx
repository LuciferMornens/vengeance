import type { ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import type { ToolExecution } from '../../../store/agent-state'
import { useAgents } from '../../../store/agents'
import { FileGlyph, PathChip, useAgentCwd } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailEmpty, DetailNote, DetailSection, MonoSubject, RowDetail, ToolRow } from '../ToolRow'
import {
  baseName,
  bool,
  detailsOf,
  displayPath,
  firstLine,
  isActive,
  num,
  payloadText,
  plural,
  records,
  resultPayload,
  str,
  strings,
  toolPhase,
  type ToolPhase
} from '../tool-utils'
import { ResultView } from './generic'

/**
 * pi-lens code-intelligence tools (dist/index.js): diagnostics, symbol reads, module maps, LSP navigation,
 * structural search and diagnostic marks. Each is one row whose meta carries the verdict; the detail lists
 * outcomes and locations instead of JSON.
 */

function useLensPhase(agentId: string, execution: ToolExecution | undefined): ToolPhase {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  return toolPhase(execution, running)
}

/** Result text as markdown/text/JSON tree, for the parts of a detail that have no structured shape. */
function TextDetail({ execution }: { execution: ToolExecution | undefined }) {
  const text = payloadText(resultPayload(execution))
  return text ? <ResultView text={text} images={[]} /> : null
}

function failureLine(execution: ToolExecution | undefined, fallback: string): string {
  return firstLine(payloadText(resultPayload(execution))) || fallback
}

function LocationList({ items }: { items: Array<{ path: string; label?: ReactNode }> }) {
  return (
    <div className="py-1.5">
      {items.map((item, i) => (
        <div key={`${item.path}:${i}`} className="flex h-[26px] min-w-0 items-center gap-2 px-3.5 font-mono text-[12px]">
          <FileGlyph path={item.path} />
          <span className="selectable min-w-0 truncate text-fg-2">{item.path}</span>
          {item.label && <span className="ml-auto shrink-0 font-sans text-xs text-fg-3 tabular">{item.label}</span>}
        </div>
      ))}
    </div>
  )
}

const OUTCOME_LABEL: Record<string, { label: string; tone?: 'danger' | 'warning' }> = {
  clean: { label: 'clean' },
  issues: { label: 'issues', tone: 'danger' },
  unconfirmed: { label: 'unconfirmed', tone: 'warning' },
  timeout: { label: 'timed out', tone: 'warning' },
  timedOut: { label: 'timed out', tone: 'warning' }
}

function DiagnosticsRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const cwd = useAgentCwd(agentId)
  const details = detailsOf(execution)
  const paths = strings(call.arguments.paths)
  const filesChecked = num(details?.filesChecked) ?? paths.length
  const total = num(details?.totalDiagnostics) ?? 0
  const unconfirmed = num(details?.unconfirmedFiles) ?? 0
  const outcomes = records(details?.outcomes)
  const diagnostics = records(details?.diagnostics)
  const scope = str(call.arguments.scope)
  const subject = paths.length === 1 ? baseName(paths[0]!) : paths.length > 1 ? plural(paths.length, 'file') : scope === 'workspace' || !scope ? 'workspace' : scope
  const done = phase === 'done'
  return (
    <ToolRow
      verb={isActive(phase) ? 'Checking' : 'Checked'}
      subject={<span className="min-w-0 truncate">{subject}</span>}
      meta={
        done ? (
          <>
            {filesChecked > 0 && paths.length === 0 && <span>{plural(filesChecked, 'file')}</span>}
            {total > 0 ? <span className="font-medium text-danger">{plural(total, 'issue')}</span> : unconfirmed === 0 && <span>clean</span>}
            {unconfirmed > 0 && <span className="text-warning">{unconfirmed} unconfirmed</span>}
          </>
        ) : null
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Check failed') : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={payloadText(resultPayload(execution))}>
            {diagnostics.length > 0 && (
              <DetailSection label="Issues">
                <LocationList
                  items={diagnostics.slice(0, 80).map((d) => ({
                    path: `${displayPath(str(d.file) ?? str(d.path) ?? '', cwd)}${num(d.line) !== undefined ? `:${num(d.line)}` : ''}`,
                    label: str(d.message)?.slice(0, 80)
                  }))}
                />
              </DetailSection>
            )}
            {outcomes.length > 0 ? (
              <DetailSection label="Files">
                <LocationList
                  items={outcomes.map((o) => {
                    const outcome = OUTCOME_LABEL[str(o.outcome) ?? ''] ?? { label: str(o.outcome) ?? '' }
                    return {
                      path: displayPath(str(o.file) ?? '', cwd),
                      label: <span className={cn(outcome.tone === 'danger' && 'text-danger', outcome.tone === 'warning' && 'text-warning')}>{outcome.label}</span>
                    }
                  })}
                />
              </DetailSection>
            ) : (
              diagnostics.length === 0 && <TextDetail execution={execution} />
            )}
          </RowDetail>
        )
      }
    />
  )
}

function ReadSymbolRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const details = detailsOf(execution)
  const symbol = str(call.arguments.symbol) ?? str(details?.name) ?? ''
  const path = str(call.arguments.path)
  const start = num(details?.startLine)
  const end = num(details?.endLine)
  const found = bool(details?.found)
  return (
    <ToolRow
      verb={isActive(phase) ? 'Reading' : 'Read symbol'}
      subject={
        <>
          <MonoSubject className="shrink-0 text-fg">{symbol}</MonoSubject>
          {path && <span className="min-w-0 truncate text-xs text-fg-3">{baseName(path)}</span>}
        </>
      }
      meta={phase === 'done' ? found === false ? <span className="text-warning">not found</span> : start !== undefined ? <span>{end !== undefined ? `L${start}\u2013${end}` : `L${start}`}</span> : null : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Read failed') : undefined}
      sublineTone="danger"
      detail={isActive(phase) ? undefined : <RowDetail copy={payloadText(resultPayload(execution))}>{<TextDetail execution={execution} />}</RowDetail>}
    />
  )
}

function ModuleReportRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const details = detailsOf(execution)
  const symbols = num(details?.symbols)
  const exported = num(details?.exports)
  const available = bool(details?.available)
  return (
    <ToolRow
      verb={isActive(phase) ? 'Mapping' : 'Mapped'}
      subject={<PathChip agentId={agentId} path={str(call.arguments.path)} />}
      meta={
        phase === 'done' ? (
          available === false ? (
            <span className="text-warning">unavailable</span>
          ) : (
            <>
              {symbols !== undefined && <span>{plural(symbols, 'symbol')}</span>}
              {exported !== undefined && <span>{exported} exported</span>}
            </>
          )
        ) : null
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Mapping failed') : undefined}
      sublineTone="danger"
      detail={isActive(phase) ? undefined : <RowDetail copy={payloadText(resultPayload(execution))}>{<TextDetail execution={execution} />}</RowDetail>}
    />
  )
}

/** lsp_navigation's text is a JSON body followed by `result ok` / `usage tokens=…` engine lines. */
function navigationBody(text: string): string {
  return text.replace(/\n(result \w+|usage tokens=.*)\s*$/gm, '').trim()
}

function NavigationRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const details = detailsOf(execution)
  const operation = str(call.arguments.operation) ?? str(details?.operation) ?? ''
  const query = str(call.arguments.query) ?? (str(call.arguments.path) ? baseName(str(call.arguments.path)!) : '')
  const count = num(details?.resultCount)
  const supported = bool(details?.supported)
  const text = navigationBody(payloadText(resultPayload(execution)))
  return (
    <ToolRow
      verb={isActive(phase) ? 'Navigating' : 'Found'}
      subject={
        <MonoSubject>
          {operation} {query}
        </MonoSubject>
      }
      meta={phase === 'done' ? supported === false ? <span className="text-warning">unsupported</span> : count !== undefined ? <span>{plural(count, 'result')}</span> : null : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Navigation failed') : undefined}
      sublineTone="danger"
      detail={isActive(phase) ? undefined : <RowDetail copy={text}>{text ? <ResultView text={text} images={[]} /> : <DetailEmpty>No results.</DetailEmpty>}</RowDetail>}
    />
  )
}

function AstSearchRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const cwd = useAgentCwd(agentId)
  const details = detailsOf(execution)
  const count = num(details?.totalMatches) ?? num(details?.matchCount)
  const truncated = bool(details?.truncated)
  const locations = records(details?.matchLocations)
  return (
    <ToolRow
      verb={isActive(phase) ? 'Matching' : 'Matched'}
      subject={<MonoSubject className="text-fg">{str(call.arguments.pattern) ?? ''}</MonoSubject>}
      meta={phase === 'done' && count !== undefined ? <span>{count === 0 ? 'no matches' : `${plural(count, 'match', 'matches')}${truncated ? '+' : ''}`}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Search failed') : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={payloadText(resultPayload(execution))}>
            {locations.length > 0 ? (
              <LocationList
                items={locations.map((l) => ({
                  path: `${displayPath(str(l.file) ?? str(l.path) ?? '', cwd)}${num(l.line) !== undefined ? `:${num(l.line)}` : ''}`
                }))}
              />
            ) : (
              <TextDetail execution={execution} />
            )}
          </RowDetail>
        )
      }
    />
  )
}

const DISPOSITION_LABEL: Record<string, string> = {
  false_positive: 'false positive',
  'false-positive': 'false positive',
  wont_fix: "won't fix",
  accepted: 'accepted',
  fixed: 'fixed'
}

function DiagnosticMarkRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = useLensPhase(agentId, execution)
  const details = detailsOf(execution)
  const file = str(call.arguments.filePath) ?? str(call.arguments.path) ?? ''
  const line = num(call.arguments.line) ?? num(details?.line)
  const disposition = str(call.arguments.disposition) ?? str(details?.disposition) ?? ''
  const reason = str(call.arguments.reason)
  return (
    <ToolRow
      verb={isActive(phase) ? 'Marking' : 'Marked'}
      subject={
        <MonoSubject>
          {baseName(file)}
          {line !== undefined ? `:${line}` : ''}
        </MonoSubject>
      }
      meta={disposition ? <span>{DISPOSITION_LABEL[disposition] ?? disposition.replace(/[_-]+/g, ' ')}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? failureLine(execution, 'Mark failed') : undefined}
      sublineTone="danger"
      detail={
        isActive(phase) ? undefined : (
          <RowDetail copy={payloadText(resultPayload(execution))}>
            {str(call.arguments.message) && <DetailNote>{str(call.arguments.message)}</DetailNote>}
            {reason && <DetailNote>{reason}</DetailNote>}
            <TextDetail execution={execution} />
          </RowDetail>
        )
      }
    />
  )
}

registerToolRenderer('lens_diagnostics', DiagnosticsRow)
registerToolRenderer('read_symbol', ReadSymbolRow)
registerToolRenderer('module_report', ModuleReportRow)
registerToolRenderer('lsp_navigation', NavigationRow)
registerToolRenderer('ast_grep_search', AstSearchRow)
registerToolRenderer('lens_diagnostic_mark', DiagnosticMarkRow)
