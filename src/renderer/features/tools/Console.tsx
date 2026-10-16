import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { ANSI_PALETTE, parseAnsi } from '../../lib/ansi'
import { cn } from '../../lib/cn'
import { usePreviewExpanded } from './ToolRow'

/** Output lines shown before "show earlier lines" when the console sits in a card of its own. */
const TAIL_LINES = 14

/** ANSI palette colors → themed console variables (`--ansi-0…15` in tools.css), so Bone gets a light palette. */
const PALETTE_VARS = new Map(ANSI_PALETTE.map((color, i) => [color, `var(--ansi-${i})`]))

function themed(color: string | undefined): string | undefined {
  return color === undefined ? undefined : (PALETTE_VARS.get(color) ?? color)
}

/** ANSI output with themed colors; text on a colored background (e.g. vitest's ` RUN ` tag) gets ink that contrasts. */
function ConsoleText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  const out: ReactNode[] = []
  segments.forEach((s, i) => {
    if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline) {
      out.push(s.text)
      return
    }
    const style: CSSProperties = {
      color: s.bg && !s.fg ? 'var(--console-ink)' : themed(s.fg),
      backgroundColor: themed(s.bg),
      fontWeight: s.bold ? 600 : undefined,
      opacity: s.dim ? 0.6 : undefined,
      fontStyle: s.italic ? 'italic' : undefined,
      textDecoration: s.underline ? 'underline' : undefined,
      borderRadius: s.bg ? 3 : undefined
    }
    out.push(
      <span key={i} style={style}>
        {s.text}
      </span>
    )
  })
  return <>{out}</>
}

export interface ConsoleProps {
  command: string
  output: string
  /** Streaming output: keeps the console scrolled to the newest line. */
  live?: boolean
  /** Placeholder when there is no output (e.g. "No output"). */
  empty?: string
  /** Prompt glyph before the command (`❯` for bash, `PS>` for PowerShell). */
  prompt?: string
  /** Output lines kept before "show earlier lines" (a row detail scrolls a longer tail itself). */
  tailLines?: number
  /** Own 300px scroll while live; off inside a row detail, whose well scrolls and anchors at the bottom. */
  bounded?: boolean
  className?: string
}

/**
 * Terminal well for shell runs: prompt glyph + command, ANSI-colored output (themed for Obsidian and Bone),
 * tail-truncated with "show earlier lines". Fully open while tool output is expanded app-wide.
 */
export function Console({ command, output, live, empty = 'No output', prompt = '❯', tailLines = TAIL_LINES, bounded = true, className }: ConsoleProps) {
  const [expanded, setExpanded] = usePreviewExpanded('console')
  const scrollRef = useRef<HTMLDivElement>(null)
  const trimmed = output.replace(/\s+$/, '')
  const lines = useMemo(() => (trimmed ? trimmed.split('\n') : []), [trimmed])
  const hidden = expanded ? 0 : Math.max(0, lines.length - tailLines)
  const shown = hidden > 0 ? lines.slice(hidden).join('\n') : trimmed
  const gutter = prompt.length > 1 ? 'pl-[30px]' : 'pl-[22px]'

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && live) el.scrollTop = el.scrollHeight
  }, [shown, live])

  return (
    <div className={cn('v-console font-mono text-[12px] leading-[1.6]', className)}>
      <div className="flex gap-2.5 px-3.5 pt-3 pb-1.5">
        <span className="shrink-0 text-[var(--console-prompt)] select-none">{prompt}</span>
        <span className="selectable min-w-0 break-words whitespace-pre-wrap text-[var(--console-fg)]">{command}</span>
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mx-3.5 mb-1 flex items-center gap-2 text-[11px] text-[var(--console-dim)] transition-colors hover:text-[var(--console-fg)]"
        >
          <span className="h-px w-4 bg-current opacity-40" />
          {hidden} earlier {hidden === 1 ? 'line' : 'lines'} · show all
        </button>
      )}
      <div ref={scrollRef} className={cn('overflow-x-auto px-3.5 pb-3', live && bounded && 'max-h-[300px] overflow-y-auto')}>
        {lines.length > 0 ? (
          <pre className={cn('selectable break-words whitespace-pre-wrap text-[var(--console-out)]', gutter)}>
            <ConsoleText text={shown} />
          </pre>
        ) : (
          <div className={cn('text-[var(--console-dim)] italic', gutter)}>{live ? '' : empty}</div>
        )}
        {live && <span className={cn('inline-block h-3.5 w-[7px] translate-y-[2px] animate-[v-caret_1s_ease-in-out_infinite] bg-[var(--console-fg)] opacity-70', prompt.length > 1 ? 'ml-[30px]' : 'ml-[22px]')} />}
      </div>
      {expanded && lines.length > tailLines && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mx-3.5 mb-2 text-[11px] text-[var(--console-dim)] transition-colors hover:text-[var(--console-fg)]"
        >
          Collapse output
        </button>
      )}
    </div>
  )
}
