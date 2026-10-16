import './markdown.css'
import { memo, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CopyButton } from './CopyButton'
import { languageLabel, resolveLanguage, useHighlight, type CodeToken } from './highlight'

/** Render a highlighted line (or plain text when tokens are not ready). */
export function TokenLine({
  tokens,
  text
}: {
  tokens: CodeToken[] | undefined
  text: string
}): ReactNode {
  if (!tokens) return text
  return tokens.map((token, i) =>
    token.className ? (
      <span key={i} className={token.className}>
        {token.content}
      </span>
    ) : (
      token.content
    )
  )
}

export interface CodeViewProps {
  code: string
  /** Grammar id, alias or fence label (unknown → plain). */
  lang: string | null
  /** Highlight once ready; pass false while the code is still streaming. */
  highlight?: boolean
  lineNumbers?: boolean
  /** First line number shown in the gutter. */
  startLine?: number
  wrap?: boolean
  className?: string
  /** Extra class for each line row (e.g. hover tint). */
  lineClassName?: string
}

/** Monospace code with optional line-number gutter and lazy syntax highlighting. */
export const CodeView = memo(function CodeView({
  code,
  lang,
  highlight = true,
  lineNumbers = false,
  startLine = 1,
  wrap = false,
  className,
  lineClassName
}: CodeViewProps) {
  const tokens = useHighlight(code, lang, highlight)
  const lines = code.replace(/\n$/, '').split('\n')
  const gutterWidth = `${String(startLine + lines.length - 1).length + 1}ch`
  return (
    <pre
      className={cn(
        'selectable font-mono text-[12.5px] leading-[1.62] text-[var(--syn-fg)] [tab-size:2]',
        wrap ? 'break-words whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre',
        className
      )}
    >
      {lines.map((line, i) => (
        <div key={i} className={cn('flex', lineClassName)}>
          {lineNumbers && (
            <span
              aria-hidden
              className="shrink-0 pr-4 text-right text-fg-4 tabular select-none"
              style={{ width: gutterWidth, minWidth: gutterWidth, boxSizing: 'content-box' }}
            >
              {startLine + i}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <TokenLine tokens={tokens?.[i]} text={line} />
            {line === '' && '\u200b'}
          </span>
        </div>
      ))}
    </pre>
  )
})

export interface CodeBlockProps {
  code: string
  lang: string | null
  /** Still streaming: render plain (highlighting happens once the block is complete). */
  live?: boolean
  /** Quiet note in the header (e.g. why a diagram shows as source). */
  note?: string
  className?: string
}

/** Fenced code block: language label, copy button, horizontally scrolling highlighted body. */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  live,
  note,
  className
}: CodeBlockProps) {
  const known = resolveLanguage(lang)
  const label = known ? languageLabel(known) : lang ? lang : 'Text'
  return (
    <div
      className={cn(
        'group/code relative my-4 overflow-hidden rounded-card bg-[var(--code-bg)] shadow-[inset_0_0_0_1px_var(--hairline)]',
        className
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-hairline-soft pr-1.5 pl-3.5">
        <span className="text-xs font-medium text-fg-3">{label}</span>
        {note && <span className="truncate text-xs text-fg-3">· {note}</span>}
        <div className="flex-1" />
        <CopyButton
          value={code}
          label="Copy code"
          className="opacity-60 transition-opacity group-hover/code:opacity-100"
        />
      </div>
      <div className="overflow-x-auto px-3.5 py-3">
        <CodeView code={code} lang={lang} highlight={!live} />
      </div>
    </div>
  )
})
