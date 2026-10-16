import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ban, Check, ChevronRight, X } from 'lucide-react'
import { stripAnsi } from '../../lib/ansi'
import { cn } from '../../lib/cn'
import { formatDuration } from '../../lib/format'
import { CodeView } from '../../ui/CodeView'
import { Collapse } from '../../ui/Collapse'
import { CopyButton } from '../../ui/CopyButton'
import { Spinner } from '../../ui'
import { useDisclosure, useToolCallId, useToolCallScope, useToolsExpanded } from './disclosure'
import { fitsJsonTree, JsonTree } from './JsonTree'
import { isActive, payloadText, resultPayload, type ToolPhase } from './tool-utils'

/** Lines of live output shown under a running shell row. */
const TAIL_LINES = 4
/** Live tail refreshes at most this often (ms): streaming output can arrive hundreds of times a second. */
const TAIL_THROTTLE_MS = 100

/** Ticking elapsed time for running tools. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, now - since)
  // Whole seconds while ticking: a live "0ms" reads as broken.
  return <>{elapsed < 60_000 ? `${Math.floor(elapsed / 1000)}s` : formatDuration(elapsed)}</>
}

const PHASE_LABEL: Record<ToolPhase, string> = {
  streaming: 'Preparing',
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  aborted: 'Stopped'
}

/** Live status: spinner while active, a quiet check when done, rose ✕ tile on failure, ⊘ when stopped. */
export function StatusGlyph({ phase }: { phase: ToolPhase }) {
  const label = PHASE_LABEL[phase]
  switch (phase) {
    case 'running':
    case 'streaming':
    case 'pending':
      return (
        <span role="img" aria-label={label} className="inline-flex">
          <Spinner size={13} className={phase === 'running' ? 'text-fg-2' : 'text-fg-4'} />
        </span>
      )
    case 'error':
      return (
        <span role="img" aria-label={label} className="inline-flex size-3.5 items-center justify-center rounded-xs bg-danger-soft text-danger">
          <X className="size-2.5" strokeWidth={3} />
        </span>
      )
    case 'aborted':
      return <Ban aria-label={label} className="size-3.5 text-fg-3" />
    default:
      return <Check aria-label={label} className="size-3.5 text-fg-3" strokeWidth={2.5} />
  }
}

/**
 * Activity-group facts the rows of one group share. `tailOwner` is the call allowed to show a live output
 * tail (the most recently started running shell); outside a group every running row owns its tail.
 */
export const ToolGroupContext = createContext<{ tailOwner: string | null } | null>(null)

function useOwnsTail(): boolean {
  const group = useContext(ToolGroupContext)
  const callId = useToolCallId()
  return group === null || (callId !== null && group.tailOwner === callId)
}

export type SublineTone = 'neutral' | 'danger' | 'warning'

export interface ToolRowProps {
  /** Settled glyph in place of the done check (an MCP server tile, a subagent action glyph). */
  icon?: ReactNode
  /** "Ran", "Read", "Searched the web": the past tense once settled, present tense while live. */
  verb: ReactNode
  /** Primary argument: path chip, command, pattern, query. */
  subject?: ReactNode
  /** Right-aligned facts: line range, `+12 −3`, match counts, chips. */
  meta?: ReactNode
  phase: ToolPhase
  durationMs?: number
  startedAt?: number
  /** One 18px line under the row (error reason, lens issue, live hint). */
  subline?: ReactNode
  sublineTone?: SublineTone
  /** Live output tail; rendered only while active and only when the group marks this row as the tail owner. */
  tail?: string
  /** Expandable detail well (usually a `RowDetail`); omit for rows with nothing more to show. */
  detail?: ReactNode
  /** Clicking opens the call's subject elsewhere (a subagent run in the inspector) instead of an inline detail. */
  onOpen?: () => void
  /** Buttons after the row (outside its click target): "Output", "Peek", "Steer". */
  actions?: ReactNode
  /** Disclosure key for rows that are not tool calls (transcript notices); tool rows key by call id. */
  disclosureKey?: string
}

/**
 * One tool call as a single 28px line: status glyph · verb · subject · meta · duration · disclosure chevron.
 * The detail opens on click (keyed by call id, so it survives unmounting) and follows the app-level
 * "expand tool output" switch (Ctrl+O) until the user toggles it.
 */
