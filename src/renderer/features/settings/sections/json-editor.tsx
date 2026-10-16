import { useMemo, useRef, type KeyboardEvent } from 'react'
import { createPatch } from 'diff'
import { AlertTriangle, CircleAlert, Info } from 'lucide-react'
import type { JsonObject, ValidationIssue } from '@shared/api/settings'
import { cn } from '../../../lib/cn'
import { TokenLine } from '../../../ui/CodeView'
import { useHighlight, type HighlightedLines } from '../../../ui/highlight'
// Defines the --syn-* syntax colors (both themes) even when no transcript has loaded the markdown chunk yet.
import '../../../ui/markdown.css'
import { diffFromPatch } from '../../tools/diff-model'
import { DiffStats, DiffView } from '../../tools/DiffView'
import { FOCUS_WITHIN_RING } from '../controls'

/** JSON editing with syntax colors, a line gutter, parse diagnostics and a highlighted diff for review. */

export interface JsonParseResult {
  data?: JsonObject
  error?: { message: string; line?: number }
}

export function formatJson(data: JsonObject): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

export function parseJsonText(text: string): JsonParseResult {
  if (!text.trim()) return { data: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { error: { message: 'The file must contain a JSON object.' } }
    return { data: parsed as JsonObject }
  } catch (error) {
    const message = (error as Error).message
    const position = /position (\d+)/.exec(message)
    const line = position ? text.slice(0, Number(position[1])).split('\n').length : undefined
    return { error: { message: message.replace(/^JSON\.parse: /, ''), line } }
  }
}

export interface JsonEditorProps {
  text: string
  onChange: (text: string) => void
  /** 1-based line to flag in the gutter. */
  errorLine?: number
  height?: number
  readOnly?: boolean
  'aria-label'?: string
}

/**
 * Tokens for the editor's highlight layer. While a keystroke is being re-tokenized, the previous result is
 * kept so colors never blink off; lines whose text no longer matches render plain until it lands.
 */
function useEditorHighlight(text: string): HighlightedLines | null {
  const fresh = useHighlight(text, 'json')
  const last = useRef<HighlightedLines | null>(null)
  if (fresh) last.current = fresh
  return fresh ?? last.current
}

function tokensFor(
  lines: HighlightedLines | null,
  index: number,
  text: string
): HighlightedLines[number] | undefined {
  const tokens = lines?.[index]
  return tokens && tokens.map((t) => t.content).join('') === text ? tokens : undefined
}

/** Shared metrics of the textarea and its highlight layer: they must line up glyph for glyph. */
const EDITOR_TEXT = 'px-3.5 py-3 font-mono text-xs leading-[20px] whitespace-pre'

export function JsonEditor({
  text,
  onChange,
  errorLine,
  height = 420,
  readOnly,
  ...rest
}: JsonEditorProps) {
  const gutter = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLPreElement>(null)
  const textLines = text.split('\n')
  const lines = textLines.length
  const highlighted = useEditorHighlight(text)

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || readOnly) return
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart, selectionEnd } = el
    const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`
    onChange(next)
    requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2))
  }

  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-card bg-surface-1 shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-sm)]',
        FOCUS_WITHIN_RING
      )}
      style={{ height }}
    >
      <div
        ref={gutter}
        aria-hidden
        className="w-11 shrink-0 overflow-hidden border-r border-hairline-soft bg-surface-2/60 py-3 text-right font-mono text-xs leading-[20px] text-fg-4 select-none"
      >
        {Array.from({ length: lines }, (_, i) => (
          <div
            key={i}
            className={cn('pr-2.5', errorLine === i + 1 && 'bg-danger-soft text-danger')}
          >
            {i + 1}
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <pre
          ref={layer}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 m-0 overflow-hidden text-[var(--syn-fg)]',
            EDITOR_TEXT
          )}
        >
          {textLines.map((line, i) => (
            <div key={i} className="min-h-[20px]">
              <TokenLine tokens={tokensFor(highlighted, i, line)} text={line} />
            </div>
          ))}
        </pre>
        <textarea
          aria-label={rest['aria-label'] ?? 'JSON'}
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget
            if (gutter.current) gutter.current.scrollTop = scrollTop
            if (layer.current) {
              layer.current.scrollTop = scrollTop
              layer.current.scrollLeft = scrollLeft
            }
          }}
          className={cn(
            'selectable absolute inset-0 size-full resize-none bg-transparent text-transparent caret-fg outline-none',
            EDITOR_TEXT
          )}
        />
      </div>
    </div>
  )
}

const SEVERITY = {
  error: { icon: CircleAlert, className: 'text-danger' },
  warning: { icon: AlertTriangle, className: 'text-warning' },
  info: { icon: Info, className: 'text-info' }
} as const

export function IssueList({
  issues,
  parseError
}: {
  issues: ValidationIssue[]
  parseError?: JsonParseResult['error']
}) {
  if (!parseError && issues.length === 0) return null
  return (
    <div className="mt-3 overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
      {parseError && (
        <div className="flex items-start gap-2.5 border-b border-hairline-soft px-3.5 py-2.5 text-sm last:border-b-0">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <span className="text-fg-2">
            {parseError.line && (
              <span className="mr-1.5 font-mono text-xs text-danger">line {parseError.line}</span>
            )}
            {parseError.message}
          </span>
        </div>
      )}
      {issues.map((issue, i) => {
        const { icon: Icon, className } = SEVERITY[issue.severity]
        return (
          <div
            key={i}
            className="flex items-start gap-2.5 border-b border-hairline-soft px-3.5 py-2.5 text-sm last:border-b-0"
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', className)} />
            <span className="min-w-0 text-fg-2">
              {issue.key && <code className="mr-1.5 font-mono text-xs text-fg-3">{issue.key}</code>}
              {issue.message}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Two lines of context around changes, like a review diff. */
const DIFF_CONTEXT = 2

/** Review of an edited settings file: unified diff with JSON syntax colors and word-level emphasis. */
export function JsonDiff({
  before,
  after,
  maxHeight = 420
}: {
  before: string
  after: string
  maxHeight?: number
}) {
  const model = useMemo(() => {
    const patch = createPatch(
      'settings.json',
      before.replace(/\n?$/, '\n'),
      after.replace(/\n?$/, '\n'),
      '',
      '',
      { context: DIFF_CONTEXT }
    )
    return diffFromPatch(patch)
  }, [before, after])
  return (
    <div className="overflow-hidden rounded-card bg-surface-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="flex items-center gap-3 border-b border-hairline-soft px-3.5 py-2 text-xs text-fg-3">
        <DiffStats added={model?.added ?? 0} removed={model?.removed ?? 0} />
      </div>
      <div className="overflow-auto" style={{ maxHeight }}>
        {model ? (
          <DiffView model={model} lang="json" />
        ) : (
          <div className="px-3.5 py-3 text-sm text-fg-3">No changes.</div>
        )}
      </div>
    </div>
  )
}
