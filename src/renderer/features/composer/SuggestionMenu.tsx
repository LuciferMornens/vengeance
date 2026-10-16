import { useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { Kbd, listRowClass } from '../../ui'

export interface SuggestionItem {
  key: string
  icon: ReactNode
  /** Primary label; `indices` highlight fuzzy-matched characters. */
  title: string
  indices?: number[]
  /** Mono text right after the title (argument hints). */
  meta?: string
  description?: string
  /** Quiet source label at the right (friendly package name, "Project"). */
  scope?: string
  /** Tooltip of the source label (the technical package source). */
  scopeTitle?: string
  /** Kind suffix shown when the list is not grouped (filtered results). */
  kind?: string
  /** Group label (rendered when it changes between consecutive items). */
  group?: string
}

export function Highlight({ text, indices, className }: { text: string; indices?: number[]; className?: string }) {
  if (!indices || indices.length === 0) return <span className={className}>{text}</span>
  const set = new Set(indices)
  return (
    <span className={className}>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-accent-text">
            {ch}
          </span>
        ) : (
          ch
        )
      )}
    </span>
  )
}

interface SuggestionMenuProps {
  /** Label of an ungrouped list (filtered commands, files). Grouped lists label each group instead. */
  label: string
  items: SuggestionItem[]
  active: number
  onActiveChange(index: number): void
  onPick(index: number): void
  empty?: ReactNode
  hints: Array<{ combo: string; label: string }>
  /** Shown at the right of the label row (e.g. a loading spinner). */
  status?: ReactNode
}

const labelClass = 'flex h-7 items-end justify-between gap-3 px-2.5 pb-1.5 text-xs font-medium text-fg-3'

/** Floating, keyboard-driven suggestion list attached above the composer (focus stays in the textarea). */
export function SuggestionMenu({ label, items, active, onActiveChange, onPick, empty, hints, status }: SuggestionMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const grouped = items.length > 0 && items[0]!.group !== undefined

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.99, transition: { duration: 0.1 } }}
      transition={spring.smooth}
      className="absolute inset-x-0 bottom-full z-20 mb-1.5 origin-bottom overflow-hidden rounded-lg bg-[var(--glass-strong)] shadow-elev-2 backdrop-blur-xl backdrop-saturate-150"
      onMouseDown={(e) => e.preventDefault()}
      role="listbox"
      aria-label={label}
    >
      <div ref={listRef} className="max-h-[312px] overflow-y-auto p-1.5">
        {!grouped && (
          <div className={labelClass}>
            <span>{label}</span>
            {status}
          </div>
        )}
        {items.length === 0 && <div className="px-3 pt-4 pb-6 text-center text-sm text-fg-3">{empty}</div>}
        {items.map((item, index) => {
          const heading = item.group && item.group !== items[index - 1]?.group ? item.group : null
          const selected = index === active
          return (
            <div key={item.key}>
              {heading && <div className={cn(labelClass, index > 0 && 'mt-1')}>{heading}</div>}
              <div
                role="option"
                aria-selected={selected}
                data-index={index}
                onMouseMove={() => !selected && onActiveChange(index)}
                onClick={() => onPick(index)}
                className={cn(
                  listRowClass({ density: 'list' }),
                  'cursor-default',
                  // Keyboard position: the inset caret inside the row fill (same geometry as a selected row).
                  selected && 'before:absolute before:top-1.5 before:bottom-1.5 before:left-1 before:w-[2px] before:rounded-[1px] before:bg-accent'
                )}
              >
                <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline-soft)] [&_svg]:size-3.5', selected && 'text-fg-2')}>
                  {item.icon}
                </span>
                <span className="flex min-w-0 shrink-0 items-baseline gap-1.5">
                  <Highlight text={item.title} indices={item.indices} className="truncate font-medium text-fg" />
                  {item.meta && <span className="max-w-56 truncate font-mono text-xs text-fg-3">{item.meta}</span>}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-fg-3">{item.description}</span>
                {item.scope && (
                  <span className="max-w-32 shrink-0 truncate text-2xs text-fg-3" title={item.scopeTitle}>
                    {item.scope}
                  </span>
                )}
                {item.kind && <span className="shrink-0 text-2xs text-fg-4">{item.kind}</span>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex h-8 items-center gap-3.5 border-t border-hairline-soft px-3.5 text-2xs text-fg-3">
        {hints.map((hint) => (
          <span key={hint.label} className="inline-flex items-center gap-1.5">
            <Kbd combo={hint.combo} size="xs" />
            {hint.label}
          </span>
        ))}
      </div>
    </motion.div>
  )
}
