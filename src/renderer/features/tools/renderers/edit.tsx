import { useMemo } from 'react'
import { useAgents } from '../../../store/agents'
import { languageFromPath } from '../../../ui/highlight'
import { useDiffModule } from '../diff-lazy'
import { DiffStats, DiffView } from '../DiffView'
import { useDisclosure, useToolsExpanded } from '../disclosure'
import { LensMeta, LensSection } from '../LensVerdict'
import { PathChip, useDisplayPath } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, RowDetail, ToolRow } from '../ToolRow'
import { diffStats, firstLine, isActive, isRecord, payloadText, records, resultPayload, splitLensVerdict, str, toolPhase } from '../tool-utils'

const PREVIEW_ROWS = 40
/** The engine's retry marker on edit errors ("\u{1F504} RETRYABLE \u2014 Edit without read: \u2026"), meant for the model. */
const RETRYABLE_PREFIX = /^\s*\u{1F504}?\s*RETRYABLE\s*[\u2014\u2013-]\s*/u

function editsOf(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const list = records(args.edits).map((e) => ({ oldText: str(e.oldText) ?? '', newText: str(e.newText) ?? '' }))
  // Older single-edit shape.
  if (list.length === 0 && (typeof args.oldText === 'string' || typeof args.newText === 'string')) {
    list.push({ oldText: str(args.oldText) ?? '', newText: str(args.newText) ?? '' })
  }
  return list
}

function EditRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const path = str(call.arguments.path)
  const relative = useDisplayPath(agentId, path)
  const payload = resultPayload(execution)
  const details = isRecord(payload?.details) ? payload.details : undefined
  const patch = str(details?.patch)
  const edits = useMemo(() => editsOf(call.arguments), [call.arguments])
  const detailsStats = useMemo(() => diffStats(details), [details])
  const toolsExpanded = useToolsExpanded()
  const [open] = useDisclosure(`tool:${call.id}`, toolsExpanded)
  const diff = useDiffModule()
  const model = useMemo(() => {
    if ((!open && detailsStats !== null) || !diff) return null
    return (patch ? diff.diffFromPatch(patch) : null) ?? (edits.length > 0 ? diff.diffFromEdits(edits) : null)
  }, [open, detailsStats, diff, patch, edits])
  const stats = model ? { added: model.added, removed: model.removed } : detailsStats
  const failed = phase === 'error'
  const { body: rawBody, lens } = useMemo(() => splitLensVerdict(payloadText(payload)), [payload])
  const body = failed ? rawBody.replace(RETRYABLE_PREFIX, '') : rawBody
  const issue = lens?.issues ? lens.firstIssue : undefined
  return (
    <ToolRow
      verb={isActive(phase) ? 'Editing' : 'Edited'}
      subject={<PathChip agentId={agentId} path={path} />}
      meta={
        <>
          {stats && !failed && <DiffStats added={stats.added} removed={stats.removed} />}
          <LensMeta lens={lens} />
        </>
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(body) || 'Edit failed' : issue}
      sublineTone="danger"
      detail={
        <RowDetail copy={patch ?? str(details?.diff) ?? body} title={relative}>
          {failed && <DetailNote tone="danger">{body || 'Edit failed'}</DetailNote>}
          {model && <DiffView model={model} lang={languageFromPath(path)} highlight={phase !== 'streaming'} previewRows={PREVIEW_ROWS} className="bg-[var(--code-bg)]" />}
          <LensSection lens={lens} />
        </RowDetail>
      }
    />
  )
}

registerToolRenderer('edit', EditRow)
