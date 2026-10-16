import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/cn'
import { Badge, Dialog, Tooltip, type DialogSize } from '../../ui'

/** Remaining-time ring for dialogs with a `timeout` (pi auto-resolves with a default when it expires). */
export function CountdownRing({ deadline, total }: { deadline: number; total: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [])
  const remaining = Math.max(0, deadline - now)
  const seconds = Math.ceil(remaining / 1000)
  const r = 10
  const c = 2 * Math.PI * r
  const urgent = remaining <= 5000
  const [startFraction] = useState(() => Math.min(1, Math.max(0, (deadline - Date.now()) / total)))
  const [startSeconds] = useState(() => Math.max(0, deadline - Date.now()) / 1000)
  return (
    <Tooltip content={`Continues with the default answer in ${seconds}s`} side="left">
      <span className="relative flex size-7 shrink-0 items-center justify-center" role="timer" aria-label={`${seconds} seconds left`}>
        <svg width="28" height="28" viewBox="0 0 28 28" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="14" cy="14" r={r} fill="none" stroke="var(--hairline)" strokeWidth="2" />
          <motion.circle
            cx="14"
            cy="14"
            r={r}
            fill="none"
            stroke={urgent ? 'var(--warning)' : 'var(--fg-3)'}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c * (1 - startFraction) }}
            animate={{ strokeDashoffset: c }}
            transition={{ duration: startSeconds, ease: 'linear' }}
          />
        </svg>
        <span className={cn('tabular text-2xs font-semibold tracking-tight', urgent ? 'text-warning' : 'text-fg-2')}>{seconds >= 100 ? `${Math.ceil(seconds / 60)}m` : seconds}</span>
      </span>
    </Tooltip>
  )
}

export interface DialogFrameProps {
  /** False while the dialog plays its exit animation (the request was answered or expired). */
  open: boolean
  title: string
  description?: ReactNode
  icon: ReactNode
  size: DialogSize
  /** "1 of 3" when several requests are waiting. */
  position?: { index: number; total: number }
  deadline?: { at: number; total: number }
  children?: ReactNode
  bodyClassName?: string
  footer?: ReactNode
  hint?: { combo: string; label: string }
  /** Esc / close. Return false to keep the dialog open (e.g. unsaved editor changes). */
  onDismiss(): boolean | void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

/**
 * Extension request dialogs on the shared Dialog presets (18vh anchor, standard widths). Outside clicks never
 * dismiss a blocking request; the title row carries the queue position and a neutral countdown ring.
 */
export function DialogFrame({ open, title, description, icon, size, position, deadline, children, bodyClassName, footer, hint, onDismiss, onKeyDown }: DialogFrameProps) {
  return (
    // Key events from the portalled dialog bubble through the React tree to this wrapper.
    <div onKeyDown={onKeyDown} className="contents">
      <Dialog
        open={open}
        onOpenChange={(next) => !next && onDismiss()}
        size={size}
        persistent
        hideClose
        icon={icon}
        title={
          <span className="flex items-start gap-3">
            <span className="min-w-0 flex-1 pt-[5px]">{title}</span>
            {position && position.total > 1 && (
              <Badge className="mt-1.5">
                {position.index} of {position.total}
              </Badge>
            )}
            {deadline && <CountdownRing deadline={deadline.at} total={deadline.total} />}
          </span>
        }
        description={description}
        hint={hint}
        footer={footer}
        bodyClassName={bodyClassName}
      >
        {children}
      </Dialog>
    </div>
  )
}

/** Renders `inline code` spans in plain extension text. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g)
  return (
    <span className="selectable whitespace-pre-wrap">
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="rounded-xs bg-hover px-1 py-px font-mono text-[0.9em] whitespace-nowrap text-fg shadow-[inset_0_0_0_1px_var(--hairline-soft)]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </span>
  )
}
