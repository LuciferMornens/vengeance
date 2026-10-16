import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'

export interface SidePanelProps {
  side: 'left' | 'right'
  open: boolean
  width: number
  minWidth: number
  maxWidth: number
  /** Width restored by double-clicking the divider. */
  defaultWidth: number
  /** Committed width (pointer up, keyboard step, double-click) — persisted by the caller. */
  onWidthChange: (width: number) => void
  /** Accessible name of the resize handle, e.g. "Resize sidebar". */
  label: string
  /** Float over the neighbouring pane (a drawer) instead of taking space beside it. */
  overlay?: boolean
  /** Follow width changes without the spring, e.g. while the window is being resized. */
  instant?: boolean
  children: ReactNode
  className?: string
}

const KEY_STEP = 16

/**
 * Collapsible, resizable panel frame: spring width animation, pointer + keyboard resizable divider.
 * While dragging the width lives in local state; it is committed once on pointer up (no prefs write per move).
 */
export function SidePanel({
  side,
  open,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onWidthChange,
  label,
  overlay = false,
  instant = false,
  children,
  className
}: SidePanelProps) {
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const start = useRef({ x: 0, width })
  const clamp = (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value)))
  const current = dragWidth ?? width
  const dragging = dragWidth !== null

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    start.current = { x: event.clientX, width }
    setDragWidth(width)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const delta = side === 'left' ? event.clientX - start.current.x : start.current.x - event.clientX
    setDragWidth(clamp(start.current.width + delta))
  }
  const endDrag = () => {
    if (dragWidth !== null && dragWidth !== width) onWidthChange(dragWidth)
    setDragWidth(null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (event.key === grow) onWidthChange(clamp(width + KEY_STEP))
    else if (event.key === shrink) onWidthChange(clamp(width - KEY_STEP))
    else if (event.key === 'Home') onWidthChange(minWidth)
    else if (event.key === 'End') onWidthChange(maxWidth)
    else return
    event.preventDefault()
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? current : 0, opacity: open ? 1 : 0 }}
      transition={dragging || instant ? { duration: 0 } : spring.panel}
      // z-10: the grip straddles the panel edge and must stay above the neighbouring pane, even while the panel is
      // translucent (window blur, toggling), which gives it its own stacking context.
      className={cn(
        'flex shrink-0 flex-col',
        overlay
          ? cn('absolute inset-y-0 z-30', side === 'left' ? 'left-0' : 'right-0')
          : 'relative z-10',
        dragging && 'select-none',
        className
      )}
      data-overlay={overlay || undefined}
      aria-hidden={!open}
      inert={!open}
    >
      {/* Clips the content while the width animates; the grip sits outside it so all of it stays grabbable. */}
      <div className="absolute inset-0 overflow-hidden">
        <div style={{ width: current }} className="flex h-full min-h-0 flex-col">
          {children}
        </div>
      </div>
      {open && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={label}
          aria-valuenow={current}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => onWidthChange(defaultWidth)}
          onKeyDown={onKeyDown}
          data-dragging={dragging || undefined}
          className={cn(
            'group absolute top-0 bottom-0 z-20 flex w-2 cursor-col-resize justify-center focus-visible:outline-none',
            side === 'left' ? '-right-1' : '-left-1'
          )}
        >
          <span
            className={cn(
              'my-3 w-px rounded-full bg-transparent transition-[background-color,width,box-shadow] duration-[var(--dur-fast)] delay-150',
              'group-hover:w-[2px] group-hover:bg-hairline-strong group-focus-visible:w-[2px] group-focus-visible:bg-[var(--focus-color)]',
              'group-data-[dragging]:w-[2px] group-data-[dragging]:bg-[var(--focus-color)] group-data-[dragging]:delay-0'
            )}
          />
        </div>
      )}
    </motion.aside>
  )
}
