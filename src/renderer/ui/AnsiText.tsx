import { useMemo, type CSSProperties } from 'react'
import { parseAnsi } from '../lib/ansi'
import { cn } from '../lib/cn'

/** ANSI-colored text (bash output, extension widgets/statuses) rendered as styled React spans. */
export function AnsiText({ text, className, as: Tag = 'span' }: { text: string; className?: string; as?: 'span' | 'pre' | 'div' }) {
  const segments = useMemo(() => parseAnsi(text), [text])
  return (
    <Tag className={cn('selectable', className)}>
      {segments.map((s, i) => {
        if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline) return s.text
        const style: CSSProperties = {
          color: s.fg,
          backgroundColor: s.bg,
          fontWeight: s.bold ? 600 : undefined,
          opacity: s.dim ? 0.6 : undefined,
          fontStyle: s.italic ? 'italic' : undefined,
          textDecoration: s.underline ? 'underline' : undefined
        }
        return (
          <span key={i} style={style}>
            {s.text}
          </span>
        )
      })}
    </Tag>
  )
}
