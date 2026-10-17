import { shortcutCaps } from '../lib/keybindings'
import { cn } from '../lib/cn'

export interface KbdProps {
  /** e.g. `mod+k` */
  combo: string
  size?: 'xs' | 'sm'
  className?: string
}

/** Keyboard shortcut key caps: quiet, r4, a hairline "key edge" at the bottom. */
export function Kbd({ combo, size = 'sm', className }: KbdProps) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      {shortcutCaps(combo).map((key, i) => (
        <kbd
          key={i}
          className={cn(
            'inline-flex items-center justify-center rounded-xs bg-hover font-sans leading-none font-medium text-fg-3',
            'shadow-[inset_0_0_0_1px_var(--hairline),inset_0_-1px_0_var(--hairline-strong)]',
            size === 'xs' ? 'h-4 min-w-4 px-1 text-2xs' : 'h-5 min-w-5 px-1.5 text-xs'
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