export function ToolRow({ icon, verb, subject, meta, phase, durationMs, startedAt, subline, sublineTone = 'neutral', tail, detail, onOpen, actions, disclosureKey }: ToolRowProps) {
  const callId = useToolCallId()
  const toolsExpanded = useToolsExpanded()
  const [open, setOpen] = useDisclosure(disclosureKey ?? (callId ? `tool:${callId}` : null), toolsExpanded)
  const ownsTail = useOwnsTail()
  const expandable = !onOpen && detail !== undefined && detail !== null && detail !== false
  const clickable = expandable || onOpen !== undefined
  const active = isActive(phase)
  const aborted = phase === 'aborted'
  const glyph = phase === 'done' && icon ? icon : <StatusGlyph phase={phase} />
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-3.5">{glyph}</span>
      <span className={cn('shrink-0 text-sm font-medium', aborted ? 'text-fg-3' : 'text-fg')}>{verb}</span>
      <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm', aborted ? 'text-fg-3' : 'text-fg-2')}>{subject}</span>
      {(meta || aborted) && (
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg-3 tabular">
          {meta}
          {aborted && <span>Stopped</span>}
        </span>
      )}
      <span className="w-11 shrink-0 text-right text-xs text-fg-3 tabular">
        {phase === 'running' && startedAt ? <Elapsed since={startedAt} /> : !active && durationMs !== undefined ? formatDuration(durationMs) : null}
      </span>
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-fg-4 transition-[transform,opacity,color] duration-[var(--dur-base)] ease-[var(--ease-out)]',
          clickable ? 'opacity-0 group-hover/row:opacity-100 group-hover/row:text-fg-2 group-focus-visible/row:opacity-100' : 'invisible',
          open && expandable && 'rotate-90 opacity-100'
        )}
      />
    </>
  )
  const rowClass = 'group/row flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-left'
  return (
    <div data-tool-row data-tool-phase={phase} className="flex min-w-0 flex-col">
      <div className="-mx-1.5 flex min-w-0 items-center gap-1">
        {clickable ? (
          <button
            type="button"
            aria-expanded={expandable ? open : undefined}
            onClick={() => (onOpen ? onOpen() : setOpen(!open))}
            className={cn(rowClass, 'flex-1 transition-colors duration-[var(--dur-instant)] hover:bg-hover')}
          >
            {content}
          </button>
        ) : (
          <div className={cn(rowClass, 'flex-1')}>{content}</div>
        )}
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {subline && (
        <div
          className={cn(
            'selectable truncate pl-6 text-xs leading-[18px]',
            sublineTone === 'danger' && 'text-danger',
            sublineTone === 'warning' && 'text-warning',
            sublineTone === 'neutral' && 'text-fg-3'
          )}
        >
          {subline}
        </div>
      )}
      {tail !== undefined && phase === 'running' && ownsTail && <LiveTail text={tail} />}
      {expandable && <Collapse open={open}>{detail}</Collapse>}
    </div>
  )
}

/** `value`, updated at most every `ms`; the latest value always lands. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = last.current + ms - Date.now()
    if (wait <= 0) {
      last.current = Date.now()
      setShown(value)
      return
    }
    const timer = setTimeout(() => {
      last.current = Date.now()
      setShown(value)
    }, wait)
    return () => clearTimeout(timer)
  }, [value, ms])
  return shown
}

/** The last few non-empty lines of a running command, on a hairline rail under its row. */
export function LiveTail({ text }: { text: string }) {
  const throttled = useThrottled(text, TAIL_THROTTLE_MS)
  const lines = stripAnsi(throttled)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .slice(-TAIL_LINES)
  if (lines.length === 0) return null
  return (
    <div
      data-live-tail
      aria-live="off"
      className="mt-0.5 mb-1 ml-[7px] border-l border-hairline pl-[15px] [mask-image:linear-gradient(to_bottom,transparent,black_14px)]"
    >
      <pre className="overflow-hidden py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-pre text-fg-3">{lines.join('\n')}</pre>
    </div>
  )
}

function ToolbarButton({ active, onClick, children }: { active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center rounded-sm px-1.5 text-xs font-medium transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg',
        active ? 'text-fg' : 'text-fg-3'
      )}
    >
      {children}
    </button>
  )
}

/** A titled part of a detail well, separated from the part above by a soft hairline. */
export function DetailSection({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('border-t border-hairline-soft first:border-t-0', className)}>
      <div className="px-3.5 pt-2.5 text-xs font-medium text-fg-3">{label}</div>
      {children}
    </div>
  )
}

/** Raw text of a row that is not a tool call (a transcript notice's message content). */
function RawText({ text }: { text: string }) {
  return (
    <div data-raw-view>
      <pre className="selectable px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{text.slice(0, 50_000)}</pre>
    </div>
  )
}

