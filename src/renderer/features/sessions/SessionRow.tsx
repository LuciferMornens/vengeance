import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from 'react'
import { cn } from '../../lib/cn'
import { ContextMenu, listRowClass, Tooltip, type MenuItem } from '../../ui'
import { useSessions } from './store'

export interface SessionRowProps {
  /** Stable key (session path or `agent:<id>`), also the inline-rename key. */
  rowKey: string
  title: string
  /** Shown on hovering the title (the raw name behind a friendly title). */
  titleTooltip?: string
  meta: ReactNode
  leading?: ReactNode
  /** Right side when not hovered (relative time). */
  trailing?: ReactNode
  /** Hover / focus actions. */
  actions?: ReactNode
  /** Reserve room for two action buttons when the row is hovered or focused. */
  wideActions?: boolean
  active?: boolean
  /** A quieter title (a session that is listed as open but not running). */
  quiet?: boolean
  menu: MenuItem[]
  /**
   * Wait out the double-click window before opening on a mouse click, so a double-click only renames. For rows
   * whose open is expensive (resuming a closed session starts an engine).
   */
  deferOpen?: boolean
  onOpen: () => void
  onRename: (name: string) => void
  onDelete?: () => void
  /** The user is about to act on this row: its context menu opened or an inline rename started. */
  onIntent?: () => void
}

function RenameField({
  initial,
  onDone
}: {
  initial: string
  onDone: (value: string | null) => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const mountedAt = useRef(0)
  useEffect(() => {
    mountedAt.current = performance.now()
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (result: string | null) => {
    if (done.current) return
    done.current = true
    onDone(result)
  }
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Session name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        // A closing menu/palette hands focus back to its trigger right after we mount: take it back.
        if (performance.now() - mountedAt.current < 400) {
          requestAnimationFrame(() => ref.current?.focus())
          return
        }
        finish(value)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') finish(null)
      }}
      className="-mx-1.5 -my-px h-[21px] w-full min-w-0 rounded-sm bg-surface-2 px-1.5 text-ui text-fg shadow-focus outline-none focus-visible:outline-none"
    />
  )
}

function TitleText({
  title,
  tooltip,
  active,
  quiet
}: {
  title: string
  tooltip?: string
  active?: boolean
  quiet?: boolean
}) {
  const tone = active
    ? 'text-fg'
    : quiet
      ? 'text-fg-3 group-hover/row:text-fg-2'
      : 'text-fg-2 group-hover/row:text-fg'
  const text = <span className={cn('truncate text-ui leading-[19px]', tone)}>{title}</span>
  if (!tooltip) return text
  return (
    <Tooltip content={tooltip} side="right">
      {text}
    </Tooltip>
  )
}

/** Common double-click interval; a slower second click opens first and then renames. */
const DOUBLE_CLICK_MS = 250

/** A sidebar session row (the rich ListRow look): two lines, live state, hover actions, context menu, inline rename. */
export function SessionRow({
  rowKey,
  title,
  titleTooltip,
  meta,
  leading,
  trailing,
  actions,
  wideActions,
  active,
  quiet,
  menu,
  deferOpen,
  onOpen,
  onRename,
  onDelete,
  onIntent
}: SessionRowProps) {
  const renaming = useSessions((s) => s.renaming === rowKey)
  const setRenaming = useSessions((s) => s.setRenaming)
  const openTimer = useRef<number | undefined>(undefined)
  const intend = useEffectEvent(() => onIntent?.())

  useEffect(() => () => window.clearTimeout(openTimer.current), [])
  // However the rename started (double-click, F2, the menu, the palette).
  useEffect(() => {
    if (renaming) intend()
  }, [renaming])

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    window.clearTimeout(openTimer.current)
    if (renaming) return
    // detail 0: keyboard activation (Enter / Space), never part of a double-click.
    if (!deferOpen || event.detail === 0) return onOpen()
    if (event.detail === 1) openTimer.current = window.setTimeout(onOpen, DOUBLE_CLICK_MS)
  }

  const onDoubleClick = () => {
    window.clearTimeout(openTimer.current)
    setRenaming(rowKey)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'F2') {
      event.preventDefault()
      setRenaming(rowKey)
    } else if (event.key === 'Delete' && onDelete) {
      event.preventDefault()
      onDelete()
    }
  }

  return (
    <ContextMenu items={menu} onOpenChange={(open) => open && onIntent?.()}>
      <div
        className={cn(
          listRowClass({ density: 'rich', selected: active }),
          'mx-2 w-auto items-stretch gap-0 p-0',
          !active && 'data-[state=open]:bg-hover has-[[data-session-row]:focus-visible]:bg-hover'
        )}
      >
        <button
          type="button"
          data-session-row
          aria-current={active ? 'true' : undefined}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
          className="relative flex w-full items-start gap-2.5 rounded-md py-[7px] pr-2 pl-2.5 text-left focus-visible:outline-none"
        >
          <span className="flex h-[19px] w-3 shrink-0 items-center justify-center">{leading}</span>
          <span
            className={cn(
              'flex min-w-0 flex-1 flex-col gap-px',
              actions &&
                !renaming &&
                (wideActions
                  ? 'group-focus-within/row:[mask-image:linear-gradient(to_left,transparent_60px,black_86px)] group-hover/row:[mask-image:linear-gradient(to_left,transparent_60px,black_86px)]'
                  : 'group-focus-within/row:[mask-image:linear-gradient(to_left,transparent_34px,black_60px)] group-hover/row:[mask-image:linear-gradient(to_left,transparent_34px,black_60px)]')
            )}
          >
            {renaming ? (
              <RenameField
                initial={title}
                onDone={(value) => {
                  setRenaming(null)
                  if (value !== null) onRename(value)
                }}
              />
            ) : (
              <TitleText title={title} tooltip={titleTooltip} active={active} quiet={quiet} />
            )}
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs leading-4 text-fg-3">
              {meta}
            </span>
          </span>
          {trailing && !renaming && (
            <span className="tabular shrink-0 pt-px text-2xs leading-[19px] text-fg-3 transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0">
              {trailing}
            </span>
          )}
        </button>
        {actions && !renaming && (
          <div className="absolute top-1 right-1 flex items-center gap-px opacity-0 transition-opacity duration-[var(--dur-fast)] group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[data-state=open]]:opacity-100">
            {actions}
          </div>
        )}
      </div>
    </ContextMenu>
  )
}
