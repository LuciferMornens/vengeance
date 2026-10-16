import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/cn'

/** `menu` 30px (menus, selects) · `list` 36px (pickers, sidebars, suggestion menus) · `rich` 44px+ (two-line rows). */
export type ListRowDensity = 'menu' | 'list' | 'rich'

const densities: Record<ListRowDensity, string> = {
  menu: 'min-h-[30px] gap-2 px-2 py-1',
  list: 'min-h-9 gap-2.5 px-2.5 py-1.5',
  rich: 'min-h-11 gap-3 px-2.5 py-2'
}

/**
 * Selection caret: 2px wide, inset 4px from the left edge and 6px (8px on rich rows) from top and bottom, so it always
 * sits inside the row's rounded fill. It is the only selection signal: selected rows carry no extra checkmark.
 */
const caretInsets: Record<ListRowDensity, string> = {
  menu: 'before:top-1.5 before:bottom-1.5',
  list: 'before:top-1.5 before:bottom-1.5',
  rich: 'before:top-2 before:bottom-2'
}

export interface ListRowClassOptions {
  density?: ListRowDensity
  /** Persistent selection (the current session, the chosen model): active fill + inset accent caret. */
  selected?: boolean
  /** Destructive item (delete, remove). */
  danger?: boolean
}

/**
 * Class string for the one list-row look, for elements that can't be a <ListRow> (cmdk `Command.Item`, Radix menu
 * items). Keyboard highlight follows `data-highlighted` (Radix), `data-selected=true` (cmdk) and
 * `aria-selected=true`; hover is the same quiet fill. Rows never scale on press.
 */
export function listRowClass({ density = 'list', selected, danger }: ListRowClassOptions = {}): string {
  return cn(
    'group/row relative flex w-full items-center rounded-md text-left text-ui text-fg-2 weight-row outline-none select-none',
    'transition-[background-color,color] duration-[var(--dur-instant)] ease-out',
    'hover:bg-hover hover:text-fg data-[highlighted]:bg-hover data-[highlighted]:text-fg data-[selected=true]:bg-hover data-[selected=true]:text-fg',
    'aria-selected:bg-hover aria-selected:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-none',
    // cmdk writes data-disabled="false" on every item, so match the value; Radix items set aria-disabled.
    'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40',
    'disabled:pointer-events-none disabled:opacity-40',
    '[&_svg]:shrink-0',
    densities[density],
    selected && cn('bg-active text-fg hover:bg-active before:absolute before:left-1 before:w-[2px] before:rounded-full before:bg-accent', caretInsets[density]),
    danger && 'text-danger hover:bg-danger-soft hover:text-danger data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger'
  )
}

export interface ListRowContentProps {
  /** Leading icon (16px glyph) or any node (avatar, LiveDot…). */
  icon?: ReactNode
  /** Wrap the icon in a 24px tile (r6) — for rich rows and pickers. */
  iconTile?: boolean
  title: ReactNode
  subtitle?: ReactNode
  /** Quiet right-aligned metadata (time, count, size). */
  meta?: ReactNode
  /** Trailing slot (kbd, check, chevron, actions). */
  trailing?: ReactNode
}

/** Inner layout of a list row: icon · title/subtitle · meta · trailing. */
export function ListRowContent({ icon, iconTile, title, subtitle, meta, trailing }: ListRowContentProps) {
  return (
    <>
      {icon !== undefined &&
        (iconTile ? (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-3 text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] [&_svg]:size-3.5">{icon}</span>
        ) : (
          <span className="flex shrink-0 items-center text-fg-3 group-hover/row:text-fg-2 [&_svg]:size-4">{icon}</span>
        ))}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        {subtitle && <span className="truncate text-xs font-normal text-fg-3">{subtitle}</span>}
      </span>
      {meta !== undefined && <span className="tabular shrink-0 text-xs font-normal text-fg-3">{meta}</span>}
      {trailing !== undefined && <span className="flex shrink-0 items-center gap-1 text-fg-3">{trailing}</span>}
    </>
  )
}

export interface ListRowProps extends ListRowContentProps, ListRowClassOptions, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {}

/** The one list row: menus, pickers, sidebars, palette-like lists. Renders a <button>. */
export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(function ListRow(
  { density, selected, danger, icon, iconTile, title, subtitle, meta, trailing, className, type = 'button', ...props },
  ref
) {
  return (
    <button ref={ref} type={type} aria-current={selected || undefined} className={cn(listRowClass({ density, selected, danger }), className)} {...props}>
      <ListRowContent icon={icon} iconTile={iconTile} title={title} subtitle={subtitle} meta={meta} trailing={trailing} />
    </button>
  )
})
