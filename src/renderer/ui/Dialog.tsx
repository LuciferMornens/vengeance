import { useEffect, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import { Dialog as RDialog } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'
import type { Tone } from './Badge'
import { IconButton } from './Button'
import { Kbd } from './Kbd'

/** Focus the first text field, else the surface itself — never flash a focus ring on the close button. */
function focusContent(event: Event): void {
  event.preventDefault()
  const root = event.currentTarget as HTMLElement
  const field = root.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), textarea')
  ;(field ?? root).focus()
}

/** Clicking a toast (or its action) must not dismiss the modal underneath it. */
function keepOpenForToasts(event: { target: EventTarget | null; preventDefault(): void }): void {
  if (event.target instanceof Element && event.target.closest('[data-toaster]')) event.preventDefault()
}

/** Width presets: confirm 400 · form 480 · picker 560 · editor 720. */
export type DialogSize = 'confirm' | 'form' | 'picker' | 'editor'
export const DIALOG_WIDTHS: Record<DialogSize, number> = { confirm: 400, form: 480, picker: 560, editor: 720 }

const iconTones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]',
  accent: 'bg-accent-soft text-accent-text shadow-[inset_0_0_0_1px_var(--accent-border)]',
  success: 'bg-success-soft text-success shadow-[inset_0_0_0_1px_var(--success-border)]',
  warning: 'bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--warning-border)]',
  danger: 'bg-danger-soft text-danger shadow-[inset_0_0_0_1px_var(--danger-border)]',
  info: 'bg-info-soft text-info shadow-[inset_0_0_0_1px_var(--info-border)]'
}

/** Overlay for modal dialogs (whole window). */
const overlayClass =
  'fixed inset-0 z-[var(--z-modal)] bg-overlay backdrop-blur-[2px] ' +
  'data-[state=open]:animate-[v-fade-in_180ms_var(--ease-out)] data-[state=closed]:animate-[v-fade-out_140ms_var(--ease-out)]'

/**
 * Blocks the window behind a modal. A plain element rather than Radix's Overlay, whose scroll lock sets a custom
 * property on <body> that restyles every element (a 25-30 ms frame each way on a long transcript); the backdrop
 * already covers everything that could scroll. `data-modal-backdrop` keeps Radix's `pointer-events: none` on <body>
 * from applying (globals.css), and `data-state` drives the exit animation like an Overlay's.
 */
export function ModalBackdrop({ open, ...props }: ComponentProps<'div'> & { open: boolean }) {
  return <div data-modal-backdrop data-state={open ? 'open' : 'closed'} aria-hidden {...props} />
}

/** The modal surface look (r14, elevation 3) for custom modal shells that cannot use <Dialog>. */
export const dialogSurface = 'rounded-lg bg-surface-2 shadow-elev-3'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  /** Footer actions (right-aligned). */
  footer?: ReactNode
  /** Left side of the footer: a quiet keyboard hint, e.g. `{ combo: 'mod+enter', label: 'to save' }`. */
  hint?: { combo: string; label: string }
  /** Left side of the footer when it needs more than one hint (several key hints, a checkbox, a reset action). Replaces `hint`. */
  footerStart?: ReactNode
  /** Keyboard handling for the whole surface (list navigation, number shortcuts). */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** 32px icon tile left of the title. */
  icon?: ReactNode
  iconTone?: Tone
  children?: ReactNode
  /** Width preset (default `form`). */
  size?: DialogSize
  /** Explicit width in px; overrides `size`. */
  width?: number
  /** Hide the close (×) button. */
  hideClose?: boolean
  /** Keep the dialog open on outside click (forms with unsaved input). Esc still closes. */
  persistent?: boolean
  className?: string
  /** Classes for the scrollable body. */
  bodyClassName?: string
}

