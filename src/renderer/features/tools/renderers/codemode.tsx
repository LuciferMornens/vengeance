import { useMemo } from 'react'
import { Ban, Check, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { NestedToolCallRecord, ToolCall } from '@shared/engine-types'
import { cn } from '../../../lib/cn'
import { formatCost, formatDuration } from '../../../lib/format'
import type { TranscriptEntry, ToolExecution } from '../../../store/agent-state'
import { useAgents } from '../../../store/agents'
import { Spinner } from '../../../ui'
import { CodeView } from '../../../ui/CodeView'
import { ToolCallContext } from '../disclosure'
import { getToolRenderer, registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailNote, DetailSection, MonoSubject, RowDetail, ShowMore, ToolGroupContext, ToolRow, usePreviewExpanded } from '../ToolRow'
import { baseName, firstLine, humanizeToolName, isActive, isRecord, num, payloadImages, payloadText, plural, records, resultPayload, str, toolPhase } from '../tool-utils'
import { ResultView } from './generic'

const SCRIPT_PREVIEW_LINES = 12
/** pi's result header: "Script completed|failed\nWall time N seconds\nOutput:\n" (dist/extensions/codemode/renderer.js). */
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n?/

type NestedStatus = 'running' | 'ok' | 'error' | 'cancelled'

/** One nested call, normalized from codemode `details.calls`, the result message's `nestedCalls`, or live events. */
interface NestedRow {
  id: string
  name: string
  args: string
  status: NestedStatus
  durationMs?: number
  error?: string
  cost?: number
}

/** `CodemodeToolDetails.calls` (dist/extensions/codemode/tool.d.ts), present on partial and final results. */
function rowsFromDetails(details: unknown): NestedRow[] | null {
  if (!isRecord(details) || !Array.isArray(details.calls)) return null
  return records(details.calls).map((c, i) => {
    const status = str(c.status)
    return {
      id: str(c.id) ?? String(i),
      name: str(c.name) ?? 'tool',
      args: str(c.args) ?? '',
      status: status === 'ok' || status === 'error' || status === 'cancelled' ? status : 'running',
      durationMs: num(c.durationMs),
      error: str(c.error),
      cost: num(c.cost)
    }
  })
}

/** `ToolResultMessage.nestedCalls` (pi-ai `NestedToolCalls`), recorded for any tool that used ctx.executeTool(). */
function rowsFromRecord(calls: NestedToolCallRecord[]): NestedRow[] {
  return calls.map((c) => ({
    id: c.id,
    name: c.name,
    args: c.arguments ? JSON.stringify(c.arguments) : c.argumentsBytes ? `${c.argumentsBytes} bytes` : '',
    status: c.status === 'unfinished' ? 'cancelled' : c.status,
    durationMs: c.durationMs,
    error: c.error
  }))
}

function rowFromExecution(tool: ToolExecution): NestedRow {
  const failed = tool.status === 'error'
  return {
    id: tool.toolCallId,
    name: tool.toolName,
    args: JSON.stringify(tool.args),
    status: tool.interrupted ? 'cancelled' : failed ? 'error' : tool.status === 'done' ? 'ok' : 'running',
    durationMs: tool.durationMs,
    error: failed ? payloadText(tool.result).slice(0, 500) : undefined
  }
}

/** `nestedCalls` of tool result messages, indexed once per entries array. */
const recordCache = new WeakMap<TranscriptEntry[], Map<string, NestedToolCallRecord[]>>()

function nestedRecords(entries: TranscriptEntry[]): Map<string, NestedToolCallRecord[]> {
  let map = recordCache.get(entries)
  if (!map) {
    map = new Map()
    for (const { message } of entries) {
      if (message.role === 'toolResult' && message.nestedCalls) map.set(message.toolCallId, message.nestedCalls.calls)
    }
    recordCache.set(entries, map)
  }
  return map
}

/** Live executions of the calls a tool made (tool_execution_* events carry `parentToolCallId`). */
function useChildExecutions(agentId: string, parentId: string): ToolExecution[] {
  return useAgents(
    useShallow((s) => {
      const tools = s.agents[agentId]?.tools
      return tools ? Object.values(tools).filter((t) => t.parentToolCallId === parentId) : []
    })
  )
}

function NestedGlyph({ status }: { status: NestedStatus }) {
  switch (status) {
    case 'running':
      return <Spinner size={12} className="text-fg-2" />
    case 'ok':
      return <Check className="size-3 text-fg-3" strokeWidth={2.5} aria-label="Done" />
    case 'error':
      return <X className="size-3 text-danger" strokeWidth={2.75} aria-label="Failed" />
    case 'cancelled':
      return <Ban className="size-3 text-fg-3" aria-label="Cancelled" />
  }
}

/** Compact 28px line for a nested call whose full execution is not in the store (history, or a dropped record). */
function NestedCallLine({ row }: { row: NestedRow }) {
  return (
    <div>
      <div className="flex h-7 min-w-0 items-center gap-2 text-sm">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <NestedGlyph status={row.status} />
        </span>
        <span className="shrink-0 font-medium text-fg">{humanizeToolName(row.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3" title={row.args}>
          {row.args}
        </span>
        {row.cost ? <span className="shrink-0 text-xs text-fg-3 tabular">{formatCost(row.cost)}</span> : null}
        <span className="w-11 shrink-0 text-right text-xs text-fg-3 tabular">{formatDuration(row.durationMs)}</span>
      </div>
      {row.error && <div className="selectable pb-1 pl-6 font-mono text-[11.5px] break-words text-danger">{row.error}</div>}
    </div>
  )
}

/** A nested call with a live execution: its own row (console, diff, preview in its detail), keyed for disclosure. */
function NestedCallView({ agentId, execution }: { agentId: string; execution: ToolExecution }) {
  const call = useMemo<ToolCall>(
    () => ({ type: 'toolCall', id: execution.toolCallId, name: execution.toolName, arguments: execution.args }),
    [execution.toolCallId, execution.toolName, execution.args]
  )
  const scope = useMemo(() => ({ call, execution }), [call, execution])
  const Renderer = getToolRenderer(call.name)
  return (
    <ToolCallContext.Provider value={scope}>
      <Renderer agentId={agentId} call={call} execution={execution} />
    </ToolCallContext.Provider>
  )
}

/** Script without the `// @options:` line, for the row subject. */
function firstStatement(code: string): string {
  return (
    code
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('// @options')) ?? ''
  )
}

/**
 * pi's `codemode` tool: one row for the script; its detail holds the JavaScript the model wrote, the calls the
 * script made (live rows while running, compact lines from the recorded `details.calls` / `nestedCalls`
 * afterwards) and the script output without the engine's "Script completed" header.
 */
function CodemodeRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const code = (str(call.arguments.code) ?? '').replace(/\r/g, '').trimEnd()
  const payload = resultPayload(execution)
  const children = useChildExecutions(agentId, call.id)
  const record = useAgents((s) => {
    const entries = s.agents[agentId]?.entries
    return entries ? nestedRecords(entries).get(call.id) : undefined
  })
  const rows = rowsFromDetails(payload?.details) ?? (record ? rowsFromRecord(record) : children.map(rowFromExecution))
  const byId = new Map(children.map((c) => [c.toolCallId, c]))
  const [scriptOpen, setScriptOpen] = usePreviewExpanded('script')

  const text = payloadText(execution?.result)
  const header = SCRIPT_HEADER.exec(text)
  const output = (header ? text.slice(header[0].length) : text).trim()
  const wall = header ? Number(header[2]) * 1000 : undefined
  const images = payloadImages(execution?.result)
  const fullOutputPath = isRecord(payload?.details) ? str(payload.details.fullOutputPath) : undefined
  const failed = phase === 'error'
  const cost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
  const lines = code ? code.split('\n') : []
  const folded = !scriptOpen && lines.length > SCRIPT_PREVIEW_LINES + 3
  const callsActive = rows.filter((r) => r.status === 'running').length
  const current = rows.find((r) => r.status === 'running')

  return (
    <ToolRow
      verb={isActive(phase) ? 'Running script' : 'Ran script'}
      subject={<MonoSubject>{firstStatement(code) || '\u2026'}</MonoSubject>}
      meta={
        <>
          {rows.length > 0 && <span>{isActive(phase) && callsActive > 0 ? `${rows.length - callsActive}/${rows.length} calls` : plural(rows.length, 'call')}</span>}
          {cost > 0 && <span>{formatCost(cost)}</span>}
        </>
      }
      phase={phase}
      durationMs={execution?.durationMs ?? wall}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(output) || 'Script failed' : isActive(phase) && current ? `${humanizeToolName(current.name)} \u00b7 ${current.args}` : undefined}
      sublineTone={failed ? 'danger' : 'neutral'}
      detail={
        <RowDetail copy={output || code}>
          {code && (
            <DetailSection label="Script">
              <div className="overflow-x-auto px-3 py-2">
                <CodeView
                  code={folded ? lines.slice(0, SCRIPT_PREVIEW_LINES).join('\n') : code}
                  lang="javascript"
                  highlight={phase !== 'streaming'}
                  lineNumbers
                  className={cn(folded && '[mask-image:linear-gradient(to_bottom,black_calc(100%-44px),transparent)]')}
                />
              </div>
              {lines.length > SCRIPT_PREVIEW_LINES + 3 && <ShowMore expanded={scriptOpen} onToggle={() => setScriptOpen(!scriptOpen)} hidden={lines.length - SCRIPT_PREVIEW_LINES} />}
            </DetailSection>
          )}
          {rows.length > 0 && (
            <DetailSection label="Tool calls">
              <ToolGroupContext.Provider value={null}>
                <div className="flex flex-col px-3.5 pt-1 pb-2">
                  {rows.map((row) => {
                    const live = byId.get(row.id)
                    return live ? <NestedCallView key={row.id} agentId={agentId} execution={live} /> : <NestedCallLine key={row.id} row={row} />
                  })}
                </div>
              </ToolGroupContext.Provider>
            </DetailSection>
          )}
          {(output || images.length > 0) && (
            <DetailSection label="Output">
              <ResultView text={output} images={images} error={failed} />
            </DetailSection>
          )}
          {fullOutputPath && <DetailNote>Output was truncated; the full output is saved in {baseName(fullOutputPath)}.</DetailNote>}
        </RowDetail>
      }
    />
  )
}

registerToolRenderer('codemode', CodemodeRow)
