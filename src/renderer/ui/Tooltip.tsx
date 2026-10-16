import type { ReactNode } from 'react'
import { Tooltip as RTooltip } from 'radix-ui'
import { cn } from '../lib/cn'
import { Kbd } from './Kbd'

/** Mount once at the app root. Moving between triggers skips the delay (native feel). */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </RTooltip.Provider>
  )
}

export interface TooltipProps {
  content: ReactNode
  hotkey?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  children: ReactNode
  className?: string
}

/** Small label on hover/focus: short text, optional shortcut. Never put interactive content in it. */
export function Tooltip({
  content,
  hotkey,
  side = 'bottom',
  align = 'center',
  children,
  className
}: TooltipProps) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        {/* Radix's positioning wrapper must also let clicks reach the control beneath it. */}
        <div className="pointer-events-none contents">
          <RTooltip.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            style={{ pointerEvents: 'none' }}
            className={cn(
              'z-[var(--z-tooltip)] flex max-w-72 items-center gap-2 rounded-sm bg-surface-4 px-2 py-[5px] text-xs leading-snug font-medium text-fg',
              'shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-md)] origin-[var(--radix-tooltip-content-transform-origin)]',
              'data-[side=top]:[--tip-dy:3px] data-[side=bottom]:[--tip-dy:-3px] data-[side=left]:[--tip-dy:0px] data-[side=right]:[--tip-dy:0px]',
              'data-[state=delayed-open]:animate-[v-tip_150ms_var(--ease-out)] data-[state=instant-open]:animate-[v-fade-in_90ms_var(--ease-out)]',
              className
            )}
          >
            {content}
            {hotkey && <Kbd combo={hotkey} size="xs" className="-mr-0.5" />}
          </RTooltip.Content>
        </div>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