/**
 * The one modal shell: anchored at 18vh (never jumps while content filters), spring scale-in, 32px icon tile,
 * 15px title, footer actions right with an optional kbd hint left. Compose presets via `size`.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  hint,
  footerStart,
  onKeyDown,
  icon,
  iconTone = 'neutral',
  children,
  size = 'form',
  width,
  hideClose,
  persistent,
  className,
  bodyClassName
}: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <ModalBackdrop open={open} className={overlayClass} />
        <div className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-start justify-center px-6 pt-[18vh] pb-6">
          <RDialog.Content
            tabIndex={-1}
            onOpenAutoFocus={focusContent}
            onPointerDownOutside={(event) => (persistent ? event.preventDefault() : keepOpenForToasts(event))}
            onInteractOutside={keepOpenForToasts}
            onKeyDown={onKeyDown}
            style={{ width: width ?? DIALOG_WIDTHS[size] }}
            className={cn(
              'pointer-events-auto flex max-h-[calc(82vh-24px)] max-w-full origin-top flex-col overflow-hidden',
              dialogSurface,
              'data-[state=open]:animate-[v-dialog-in_260ms_var(--ease-spring)] data-[state=closed]:animate-[v-dialog-out_140ms_var(--ease-out)]',
              className
            )}
          >
            {(title || icon || !hideClose) && (
              <div className={cn('flex items-start gap-3 px-5 pt-[18px]', children ? 'pb-3' : 'pb-4')}>
                {icon && <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-card [&_svg]:size-4', iconTones[iconTone])}>{icon}</div>}
                <div className={cn('min-w-0 flex-1', icon && 'pt-px')}>
                  {title ? (
                    <RDialog.Title className="heading text-title leading-snug text-fg">{title}</RDialog.Title>
                  ) : (
                    <RDialog.Title className="sr-only">Dialog</RDialog.Title>
                  )}
                  {description ? (
                    <RDialog.Description className="mt-1 text-ui leading-relaxed text-fg-2">{description}</RDialog.Description>
                  ) : (
                    <RDialog.Description className="sr-only">Dialog</RDialog.Description>
                  )}
                </div>
                {!hideClose && (
                  <RDialog.Close asChild>
                    <IconButton label="Close" tooltip={false} size="xs" className="-mt-0.5 -mr-1.5">
                      <X />
                    </IconButton>
                  </RDialog.Close>
                )}
              </div>
            )}
            {children && <div className={cn('min-h-0 flex-1 overflow-auto px-5 pb-2', bodyClassName)}>{children}</div>}
            {(footer || hint || footerStart) && (
              <div className="flex items-center gap-2 px-5 pt-3 pb-4">
                {footerStart ? (
                  <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-fg-3">{footerStart}</div>
                ) : hint && (
                  <span className="mr-auto flex items-center gap-1.5 text-xs text-fg-3">
                    <Kbd combo={hint.combo} size="xs" />
                    {hint.label}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">{footer}</div>
              </div>
            )}
          </RDialog.Content>
        </div>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Accessible title (visually hidden unless rendered by children). */
  title: string
  /**
   * `full` = page-like surface filling the window below the titlebar (settings, updates, shortcuts); the titlebar
   * stays undimmed and draggable. `right` = contextual drawer below the titlebar.
   */
  side?: 'full' | 'right'
  width?: number
  children: ReactNode
  className?: string
}

/** Full sheets currently open; `html[data-sheet=full]` moves toasts into the sheet's gutter (globals.css). */
let openFullSheets = 0

function useFullSheetMarker(active: boolean): void {
  useEffect(() => {
    if (!active) return
    openFullSheets += 1
    document.documentElement.dataset.sheet = 'full'
    return () => {
      openFullSheets -= 1
      if (openFullSheets === 0) delete document.documentElement.dataset.sheet
    }
  }, [active])
}

/**
 * Large sliding surface. Sits under toasts and modals (dialogs opened from a sheet stack above it). A full sheet
 * with a nav column sets `html[data-sheet-nav]` so toasts dock over the nav; one without a nav pads the end of
 * its scroll column (pb-36) so every control scrolls clear of a bottom-right toast.
 */
export function Sheet({ open, onOpenChange, title, side = 'full', width = 420, children, className }: SheetProps) {
  useFullSheetMarker(open && side === 'full')
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        {/* Over the whole window: the titlebar stays visible but not clickable; a drawer dims what is below it. */}
        <ModalBackdrop
          open={open}
          className={cn(
            'fixed inset-0 z-[var(--z-sheet)]',
            side === 'right' &&
              'data-[state=open]:animate-[v-fade-in_180ms_var(--ease-out)] data-[state=closed]:animate-[v-fade-out_140ms_var(--ease-out)]'
          )}
        >
          {side === 'right' && <div className="absolute inset-x-0 top-[var(--titlebar-h)] bottom-0 bg-overlay" />}
        </ModalBackdrop>
        <RDialog.Content
          tabIndex={-1}
          onOpenAutoFocus={focusContent}
          // A full sheet is a page: only Esc or its own close button dismiss it (clicks on the titlebar never do).
          onPointerDownOutside={(event) => (side === 'full' ? event.preventDefault() : keepOpenForToasts(event))}
          onInteractOutside={keepOpenForToasts}
          style={side === 'right' ? { width } : undefined}
          // One above its backdrop: Radix portals each part separately, and a sheet reopened during its exit
          // animation keeps its node while the backdrop (no exit animation when full) mounts again after it.
          className={cn(
            'fixed bottom-0 top-[var(--titlebar-h)] z-[calc(var(--z-sheet)+1)] flex flex-col overflow-hidden bg-surface-1',
            side === 'full'
              ? 'inset-x-0 ' +
                  'data-[state=open]:animate-[v-sheet-in_260ms_var(--ease-out)] data-[state=closed]:animate-[v-sheet-out_160ms_var(--ease-out)]'
              : 'right-0 max-w-full shadow-[-1px_0_0_var(--hairline),var(--shadow-xl)] ' +
                  'data-[state=open]:animate-[v-side-in_280ms_var(--ease-out)] data-[state=closed]:animate-[v-side-out_180ms_var(--ease-out)]',
            className
          )}
        >
          <RDialog.Title className="sr-only">{title}</RDialog.Title>
          <RDialog.Description className="sr-only">{title}</RDialog.Description>
          {children}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  )
}

export const DialogClose = RDialog.Close
