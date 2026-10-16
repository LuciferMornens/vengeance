import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { ScrollArea as RScroll, Separator as RSeparator } from 'radix-ui'
import { cn } from '../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `raised` = elevated glass-ish surface; `flat` = hairline only; `inset` = recessed well. */
  variant?: 'raised' | 'flat' | 'inset'
  interactive?: boolean
}

const cardVariants = {
  raised: 'bg-surface-2 shadow-elev-1',
  flat: 'bg-surface-1 shadow-[0_0_0_1px_var(--hairline)]',
  inset: 'bg-[color-mix(in_oklab,var(--bg)_70%,transparent)] shadow-elev-0'
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card({ variant = 'raised', interactive, className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-card',
        cardVariants[variant],
        interactive && 'transition-[background-color,box-shadow] duration-[var(--dur-instant)] hover:bg-surface-3',
        className
      )}
      {...props}
    />
  )
})

export function Separator({ orientation = 'horizontal', className }: { orientation?: 'horizontal' | 'vertical'; className?: string }) {
  return (
    <RSeparator.Root
      orientation={orientation}
      className={cn('shrink-0 bg-hairline', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
    />
  )
}

export interface ScrollAreaProps {
  children: ReactNode
  className?: string
  viewportClassName?: string
  viewportRef?: React.Ref<HTMLDivElement>
  onScroll?: React.UIEventHandler<HTMLDivElement>
}

/** Overlay scrollbars that appear on hover/scroll. */
export function ScrollArea({ children, className, viewportClassName, viewportRef, onScroll }: ScrollAreaProps) {
  return (
    <RScroll.Root type="hover" scrollHideDelay={600} className={cn('relative overflow-hidden', className)}>
      <RScroll.Viewport ref={viewportRef} onScroll={onScroll} className={cn('size-full [&>div]:!block', viewportClassName)}>
        {children}
      </RScroll.Viewport>
      <RScroll.Scrollbar orientation="vertical" className="z-10 flex w-2.5 touch-none p-[3px] transition-opacity duration-[var(--dur-base)] select-none data-[state=hidden]:opacity-0">
        <RScroll.Thumb className="relative flex-1 rounded-full bg-hairline-strong transition-colors duration-[var(--dur-fast)] hover:bg-[color-mix(in_oklab,var(--fg)_24%,transparent)] active:bg-[color-mix(in_oklab,var(--fg)_32%,transparent)]" />
      </RScroll.Scrollbar>
      <RScroll.Scrollbar orientation="horizontal" className="z-10 flex h-2.5 touch-none flex-col p-[3px] transition-opacity duration-[var(--dur-base)] select-none data-[state=hidden]:opacity-0">
        <RScroll.Thumb className="relative flex-1 rounded-full bg-hairline-strong hover:bg-[color-mix(in_oklab,var(--fg)_24%,transparent)]" />
      </RScroll.Scrollbar>
    </RScroll.Root>
  )
}

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {icon && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-card bg-surface-2 text-fg-3 shadow-elev-1 [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="heading text-title text-fg">{title}</div>
      {description && <div className="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-3">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
