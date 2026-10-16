import { motion } from 'motion/react'
import { Check, ChevronDown, ListChecks, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { useApp } from '../../store/app'
import { Collapse } from '../../ui/Collapse'
import type { Checklist, ChecklistItem, ChecklistState } from './checklist'

/** The one task-state glyph (14px): todo widgets, the todo tool card and the inspector share it. */
export function StateGlyph({ state }: { state: ChecklistState }) {
  switch (state) {
    case 'done':
      return (
        <span className="flex size-3.5 items-center justify-center rounded-full bg-success text-[var(--surface-1)]">
          <Check className="size-2.5" strokeWidth={3.25} />
        </span>
      )
    case 'active':
      return (
        <svg viewBox="0 0 14 14" className="size-3.5 text-fg" aria-hidden>
          <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
        </svg>
      )
    case 'cancelled':
      return (
        <span className="flex size-3.5 items-center justify-center rounded-full text-fg-4 shadow-[inset_0_0_0_1.5px_currentColor]">
          <X className="size-2" strokeWidth={3} />
        </span>
      )
    default:
      return <span className="size-3.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--fg-4)]" />
  }
}

const STATE_LABEL: Record<ChecklistState, string> = {
  done: 'Done',
  active: 'In progress',
  open: 'To do',
  cancelled: 'Cancelled'
}

/** Whether the list docked above the composer is collapsed, and its toggle (one app-wide pref). */
export function useDockedChecklistCollapsed(): [boolean, () => void] {
  const collapsed = useApp((state) => state.prefs.features.composer?.checklistCollapsed ?? false)
  const toggle = () => {
    const { prefs, updateFeaturePrefs } = useApp.getState()
    const composer = prefs.features.composer ?? {}
    updateFeaturePrefs('composer', {
      ...composer,
      checklistCollapsed: !composer.checklistCollapsed
    })
  }
  return [collapsed, toggle]
}

function TaskText({ item, className }: { item: ChecklistItem; className?: string }) {
  return (
    <span
      className={cn(
        'min-w-0 truncate text-[13px]',
        item.state === 'done' && 'text-fg-3 line-through decoration-[var(--fg-4)]',
        item.state === 'active' && 'font-medium text-fg',
        item.state === 'open' && 'text-fg-2',
        item.state === 'cancelled' && 'text-fg-3 line-through decoration-[var(--fg-4)]',
        className
      )}
    >
      {item.text}
    </span>
  )
}

function Progress({ list }: { list: Checklist }) {
  const progress = list.total > 0 ? Math.min(1, list.done / list.total) : 0
  return (
    <span
      className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-active"
      role="progressbar"
      aria-valuenow={list.done}
      aria-valuemin={0}
      aria-valuemax={list.total}
    >
      <motion.span
        className="block h-full rounded-full bg-success"
        initial={false}
        animate={{ width: `${progress * 100}%` }}
        transition={spring.smooth}
      />
    </span>
  )
}

export interface ChecklistCardProps {
  list: Checklist
  /** Heading when the list has no title line of its own. */
  name: string
  className?: string
  /**
   * Docked above the composer: the heading collapses the list to one row showing the current
   * task, and a long list scrolls under the heading.
   */
  docked?: { collapsed: boolean; onToggle: () => void }
}

/** Native todo list: heading with progress, then one 24px row per task with a real check glyph. */
export function ChecklistCard({ list, name, className, docked }: ChecklistCardProps) {
  const collapsed = docked?.collapsed ?? false
  const current =
    list.items.find((item) => item.state === 'active') ??
    list.items.find((item) => item.state === 'open')
  const heading = (
    <>
      <ListChecks className="size-3.5 shrink-0 text-fg-3" />
      <span
        className={cn(
          'min-w-0 truncate text-[13px] font-medium text-fg',
          collapsed && current && 'shrink-0'
        )}
      >
        {list.title ?? name}
      </span>
      <span className="shrink-0 text-xs text-fg-3 tabular">
        {list.done} of {list.total}
      </span>
      {collapsed && current && (
        <span className="flex min-w-0 items-center gap-2 pl-1" data-current-task>
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <StateGlyph state={current.state} />
          </span>
          <TaskText item={current} />
        </span>
      )}
      <Progress list={list} />
    </>
  )

  const rows = (
    <ul
      className={cn(docked && 'max-h-48 overflow-y-auto px-1 short:max-h-28 cramped:max-h-[72px]')}
    >
      {list.items.map((item, index) => (
        <li
          key={`${index}:${item.text}`}
          className="flex h-6 shrink-0 items-center gap-2.5"
          aria-label={`${STATE_LABEL[item.state]}: ${item.text}`}
        >
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <StateGlyph state={item.state} />
          </span>
          <TaskText item={item} />
        </li>
      ))}
    </ul>
  )

  if (!docked)
    return (
      <div className={cn('px-3 pt-2 pb-1.5', className)}>
        <div className="mb-0.5 flex h-6 items-center gap-2">{heading}</div>
        {rows}
      </div>
    )

  return (
    <div className={cn('px-2 py-1', className)}>
      <button
        type="button"
        aria-expanded={!collapsed}
        title={collapsed ? 'Show all tasks' : 'Show only the current task'}
        onClick={docked.onToggle}
        className="group flex h-7 w-full items-center gap-2 rounded-md px-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hover"
      >
        {heading}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-fg-3 transition-transform duration-[var(--dur-base)] group-hover:text-fg-2',
            collapsed && 'rotate-180'
          )}
        />
      </button>
      <Collapse open={!collapsed}>
        <div className="pb-0.5">{rows}</div>
      </Collapse>
    </div>
  )
}
