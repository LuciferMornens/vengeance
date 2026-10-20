import type { ReactNode } from 'react'
import { Popover as RPopover } from 'radix-ui'
import { cn } from '../lib/cn'

/**
 * Shared floating-surface look for popovers, menus and selects: frosted glass, r10, elevation 2, a quick
 * origin-aware pop. Use it for any custom floating panel so every overlay feels like one material.
 */
export const floatingSurface =
  'z-[var(--z-popover)] rounded-card bg-[var(--glass-strong)] p-1 text-ui text-fg backdrop-blur-xl backdrop-saturate-150 shadow-elev-2 ' +
  'data-[state=open]:animate-[v-pop-in_160ms_var(--ease-out)] data-[state=closed]:animate-[v-pop-out_110ms_var(--ease-out)] ' +
  'origin-[var(--radix-popper-transform-origin)] outline-none'

export interface PopoverProps {
  trigger: ReactNode
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  /** Distance from the trigger (default 6px). */
  sideOffset?: number
  className?: string
  /**
   * Focus the panel itself when it opens instead of its first control, for panels that open on an icon
   * button (its tooltip would show at once). Tab still moves into the panel.
   */
  focusContent?: boolean
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  sideOffset = 6,
  className,
  focusContent = false
}: PopoverProps) {
  return (
    <RPopover.Root open={open} onOpenChange={onOpenChange}>
      <RPopover.Trigger asChild>{trigger}</RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={10}
          className={cn(floatingSurface, 'p-2', className)}
          {...(focusContent && {
            tabIndex: -1,
            onOpenAutoFocus: (event: Event) => {
              event.preventDefault()
              ;(event.currentTarget as HTMLElement).focus()
            }
          })}
        >
          {children}
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  )
}
