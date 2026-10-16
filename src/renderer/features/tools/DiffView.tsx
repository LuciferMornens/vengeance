import { memo, useMemo, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { TokenLine } from '../../ui/CodeView'
import { useHighlight, type CodeToken } from '../../ui/highlight'
import type { DiffModel, DiffRow } from './diff-model'
import { ShowMore, usePreviewExpanded } from './ToolRow'

/** Split highlighted tokens (or plain text) at word-change ranges and wrap the changed parts. */
function renderLine(
  text: string,
  tokens: CodeToken[] | undefined,
  words: Array<[number, number]> | undefined,
  wordClass: string
): ReactNode {
  if (!words || words.length === 0) return <TokenLine tokens={tokens} text={text} />
  const pieces = tokens ?? [{ content: text }]
  const out: ReactNode[] = []
  let pos = 0
  let key = 0
  for (const token of pieces) {
    const start = pos
    const end = pos + token.content.length
    let cursor = start
    while (cursor < end) {
      const inside = words.find(([a, b]) => cursor >= a && cursor < b)
      let next = end
      if (inside) next = Math.min(end, inside[1])
      else {
        const upcoming = words.find(([a]) => a > cursor)
        if (upcoming) next = Math.min(end, upcoming[0])
      }
      const content = token.content.slice(cursor - start, next - start)
      out.push(
        <span key={key++} className={cn(token.className, inside && wordClass) || undefined}>
          {content}
        </span>
      )
      cursor = next
    }
    pos = end
  }
  return out
}

export interface DiffViewProps {
  model: DiffModel
  /** Language for syntax highlighting (from the file path). */
  lang: string | null
  /** Highlight once ready; false while arguments still stream. */
  highlight?: boolean
  /** Show only the first rows with a "Show N more lines" toggle (the transcript never nests vertical scrollers). */
  previewRows?: number
  className?: string
}

/**
 * Unified diff: old/new line gutters, +/− signs, a quiet row tint with a colored edge, stronger word-level
 * emphasis, syntax colors. Scrolls horizontally only; long diffs fold behind "Show more" (`previewRows`).
 */
export const DiffView = memo(function DiffView({
  model,
  lang,
  highlight = true,
  previewRows,
  className
}: DiffViewProps) {
  const [expanded, setExpanded] = usePreviewExpanded('diff')
  // Tokenize each side once: old = context + deletions, new = context + additions.
  const { oldText, newText, sideIndex } = useMemo(() => {
    const oldLines: string[] = []
    const newLines: string[] = []
    const index: number[] = []
    for (const row of model.rows) {
      if (row.kind === 'del') {
        index.push(oldLines.length)
        oldLines.push(row.text)
      } else if (row.kind === 'add' || row.kind === 'ctx') {
        index.push(newLines.length)
        newLines.push(row.text)
      } else index.push(-1)
    }
    return { oldText: oldLines.join('\n'), newText: newLines.join('\n'), sideIndex: index }
  }, [model])
  const oldTokens = useHighlight(oldText, lang, highlight && oldText.length > 0)
  const newTokens = useHighlight(newText, lang, highlight)

  const width = useMemo(() => {
    let max = 1
    for (const row of model.rows) max = Math.max(max, row.oldNo ?? 0, row.newNo ?? 0)
    return `${String(max).length}ch`
  }, [model])

  const tokensFor = (row: DiffRow, i: number) => {
    const idx = sideIndex[i] ?? -1
    if (idx < 0) return undefined
    return row.kind === 'del' ? oldTokens?.[idx] : newTokens?.[idx]
  }

  const limit =
    previewRows !== undefined && !expanded && model.rows.length > previewRows + 4
      ? previewRows
      : model.rows.length
  const rows = limit < model.rows.length ? model.rows.slice(0, limit) : model.rows

  return (
    <div className={cn('font-mono text-[12px] leading-[1.6]', className)}>
      <div className="selectable overflow-x-auto">
        <div className="w-max min-w-full py-1.5">
          {rows.map((row, i) => {
            if (row.kind === 'gap') {
              return (
                <div
                  key={i}
                  className="my-1 flex h-6 items-center bg-[var(--hover)] text-[11px] text-fg-3 select-none"
                >
                  <span className="px-3">⋯</span>
                </div>
              )
            }
            const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
            return (
              <div
                key={i}
                className={cn(
                  'flex',
                  row.kind === 'add' &&
                    'bg-[var(--diff-add-bg)] shadow-[inset_2px_0_0_var(--diff-add-edge)]',
                  row.kind === 'del' &&
                    'bg-[var(--diff-del-bg)] shadow-[inset_2px_0_0_var(--diff-del-edge)]'
                )}
              >
                <span
                  aria-hidden
                  className="shrink-0 pr-2 pl-3 text-right text-[var(--diff-gutter)] tabular select-none"
                  style={{ width: `calc(${width} + 20px)` }}
                >
                  {row.oldNo ?? ''}
                </span>
                <span
                  aria-hidden
                  className="shrink-0 pr-2 text-right text-[var(--diff-gutter)] tabular select-none"
                  style={{ width: `calc(${width} + 8px)` }}
                >
                  {row.newNo ?? ''}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'w-5 shrink-0 text-center select-none',
                    row.kind === 'add' && 'text-[var(--syn-inserted)]',
                    row.kind === 'del' && 'text-[var(--syn-deleted)]',
                    row.kind === 'ctx' && 'text-fg-4'
                  )}
                >
                  {sign}
                </span>
                <span
                  className={cn(
                    'pr-4 whitespace-pre text-[var(--syn-fg)]',
                    row.kind === 'ctx' && 'opacity-80'
                  )}
                >
                  {renderLine(
                    row.text,
                    tokensFor(row, i),
                    row.words,
                    row.kind === 'add'
                      ? 'rounded-xs bg-[var(--diff-add-word)]'
                      : 'rounded-xs bg-[var(--diff-del-word)]'
                  )}
                  {row.text === '' && '\u200b'}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {limit < model.rows.length ||
      (expanded && previewRows !== undefined && model.rows.length > previewRows + 4) ? (
        <ShowMore
          expanded={expanded}
          onToggle={() => setExpanded(!expanded)}
          hidden={model.rows.length - (previewRows ?? 0)}
        />
      ) : null}
    </div>
  )
})

/** "+12 −3" change counts. */
export function DiffStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] tabular">
      <span className="text-[var(--syn-inserted)]">+{added}</span>
      <span className="text-[var(--syn-deleted)]">−{removed}</span>
    </span>
  )
}
