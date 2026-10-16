import { cn } from '../../../lib/cn'
import { useAgents } from '../../../store/agents'
import { CodeView } from '../../../ui/CodeView'
import { languageFromPath } from '../../../ui/highlight'
import { PathChip, useDisplayPath } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, RowDetail, ShowMore, ToolRow, usePreviewExpanded } from '../ToolRow'
import { fileErrorReason, isActive, lineCount, num, payloadImages, payloadText, resultPayload, splitTrailingNotes, str, toolPhase } from '../tool-utils'

const PREVIEW_LINES = 60

/** "L12–80" from offset/limit and the returned content (or the engine's "Showing lines" note). */
function lineRange(offset: number | undefined, returned: number, notes: string[]): string | null {
  for (const note of notes) {
    const shown = /Showing lines (\d+)-(\d+) of (\d+)/.exec(note)
    if (shown) return `L${shown[1]}\u2013${shown[2]} of ${Number(shown[3]).toLocaleString()}`
    const more = /^(\d+) more lines in file/.exec(note)
    if (more && returned) {
      const start = offset ?? 1
      return `L${start}\u2013${start + returned - 1} of ${(start + returned - 1 + Number(more[1])).toLocaleString()}`
    }
  }
  if (!returned) return offset ? `L${offset}` : null
  if (!offset || offset === 1) return returned === 1 ? '1 line' : `${returned.toLocaleString()} lines`
  return `L${offset}\u2013${offset + returned - 1}`
}

function ReadRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const path = str(call.arguments.path)
  const relative = useDisplayPath(agentId, path)
  const offset = num(call.arguments.offset)
  const payload = resultPayload(execution)
  const { body, notes } = splitTrailingNotes(payloadText(payload))
  const images = payloadImages(payload)
  const failed = phase === 'error'
  const imageOnly = images.length > 0 && /^Read image file/.test(body.trim())
  const returned = failed || imageOnly ? 0 : lineCount(body)
  const range = lineRange(offset, returned, notes)
  const [expanded, setExpanded] = usePreviewExpanded('content')
  const folded = !expanded && returned > PREVIEW_LINES + 10
  const shown = folded ? body.split('\n').slice(0, PREVIEW_LINES).join('\n') : body
  const thumb = images[0]
  return (
    <ToolRow
      verb={isActive(phase) ? 'Reading' : 'Read'}
      subject={
        <>
          <PathChip agentId={agentId} path={path} />
          {thumb && (
            <img
              src={`data:${thumb.mimeType};base64,${thumb.data}`}
              alt=""
              className="size-4 shrink-0 rounded-xs object-cover shadow-[0_0_0_1px_var(--hairline)]"
            />
          )}
        </>
      }
      meta={range && !failed ? <span>{range}</span> : imageOnly ? <span>Image</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? fileErrorReason(body, relative) || 'Read failed' : undefined}
      sublineTone="danger"
      detail={
        failed ? (
          <RowDetail copy={body} title={relative}>
            <DetailNote tone="danger">{body || 'Read failed'}</DetailNote>
          </RowDetail>
        ) : returned > 0 || images.length > 0 ? (
          <RowDetail copy={returned > 0 ? body : undefined} title={relative}>
            {images.map((image, i) => (
              <div key={i} className="flex justify-center bg-[var(--code-bg)] p-3">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt={relative || 'image'} className="max-h-80 rounded-md shadow-[0_0_0_1px_var(--hairline)]" />
              </div>
            ))}
            {returned > 0 && (
              <div className="overflow-x-auto bg-[var(--code-bg)] px-3 py-2.5">
                <CodeView
                  code={shown}
                  lang={languageFromPath(path)}
                  lineNumbers
                  startLine={offset ?? 1}
                  className={cn(folded && '[mask-image:linear-gradient(to_bottom,black_calc(100%-44px),transparent)]')}
                />
              </div>
            )}
            {returned > PREVIEW_LINES + 10 && <ShowMore expanded={expanded} onToggle={() => setExpanded(!expanded)} hidden={returned - PREVIEW_LINES} />}
            {notes.map((note) => (
              // "Use offset=N to continue" is advice for the model, not for the reader.
              <DetailNote key={note}>{note.replace(/\.?\s*Use offset=\d+ to continue\.?$/, '')}</DetailNote>
            ))}
          </RowDetail>
        ) : undefined
      }
    />
  )
}

registerToolRenderer('read', ReadRow)
