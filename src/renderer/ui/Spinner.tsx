import type { HTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('animate-[v-spin_0.8s_linear_infinite] text-current', className)}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}

/** Animated "working" text treatment (thinking, loading labels). */
export function Shimmer({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'bg-[linear-gradient(90deg,var(--fg-3)_0%,var(--fg-3)_35%,var(--fg)_50%,var(--fg-3)_65%,var(--fg-3)_100%)]',
        'bg-[length:200%_100%] bg-clip-text text-transparent animate-[v-shimmer_2.2s_linear_infinite]',
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}

/** Skeleton block for loading layouts. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'rounded-md bg-[linear-gradient(90deg,var(--hover)_0%,var(--active)_50%,var(--hover)_100%)] bg-[length:200%_100%]',
        'animate-[v-shimmer_1.8s_linear_infinite]',
        className
      )}
    />
  )
}
