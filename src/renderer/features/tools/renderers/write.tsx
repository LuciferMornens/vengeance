import { useMemo } from 'react'
import { cn } from '../../../lib/cn'
import { platform } from '../../../lib/ipc'
import { useAgents } from '../../../store/agents'
import { CodeView } from '../../../ui/CodeView'
import { languageFromPath } from '../../../ui/highlight'
import { useDisclosure, useToolsExpanded } from '../disclosure'
import { LensMeta, LensSection } from '../LensVerdict'
import { PathChip, useDisplayPath } from '../PathChip'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, RowDetail, ShowMore, ToolRow, usePreviewExpanded } from '../ToolRow'
import { firstLine, isActive, normalizePath, payloadText, plural, resultPayload, splitLensVerdict, str, toolPhase } from '../tool-utils'

const PREVIEW_LINES = 60

function countLines(text: string): number {
  if (!text) return 0
  const end = text.endsWith('\n') ? text.length - 1 : text.length
  let lines = 1
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) lines++
  }
  return lines
}

/** Whether an earlier read/edit/write in this session touched the same path (→ rewrite, not a new file). */
function touchedBefore(agentId: string, callId: string, path: string | undefined): boolean {
  if (!path) return false
  const tools = useAgents.getState().agents[agentId]?.tools
  if (!tools) return false
  const windows = platform.os === 'win32'
  const target = normalizePath(path, windows)
  for (const id in tools) {
    if (id === callId) return false
    const tool = tools[id]
    if (
      tool &&
      (tool.toolName === 'read' || tool.toolName === 'edit' || tool.toolName === 'write') &&
      typeof tool.args.path === 'string' &&
      normalizePath(tool.args.path, windows) === target
    )
      return true
  }
  return false
}

function WriteRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const path = str(call.arguments.path)
  const relative = useDisplayPath(agentId, path)
  const content = str(call.arguments.content) ?? ''
  // The path can still be streaming in when the row first renders; only calls before this one count, so it never flips later.
  const rewrite = useMemo(() => touchedBefore(agentId, call.id, path), [agentId, call.id, path])
  const toolsExpanded = useToolsExpanded()
  const [open] = useDisclosure(`tool:${call.id}`, toolsExpanded)
  const [expanded, setExpanded] = usePreviewExpanded('content')
  const streaming = phase === 'streaming'
  const lines = useMemo(() => countLines(content), [content])
  const failed = phase === 'error'
  const payload = resultPayload(execution)
  const { body, lens } = useMemo(() => splitLensVerdict(payloadText(payload)), [payload])
  const folded = !streaming && !expanded && lines > PREVIEW_LINES + 10
  const visible = useMemo(() => {
    if (!open) return ''
    return folded ? content.split('\n').slice(0, PREVIEW_LINES).join('\n') : content
  }, [open, folded, content])
  return (
    <ToolRow
      verb={isActive(phase) ? 'Writing' : rewrite ? 'Wrote' : 'Created'}
      subject={<PathChip agentId={agentId} path={path} />}
      meta={
        <>
          {lines > 0 && <span>{plural(lines, 'line')}</span>}
          <LensMeta lens={lens} />
        </>
      }
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(body) || 'Write failed' : lens?.issues ? lens.firstIssue : undefined}
      sublineTone="danger"
      detail={
        <RowDetail copy={content} title={relative}>
          {failed && <DetailNote tone="danger">{body || 'Write failed'}</DetailNote>}
          {content && (
            <div className="overflow-x-auto bg-[var(--code-bg)] px-3 py-2.5">
              <CodeView
                code={visible}
                lang={languageFromPath(path)}
                highlight={!streaming}
                lineNumbers
                className={cn(folded && '[mask-image:linear-gradient(to_bottom,black_calc(100%-44px),transparent)]')}
              />
            </div>
          )}
          {!streaming && lines > PREVIEW_LINES + 10 && <ShowMore expanded={expanded} onToggle={() => setExpanded(!expanded)} hidden={lines - PREVIEW_LINES} />}
          <LensSection lens={lens} />
        </RowDetail>
      }
    />
  )
}

registerToolRenderer('write', WriteRow)
