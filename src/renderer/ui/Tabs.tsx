import { useId, type ReactNode } from 'react'
import { Tabs as RTabs } from 'radix-ui'
import { motion } from 'motion/react'
import { cn } from '../lib/cn'
import { spring } from '../lib/motion'
import { segmentItemClass, segmentThumbClass, segmentTrackClass } from './SegmentedControl'

export interface TabItem {
  value: string
  label: ReactNode
  icon?: ReactNode
  content: ReactNode
}

export interface TabsProps {
  value: string
  onValueChange: (value: string) => void
  items: TabItem[]
  /** `underline` (default) for pane-level navigation; `segmented` for compact in-card switching. */
  variant?: 'underline' | 'segmented'
  className?: string
  listClassName?: string
}

/** Tabs with an animated indicator; the segmented variant shares SegmentedControl's track and thumb. */
export function Tabs({ value, onValueChange, items, variant = 'underline', className, listClassName }: TabsProps) {
  const layoutId = useId()
  const segmented = variant === 'segmented'
  return (
    <RTabs.Root value={value} onValueChange={onValueChange} className={cn('flex min-h-0 flex-col', className)}>
      <RTabs.List
        className={cn(segmented ? cn(segmentTrackClass, 'self-start') : 'flex shrink-0 items-center gap-1 border-b border-hairline-soft px-2', listClassName)}
      >
        {items.map((item) => {
          const active = item.value === value
          return (
            <RTabs.Trigger
              key={item.value}
              value={item.value}
              className={
                segmented
                  ? segmentItemClass('md', active)
                  : cn(
                      'relative flex h-9 items-center gap-1.5 px-2 text-sm font-medium outline-none transition-colors duration-[var(--dur-fast)] [&_svg]:size-3.5',
                      'rounded-sm focus-visible:bg-hover',
                      active ? 'text-fg' : 'text-fg-3 hover:text-fg-2'
                    )
              }
            >
              {active &&
                (segmented ? (
                  <motion.span layoutId={layoutId} transition={spring.snappy} className={segmentThumbClass} />
                ) : (
                  <motion.span layoutId={layoutId} transition={spring.snappy} className="absolute inset-x-1.5 -bottom-px h-[1.5px] rounded-full bg-fg" />
                ))}
              <span className="relative z-10 inline-flex items-center gap-1.5">
                {item.icon}
                {item.label}
              </span>
            </RTabs.Trigger>
          )
        })}
      </RTabs.List>
      {items.map((item) => (
        <RTabs.Content key={item.value} value={item.value} className="min-h-0 flex-1 overflow-auto outline-none">
          {item.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  )
}
