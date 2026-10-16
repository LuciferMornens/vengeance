import { cn } from '../../lib/cn'
import type { LiveState } from './model'

/**
 * Activity indicator for an open agent: ember pulse while working, amber when waiting, red when stopped. Waiting can
 * last for hours with nothing happening, so its amber dot pulses three times and then stays lit.
 */
export function LiveDot({ state, unread, className }: { state: LiveState; unread?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0 items-center justify-center', className)} aria-hidden>
      {state === 'running' && <span className="absolute inset-[-3px] animate-[v-pulse_1.6s_ease-in-out_infinite] rounded-full bg-accent-soft" />}
      <span
        className={cn(
          'relative size-[7px] rounded-full',
          state === 'running' && 'bg-accent-gradient shadow-[0_0_8px_color-mix(in_oklab,var(--accent)_70%,transparent)]',
          state === 'waiting' && 'animate-[v-pulse_2s_ease-in-out_3] bg-warning shadow-[0_0_8px_color-mix(in_oklab,var(--warning)_60%,transparent)]',
          state === 'crashed' && 'bg-danger',
          state === 'starting' && 'animate-[v-pulse_1.4s_ease-in-out_infinite] bg-fg-4',
          state === 'idle' && (unread ? 'bg-info' : 'bg-transparent shadow-[inset_0_0_0_1.5px_var(--fg-4)]')
        )}
      />
    </span>
  )
}
