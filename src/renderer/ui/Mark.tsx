import { useId } from 'react'
import { cn } from '../lib/cn'

export interface MarkProps {
  size?: number
  className?: string
  /** Monochrome (currentColor) instead of the accent gradient. */
  mono?: boolean
  /** Soft accent glow behind the mark. */
  glow?: boolean
}

/** The Vengeance "V": two blades split by a sharp diagonal cut. Follows the active accent. */
export function Mark({ size = 20, className, mono, glow }: MarkProps) {
  const id = useId()
  const fill = mono ? 'currentColor' : `url(#${id})`
  return (
    <svg
      width={size}
      height={size}
      viewBox="40 80 432 384"
      className={cn('shrink-0', glow && 'drop-shadow-[0_0_18px_color-mix(in_oklab,var(--accent)_45%,transparent)]', className)}
      aria-label="Vengeance"
      role="img"
    >
      {!mono && (
        <defs>
          <linearGradient id={id} x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0" stopColor="var(--accent-2)" />
            <stop offset="1" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
      )}
      <path d="M56 96 L180 96 L282 376 L256 448 Z" fill={fill} />
      <path d="M456 96 L332 96 L262 290 L300 394 Z" fill={fill} />
    </svg>
  )
}

export interface AvatarProps {
  name: string
  size?: number
  className?: string
}

/** Initial-based avatar with a deterministic soft hue (workspaces, accounts). */
export function Avatar({ name, size = 22, className }: AvatarProps) {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hue = hash % 360
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-sm font-semibold text-white/90', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.48),
        background: `linear-gradient(135deg, oklch(0.52 0.11 ${hue}), oklch(0.4 0.09 ${(hue + 40) % 360}))`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 0 0 1px rgba(0,0,0,0.2)'
      }}
    >
      {initial}
    </span>
  )
}
