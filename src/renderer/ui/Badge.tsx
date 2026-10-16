import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import { Spinner } from './Spinner'

/**
 * Semantic tones. `neutral` is the default for counts, scopes, tags and kinds; `accent` (soft ember) marks
 * something as *yours / new / highlighted*; success/warning/danger/info only when the meaning is semantic.
 */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

const tones: Record<Tone, string> = {
  neutral: 'bg-hover text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)]',
  accent: 'bg-accent-soft text-accent-text shadow-[inset_0_0_0_1px_var(--accent-border)]',
  success: 'bg-success-soft text-success shadow-[inset_0_0_0_1px_var(--success-border)]',
  warning: 'bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--warning-border)]',
  danger: 'bg-danger-soft text-danger shadow-[inset_0_0_0_1px_var(--danger-border)]',
  info: 'bg-info-soft text-info shadow-[inset_0_0_0_1px_var(--info-border)]'
}

/** Tone classes (background + text + hairline) for custom surfaces that need to match Badge/Chip/Pill. */
export const toneClass = (tone: Tone): string => tones[tone]

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  /** Leading status dot. */
  dot?: boolean
}

/** Small status label (counts, states): 18px, r4, sentence case — never uppercase or tracked. */
export function Badge({ tone = 'neutral', dot, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn('tabular inline-flex h-[18px] shrink-0 items-center gap-1 rounded-xs px-1.5 text-2xs leading-none font-semibold whitespace-nowrap', tones[tone], className)}
      {...props}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  )
}

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
  icon?: ReactNode
  onRemove?: () => void
  mono?: boolean
}

/** Token for files, models, queued messages, filters: 24px, r6; optionally removable. */
export function Chip({ tone = 'neutral', icon, onRemove, mono, className, children, ...props }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-sm px-2 text-sm font-medium [&_svg]:size-3.5 [&_svg]:shrink-0',
        mono && 'font-mono text-xs font-normal',
        tones[tone],
        onRemove && 'pr-1',
        className
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          className="flex size-4 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-active hover:text-fg"
        >
          <X className="!size-3" />
        </button>
      )}
    </span>
  )
}

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: Tone
  /** Leading indicator: a status dot (static), a live pulsing dot, or a spinner. */
  indicator?: 'dot' | 'live' | 'spinner'
  icon?: ReactNode
}

/**
 * Rounded status pill (titlebar activity, updates, counts): 24px, full radius. Neutral by default; clickable
 * pills get press feedback. Pass `tone="warning"` etc. only for semantic states.
 */
export const Pill = forwardRef<HTMLButtonElement, PillProps>(function Pill({ tone = 'neutral', indicator, icon, className, children, onClick, ...props }, ref) {
  const neutral = tone === 'neutral'
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        'pressable no-drag inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5',
        neutral
          ? 'bg-pill text-[var(--pill-fg)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-surface-4 hover:text-fg'
          : cn(tones[tone], 'hover:brightness-110'),
        indicator && 'pl-2',
        !onClick && 'pointer-events-none',
        className
      )}
      {...props}
    >
      {indicator === 'spinner' && <Spinner size={11} />}
      {indicator === 'dot' && <span className={cn('size-1.5 shrink-0 rounded-full', neutral ? 'bg-fg-3' : 'bg-current')} />}
      {indicator === 'live' && (
        <span className="relative flex size-1.5 shrink-0">
          <span className={cn('absolute inset-[-2px] animate-[v-pulse_1.6s_ease-in-out_infinite] rounded-full', neutral ? 'bg-accent-soft' : 'bg-current opacity-30')} />
          <span className={cn('relative size-1.5 rounded-full', neutral ? 'bg-accent' : 'bg-current')} />
        </span>
      )}
      {icon}
      {children}
    </button>
  )
})