/** Arguments, result details and raw result text of the call being rendered. */
function RawView() {
  const scope = useToolCallScope()
  if (!scope) return null
  const payload = resultPayload(scope.execution)
  const text = payloadText(payload)
  const tree = (value: unknown) =>
    fitsJsonTree(value) ? (
      <JsonTree value={value as Record<string, unknown>} />
    ) : (
      <div className="px-3.5 py-2.5">
        <CodeView code={JSON.stringify(value, null, 2)} lang="json" />
      </div>
    )
  return (
    <div data-raw-view>
      <DetailSection label={`Arguments · ${scope.call.name}`}>{tree(scope.call.arguments)}</DetailSection>
      {payload?.details !== undefined && payload.details !== null && <DetailSection label="Details">{tree(payload.details)}</DetailSection>}
      {text && (
        <DetailSection label="Result text">
          <pre className="selectable px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{text.slice(0, 50_000)}</pre>
        </DetailSection>
      )}
    </div>
  )
}

export interface RowDetailProps {
  children: ReactNode
  /** Text the Copy button writes (the output, the diff); omit to hide Copy. */
  copy?: string | (() => string)
  /** Left side of the toolbar (e.g. the full path of a read file). */
  title?: ReactNode
  /** `bottom` keeps the newest output in view (shell output). */
  anchor?: 'top' | 'bottom'
  /** Extra toolbar buttons, before Copy. */
  actions?: ReactNode
  /** Rows that are not tool calls: the raw text behind the Raw toggle, and the key its open state is kept under. */
  raw?: { text: string; key: string }
}

/**
 * The expanded detail of a row: a recessed well clipped at 320px with its own scroll, and a toolbar with
 * Copy, Raw (arguments, details and raw text of the call) and Show all (lifts the clip to 70vh) when clipped.
 */
export function RowDetail({ children, copy, title, anchor = 'top', actions, raw: rawText }: RowDetailProps) {
  const scope = useToolCallScope()
  const key = rawText?.key ?? scope?.call.id ?? null
  const [raw, setRaw] = useDisclosure(key ? `raw:${key}` : null, false)
  const [all, setAll] = useDisclosure(key ? `all:${key}` : null, false)
  const [clipped, setClipped] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const content = contentRef.current
    if (!scroller || !content) return
    let atBottom = true
    const onScroll = () => {
      atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8
    }
    const measure = () => {
      setClipped(scroller.scrollHeight > scroller.clientHeight + 1)
      if (anchor === 'bottom' && atBottom && !raw) scroller.scrollTop = scroller.scrollHeight
    }
    measure()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    observer.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [anchor, raw])

  return (
    <div data-row-detail className="mx-1 mt-1 mb-2 overflow-hidden rounded-md border border-hairline-soft bg-surface-1">
      <div className="flex h-7 items-center gap-0.5 border-b border-hairline-soft pr-1 pl-3.5">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{title}</span>
        {!raw && actions}
        {copy !== undefined && !raw && <CopyButton value={copy} showLabel />}
        {(scope || rawText) && (
          <ToolbarButton active={raw} onClick={() => setRaw(!raw)}>
            Raw
          </ToolbarButton>
        )}
        {(clipped || all) && <ToolbarButton onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</ToolbarButton>}
      </div>
      <div ref={scrollRef} className={cn('overflow-auto overscroll-contain', all ? 'max-h-[70vh]' : 'max-h-[320px]')}>
        <div ref={contentRef}>{raw ? rawText ? <RawText text={rawText.text} /> : <RawView /> : children}</div>
      </div>
    </div>
  )
}

/** Monospace primary argument (command, pattern…) for a row subject. */
export function MonoSubject({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('min-w-0 truncate font-mono text-[12px] text-fg-2', className)}>
      {children}
    </span>
  )
}

/** Footnote line inside a detail well (truncation notes, error text…). */
export function DetailNote({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'danger' | 'warning' }) {
  return (
    <div
      className={cn(
        'selectable border-t border-hairline-soft px-3.5 py-2 text-xs break-words first:border-t-0',
        tone === 'neutral' && 'text-fg-3',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'warning' && 'text-warning'
      )}
    >
      {children}
    </div>
  )
}

/** Quiet placeholder inside a detail well ("No matches for …"). */
export function DetailEmpty({ children }: { children: ReactNode }) {
  return <div className="px-3.5 py-3 text-sm text-fg-3">{children}</div>
}

/** "Show all N lines" toggle used by truncated previews. */
export function ShowMore({ expanded, onToggle, hidden, unit = 'lines' }: { expanded: boolean; onToggle: () => void; hidden: number; unit?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-7 w-full items-center justify-center gap-1 border-t border-hairline-soft text-xs font-medium text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg"
    >
      {expanded ? 'Show less' : `Show ${hidden} more ${unit}`}
    </button>
  )
}

/** Open state of a detail's "show more" preview: keyed per call, fully open while tool output is expanded app-wide. */
export function usePreviewExpanded(part: string): [boolean, (open: boolean) => void] {
  const callId = useToolCallId()
  const toolsExpanded = useToolsExpanded()
  return useDisclosure(callId ? `more:${callId}:${part}` : null, toolsExpanded)
}
