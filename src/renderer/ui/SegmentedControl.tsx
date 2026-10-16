import { useId, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { cn } from '../lib/cn'
import { spring } from '../lib/motion'

export interface Segment<V extends string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  segments: Segment<V>[]
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

/** Track + raised thumb shared by SegmentedControl and `Tabs variant="segmented"`. */
export const segmentTrackClass = 'no-drag inline-flex items-center gap-0.5 rounded-md bg-surface-1 p-0.5 shadow-[inset_0_0_0_1px_var(--hairline)]'
export const segmentThumbClass = 'absolute inset-0 rounded-sm bg-surface-4 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)]'
export const segmentItemClass = (size: 'sm' | 'md', active: boolean): string =>
  cn(
    'relative inline-flex items-center justify-center gap-1.5 rounded-sm font-medium outline-none transition-colors duration-[var(--dur-fast)] [&_svg]:size-3.5',
    'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--focus-color)] disabled:pointer-events-none disabled:text-fg-4',
    size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-3 text-sm',
    active ? 'text-fg' : 'text-fg-3 hover:text-fg-2'
  )

/** Pill segmented control (2–5 mutually exclusive options) with a sliding thumb. */
export function SegmentedControl<V extends string>({ value, onValueChange, segments, size = 'md', className, ...rest }: SegmentedControlProps<V>) {
  const layoutId = useId()
  return (
    <div role="radiogroup" aria-label={rest['aria-label']} className={cn(segmentTrackClass, className)}>
      {segments.map((segment) => {
        const active = segment.value === value
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={segment.disabled}
            onClick={() => onValueChange(segment.value)}
            className={segmentItemClass(size, active)}
          >
            {active && <motion.span layoutId={layoutId} transition={spring.snappy} className={segmentThumbClass} />}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {segment.icon}
              {segment.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
