import { useMemo } from 'react'
import { useAgents } from '../../../store/agents'
import { languageFromPath } from '../../../ui/highlight'
import { useDiffModule } from '../diff-lazy'
import { DiffStats, DiffView } from '../DiffView'
import type { DiffModel } from '../diff-model'
import { LensMeta, LensSection } from '../LensVerdict'
import { PathChip, useDisplayPath } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, RowDetail, ToolRow } from '../ToolRow'
import { diffStats, firstLine, isActive, isRecord, payloadText, records, resultPayload, splitLensVerdict, str, toolPhase } from '../tool-utils'

const PREVIEW_ROWS = 40
/** The engine's retry marker on edit errors ("\u{1F504} RETRYABLE \u2014 Edit without read: \u2026"), meant for the model. */
const RETRYABLE_PREFIX = /^\s*\u{1F504}?\s*RETRYABLE\s*[\u2014\u2013-]\s*/u

type Edit = { oldText: string; newText: string }

function editsOf(args: Record<string, unknown>): Edit[] {
  const list = records(args.edits).map((e) => ({ oldText: str(e.oldText) ?? '', newText: str(e.newText) ?? '' }))
  // Older single-edit shape.
  if (list.length === 0 && (typeof args.oldText === 'string' || typeof args.newText === 'string')) {
    list.push({ oldText: str(args.oldText) ?? '', newText: str(args.newText) ?? '' })
  }
  return list
}

function editModel(diff: NonNullable<ReturnType<typeof useDiffModule>>, patch: string | undefined, edits: Edit[]): DiffModel | null {
  return (patch ? diff.diffFromPatch(patch) : null) ?? (edits.length > 0 ? diff.diffFromEdits(edits) : null)
}

/** The diff in the open detail (mounted only while open): reuses the row's model, else builds it from the patch. */
function EditDiff({ model, patch, edits, path, streaming }: { model: DiffModel | null; patch: string | undefined; edits: Edit[]; path: string | undefined; streaming: boolean }) {
  const diff = useDiffModule()
  const shown = useMemo(() => model ?? (diff ? editModel(diff, patch, edits) : null), [model, diff, patch, edits])
  if (!shown) return null
  return <DiffView model={shown} lang={languageFromPath(path)} highlight={!streaming} previewRows={PREVIEW_ROWS} className="bg-[var(--code-bg)]" />
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
  const diff = useDiffModule()
  // A patch's +/− is what its diff shows, so the row counts it without building the diff (that waits for the detail).
  // Without one, the count is the diff of the edit arguments, the same diff the detail shows.
  const patchStats = useMemo(() => (patch ? diffStats(details) : null), [patch, details])
  const model = useMemo(() => (patchStats || !diff ? null : editModel(diff, patch, edits)), [patchStats, diff, patch, edits])
  const stats = patchStats ?? (model ? { added: model.added, removed: model.removed } : diffStats(details))
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
          <EditDiff model={model} patch={patch} edits={edits} path={path} streaming={phase === 'streaming'} />
          <LensSection lens={lens} />
        </RowDetail>
      }
    />
  )
}

registerToolRenderer('edit', EditRow)
