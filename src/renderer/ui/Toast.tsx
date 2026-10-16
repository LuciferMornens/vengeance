import { AnimatePresence, motion, type PanInfo } from 'motion/react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { cn } from '../lib/cn'
import { duration, spring } from '../lib/motion'

export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  level: ToastLevel
  title: ReactNode
  description?: ReactNode
  /** ms; 0 = sticky. Default 4500 (errors 7000). The timer only runs while the toast is visible and unhovered. */
  duration: number
  action?: { label: string; onClick: () => void }
}

interface ToastStore {
  toasts: Toast[]
  push(toast: Omit<Toast, 'id' | 'duration'> & { id?: string; duration?: number }): string
  dismiss(id: string): void
  clear(): void
}

/** Visible at once; older toasts wait behind a "+N" pill and slide in as newer ones leave. */
const MAX_VISIBLE = 3
const MAX_QUEUED = 12
const SWIPE_DISMISS_PX = 80

let counter = 0

export const useToasts = create<ToastStore>()((set) => ({
  toasts: [],
  push(input) {
    counter += 1
    const id = input.id ?? `t${counter}`
    const duration = input.duration ?? (input.level === 'error' ? 7000 : 4500)
    set((state) => ({ toasts: [...state.toasts.filter((t) => t.id !== id), { ...input, id, duration }].slice(-MAX_QUEUED) }))
    return id
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },
  clear() {
    set({ toasts: [] })
  }
}))

/** Imperative API: `toast({ level: 'success', title: 'Saved' })`. */
export const toast = (input: Parameters<ToastStore['push']>[0]): string => useToasts.getState().push(input)

const icons: Record<ToastLevel, ReactNode> = {
  info: <Info className="text-info" />,
  success: <CheckCircle2 className="text-success" />,
  warning: <AlertTriangle className="text-warning" />,
  error: <XCircle className="text-danger" />
}

/** Remaining-time timer that pauses while `paused`; calls `onDone` once. */
function useDismissTimer(total: number, paused: boolean, onDone: () => void): void {
  const remaining = useRef(total)
  useEffect(() => {
    if (total <= 0 || paused) return
    const started = performance.now()
    const timer = setTimeout(onDone, remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(0, remaining.current - (performance.now() - started))
    }
  }, [total, paused, onDone])
}

function ToastCard({ toast: t, paused, onDismiss }: { toast: Toast; paused: boolean; onDismiss: (id: string) => void }) {
  const dismiss = useCallback(() => onDismiss(t.id), [onDismiss, t.id])
  useDismissTimer(t.duration, paused, dismiss)
  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > SWIPE_DISMISS_PX || info.velocity.x > 600) dismiss()
  }
  return (
    <motion.div
      layout
      role={t.level === 'error' ? 'alert' : 'status'}
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 28, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
      transition={spring.snappy}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.05, right: 0.7 }}
      dragSnapToOrigin
      onDragEnd={onDragEnd}
      className={cn(
        'pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-card py-3 pr-3 pl-3.5 [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0',
        'bg-[var(--glass-strong)] shadow-elev-2 backdrop-blur-xl backdrop-saturate-150'
      )}
    >
      {icons[t.level]}
      <div className="min-w-0 flex-1">
        <div className="text-ui leading-snug font-medium break-words text-fg">{t.title}</div>
        {t.description && (
          <div className="selectable mt-0.5 line-clamp-4 text-sm leading-snug break-words whitespace-pre-line text-fg-2 [:root[data-sheet-nav]_&]:line-clamp-none">{t.description}</div>
        )}
        {t.action && (
          <button
            type="button"
            onClick={() => {
              t.action!.onClick()
              dismiss()
            }}
            className="pressable mt-2 -ml-1.5 h-6 rounded-sm px-1.5 text-sm font-medium text-fg hover:bg-hover"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="-mt-0.5 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
      {t.duration > 0 && (
        <span
          aria-hidden
          style={{ animationDuration: `${t.duration}ms`, animationPlayState: paused ? 'paused' : 'running' }}
          className="absolute right-0 bottom-0 left-0 h-px origin-left animate-[v-progress_linear_forwards] bg-[color-mix(in_oklab,var(--fg)_22%,transparent)] motion-reduce:hidden [[data-motion=reduce]_&]:hidden"
        />
      )}
    </motion.div>
  )
}

/**
 * Mount once at the app root. Bottom-right stack, newest at the bottom, max 3 visible; hover pauses every timer;
 * swipe right (or ×) dismisses. Sits above sheets but below modals. Position and width come from `--toast-right`,
 * `--toast-bottom` and `--toast-w` (globals.css): clear of the inspector and composer (`--toast-inset-*`, set on
 * this element by the shell), and in the reserved gutter while a full sheet is open (`html[data-sheet=full]`, set by <Sheet>).
 */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  const clear = useToasts((s) => s.clear)
  const [hovered, setHovered] = useState(false)
  const visible = toasts.slice(-MAX_VISIBLE)
  const hidden = toasts.length - visible.length
  useEffect(() => {
    if (toasts.length === 0) setHovered(false)
  }, [toasts.length])

  return (
    <div
      data-toaster
      aria-live="polite"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{ right: 'var(--toast-right)', bottom: 'var(--toast-bottom)', width: 'var(--toast-w)', transitionDuration: `${duration.panel}s` }}
      className="pointer-events-none fixed z-[var(--z-toast)] flex max-w-[calc(100vw-32px)] flex-col items-stretch gap-2 transition-[right,bottom,width] ease-[var(--ease-out)]"
    >
      <AnimatePresence initial={false}>
        {hidden > 0 && (
          <motion.button
            key="more"
            type="button"
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={spring.snappy}
            onClick={clear}
            className="pressable pointer-events-auto self-end rounded-full bg-[var(--glass-strong)] px-2.5 py-1 text-xs font-medium text-fg-2 shadow-elev-2 backdrop-blur-xl hover:text-fg"
          >
            +{hidden} more · Clear all
          </motion.button>
        )}
        {visible.map((t) => (
          <ToastCard key={t.id} toast={t} paused={hovered} onDismiss={dismiss} />
        ))}
      </AnimatePresence>
    </div>
  )
}
