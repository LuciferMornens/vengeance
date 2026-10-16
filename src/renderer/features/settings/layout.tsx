import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { RotateCcw, ShieldQuestion } from 'lucide-react'
import { runAction } from '../../lib/actions'
import { cn } from '../../lib/cn'
import { Button, Tooltip } from '../../ui'
import { useSettings } from './store'

/** Building blocks of every settings section: header, grouped cards, aligned rows. */

/**
 * Sticky 56px header of a full sheet's scroll column (Settings, Updates): an opaque surface matching the column, with
 * a hairline that only appears once content scrolls under it. Children are right-aligned actions. z-20 keeps it above
 * content that lifts itself to z-10 (segmented-control labels, sticky save bars).
 */
export function SheetHeader({ scrolled, children }: { scrolled: boolean; children: ReactNode }) {
  return (
    <div
      data-scrolled={scrolled || undefined}
      className="sticky top-0 z-20 flex h-14 items-center justify-end gap-2 border-b border-transparent bg-[color-mix(in_srgb,var(--surface-2)_40%,var(--surface-1))] px-4 transition-[border-color] duration-[var(--dur-fast)] data-[scrolled]:border-hairline-soft"
    >
      {children}
    </div>
  )
}

/** Active search query; rows mark matching text in their labels and descriptions. */
export const SearchQueryContext = createContext('')

export function Highlight({ text }: { text: string }) {
  const query = useContext(SearchQueryContext).trim()
  if (!query) return <>{text}</>
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-xs bg-accent-soft px-px text-accent-text">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

export function SectionHeader({
  icon,
  title,
  description,
  actions
}: {
  icon: ReactNode
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-7 flex items-start gap-4">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-card bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)] [&_svg]:size-[20px]">
        {icon}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <h2 className="heading text-xl font-semibold text-fg">{title}</h2>
        {description && (
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-fg-3">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 pt-1">{actions}</div>}
    </div>
  )
}

export function Group({
  title,
  description,
  actions,
  children,
  className
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('mb-7 last:mb-0', className)}>
      {(title || actions) && (
        <div className="mb-2.5 flex items-end gap-3 px-1">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-xs font-medium text-fg-3">{title}</h3>}
            {description && <p className="mt-1 text-sm text-fg-3">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className="overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)]">
        {children}
      </div>
    </section>
  )
}

export interface RowProps {
  label: ReactNode
  description?: ReactNode
  /** Setting key: anchors search jumps and shows the highlight pulse. */
  settingKey?: string
  /** Small badges next to the label (override indicators, global-only…). */
  badges?: ReactNode
  /** Reset to inherited/default (shown on hover when provided). */
  onReset?: () => void
  resetLabel?: string
  children?: ReactNode
  /** Full-width content under the label (lists, editors). */
  below?: ReactNode
  /** Control column alignment. */
  wide?: boolean
  dimmed?: boolean
  className?: string
}

export function Row({
  label,
  description,
  settingKey,
  badges,
  onReset,
  resetLabel = 'Reset to default',
  children,
  below,
  wide,
  dimmed,
  className
}: RowProps) {
  const highlight = useSettings((s) => s.highlight)
  const setHighlight = useSettings((s) => s.setHighlight)
  const ref = useRef<HTMLDivElement>(null)
  const active = !!settingKey && highlight === settingKey

  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => setHighlight(null), 2200)
    return () => clearTimeout(timer)
  }, [active, setHighlight])

  return (
    <div
      ref={ref}
      id={settingKey ? `setting-${settingKey}` : undefined}
      className={cn(
        'group/row relative border-b border-hairline-soft px-4 py-3.5 last:border-b-0',
        className
      )}
    >
      {active && (
        <motion.div
          className="pointer-events-none absolute inset-0 bg-info-soft shadow-[inset_2px_0_0_var(--info)]"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 2.2, times: [0, 0.1, 0.7, 1] }}
        />
      )}
      <div className={cn('relative flex items-center gap-6', dimmed && 'opacity-55')}>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 flex-wrap items-center gap-1.5">
            <span className="text-ui font-medium text-fg">
              {typeof label === 'string' ? <Highlight text={label} /> : label}
            </span>
            {badges}
            {onReset && (
              <Tooltip content={resetLabel}>
                <button
                  type="button"
                  aria-label={resetLabel}
                  onClick={onReset}
                  className="no-drag ml-0.5 flex size-5 items-center justify-center rounded-xs text-fg-3 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-hover hover:text-fg-2 focus-visible:opacity-100"
                >
                  <RotateCcw className="size-3" />
                </button>
              </Tooltip>
            )}
          </div>
          {description && (
            <div className="mt-0.5 max-w-[52ch] text-sm leading-snug text-fg-3">
              {typeof description === 'string' ? <Highlight text={description} /> : description}
            </div>
          )}
        </div>
        {children !== undefined && (
          <div
            className={cn(
              'flex shrink-0 items-center justify-end',
              wide ? 'w-[300px]' : 'min-w-[120px]'
            )}
          >
            {children}
          </div>
        )}
      </div>
      {below && <div className={cn('relative mt-3', dimmed && 'opacity-55')}>{below}</div>}
    </div>
  )
}

/** Monospace key reference, e.g. `compaction.reserveTokens`. */
export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-hover px-1 py-px font-mono text-[0.85em] text-fg-3">
      {children}
    </code>
  )
}

/** Empty / note line inside a group. */
export function Note({
  children,
  tone = 'neutral',
  icon
}: {
  children: ReactNode
  tone?: 'neutral' | 'warning' | 'info' | 'danger'
  icon?: ReactNode
}) {
  const tones = {
    neutral: 'text-fg-3',
    warning: 'text-warning',
    info: 'text-info',
    danger: 'text-danger'
  }
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 px-4 py-3 text-sm leading-relaxed [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        tones[tone]
      )}
    >
      {icon}
      <div className="min-w-0 flex-1 text-fg-2">{children}</div>
    </div>
  )
}

/** Inline callout above content (trust warnings, isolation notice). */
export function Callout({
  tone = 'info',
  icon,
  title,
  children,
  action
}: {
  tone?: 'info' | 'warning' | 'accent' | 'danger'
  icon: ReactNode
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  const tones = {
    info: 'bg-info-soft text-info',
    warning: 'bg-warning-soft text-warning',
    accent: 'bg-accent-softer text-accent-text',
    danger: 'bg-danger-soft text-danger'
  }
  return (
    <div className="mb-6 flex items-start gap-3 rounded-card bg-surface-2 p-3.5 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md [&_svg]:size-4',
          tones[tone]
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="text-ui font-medium text-fg">{title}</div>
        {children && <div className="mt-0.5 text-sm leading-relaxed text-fg-3">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

/**
 * Shown in Packages, Resources and MCP while the open project isn't trusted: the engine doesn't load (and these
 * sections don't list) the project's own items until it is. `items` names them ("project packages").
 */
export function UntrustedProjectCallout({ items }: { items: string }) {
  const project = useSettings((s) => s.snapshot?.project)
  if (!project || project.trust.effective) return null
  return (
    <Callout
      tone="info"
      icon={<ShieldQuestion />}
      title="This folder isn’t trusted yet"
      action={
        <Button size="sm" variant="secondary" onClick={() => runAction('workspace.trust')}>
          Trust this folder
        </Button>
      }
    >
      Sessions here start without the project’s own {items}, so they aren’t listed. Trust the folder
      to load and manage them.
    </Callout>
  )
}
