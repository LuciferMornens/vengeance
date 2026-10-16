import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex h-5 items-center gap-2 px-0.5">
        <span className="min-w-0 truncate text-xs font-medium text-fg-3">{title}</span>
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Hairline well grouping rows/tiles. */
export function Well({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-card bg-surface-2 shadow-elev-1', className)}>{children}</div>
}

export function KeyValue({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-h-8 items-center gap-3 px-3 text-sm">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className={cn('tabular min-w-0 flex-1 truncate text-right text-fg', mono && 'font-mono text-xs')}>{children}</span>
    </div>
  )
}

/** Context fill tone: neutral, warning from 70 %, danger from 90 % (same thresholds as the chat gauge). */
export function usageTone(percent: number): string {
  if (percent >= 90) return 'var(--danger)'
  if (percent >= 70) return 'var(--warning)'
  return 'var(--fg-2)'
}

/** Thin horizontal meter. */
export function Meter({ value, max, tone = 'var(--fg-2)', className }: { value: number; max: number; tone?: string; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-hover shadow-[inset_0_0_0_1px_var(--hairline-soft)]', className)}>
      <motion.div className="h-full rounded-full" style={{ background: tone }} initial={false} animate={{ width: `${pct}%` }} transition={spring.smooth} />
    </div>
  )
}

export function TabEmpty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 pt-16 pb-10 text-center">
      <div className="mb-4 flex size-11 items-center justify-center rounded-card bg-surface-2 text-fg-3 shadow-elev-1 [&_svg]:size-5">{icon}</div>
      <div className="heading text-ui font-semibold text-fg">{title}</div>
      {children && <div className="mt-1.5 flex max-w-[260px] flex-col items-center text-sm leading-relaxed text-fg-3">{children}</div>}
    </div>
  )
}
