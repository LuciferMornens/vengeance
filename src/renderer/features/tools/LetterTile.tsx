import { cn } from '../../lib/cn'

/** Stable hue per name, so a server or site keeps its color across cards. */
function hueOf(name: string): number {
  let hue = 0
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  return hue
}

/**
 * Initial-letter tile standing in for a logo (web sources, MCP servers, extension tool families):
 * `md` 20px for list rows, `sm` 16px for card headers.
 */
export function LetterTile({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md'; className?: string }) {
  const hue = hueOf(name.toLowerCase())
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold text-white/90 uppercase',
        size === 'md' ? 'size-5 rounded-sm text-[10px]' : 'size-4 rounded-xs text-[9px]',
        className
      )}
      style={{ background: `linear-gradient(135deg, oklch(0.55 0.1 ${hue}), oklch(0.43 0.09 ${(hue + 40) % 360}))` }}
    >
      {name.trim()[0] ?? '?'}
    </span>
  )
}
