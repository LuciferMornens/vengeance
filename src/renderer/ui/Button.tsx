import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Slot } from 'radix-ui'
import { cn } from '../lib/cn'
import { Spinner } from './Spinner'
import { Tooltip } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const base =
  'pressable relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium select-none no-drag ' +
  'disabled:pointer-events-none [&_svg]:shrink-0'

/**
 * Primary = the one CTA per surface: crisp ember fill (solid --accent, lit from the top by --accent-2), inner
 * highlight, a hairline accent edge and a tight contact shadow — never an outer glow. Disabled states are neutral
 * for every variant — never a muddy tint.
 */
const variants: Record<ButtonVariant, string> = {
  primary:
    'text-accent-fg bg-[linear-gradient(180deg,color-mix(in_oklab,var(--accent)_78%,var(--accent-2))_0%,var(--accent)_100%)] ' +
    'shadow-[inset_0_1px_0_rgba(255,255,255,0.24),inset_0_-1px_0_rgba(0,0,0,0.12),0_0_0_1px_color-mix(in_oklab,var(--accent)_60%,transparent),var(--shadow-sm)] ' +
    'hover:brightness-[1.07] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(0,0,0,0.12),0_0_0_1px_color-mix(in_oklab,var(--accent)_70%,transparent),var(--shadow-sm)] ' +
    'active:brightness-95 ' +
    'disabled:bg-none disabled:bg-surface-3 disabled:text-fg-4 disabled:shadow-[inset_0_0_0_1px_var(--hairline)] disabled:brightness-100',
  secondary:
    'bg-surface-3 text-fg shadow-[var(--highlight),0_0_0_1px_var(--hairline)] hover:bg-surface-4 ' +
    'disabled:bg-surface-2 disabled:text-fg-4 disabled:shadow-[inset_0_0_0_1px_var(--hairline-soft)]',
  outline: 'bg-transparent text-fg shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-hover disabled:text-fg-4 disabled:shadow-[inset_0_0_0_1px_var(--hairline)]',
  ghost: 'bg-transparent text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-4',
  danger:
    'bg-danger-soft text-danger shadow-[inset_0_0_0_1px_var(--danger-border)] hover:bg-[color-mix(in_oklab,var(--danger)_22%,transparent)] ' +
    'disabled:bg-surface-2 disabled:text-fg-4 disabled:shadow-[inset_0_0_0_1px_var(--hairline-soft)]'
}

const sizes: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs rounded-sm [&_svg]:size-3.5',
  sm: 'h-7 px-2.5 text-sm rounded-md [&_svg]:size-3.5',
  md: 'h-8 px-3.5 text-ui rounded-md [&_svg]:size-4',
  lg: 'h-10 px-5 text-md rounded-card [&_svg]:size-4'
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  /** Render as the child element (e.g. a link). */
  asChild?: boolean
  leading?: ReactNode
  trailing?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, asChild, leading, trailing, className, children, disabled, ...props },
  ref
) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (props.type ?? 'button')}
      className={cn(base, variants[variant], sizes[size], loading && 'disabled:text-fg-3', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <Spinner size={size === 'lg' ? 16 : 14} /> : leading}
          {children}
          {trailing}
        </>
      )}
    </Comp>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label; also shown as tooltip unless `tooltip={false}`. */
  label: string
  tooltip?: boolean
  hotkey?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger'
  /** Pressed/toggled-on state (e.g. an open panel). Use sparingly: toggles read as icons, not filled tiles. */
  active?: boolean
}

const iconSizes = {
  xs: 'size-6 rounded-sm [&_svg]:size-3.5',
  sm: 'size-7 rounded-md [&_svg]:size-4',
  md: 'size-8 rounded-md [&_svg]:size-4',
  lg: 'size-10 rounded-card [&_svg]:size-[18px]'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip = true, hotkey, size = 'sm', variant = 'ghost', active, className, children, ...props },
  ref
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-active={active || undefined}
      className={cn(base, variants[variant], iconSizes[size], 'px-0 data-[active]:bg-active data-[active]:text-fg', className)}
      {...props}
    >
      {children}
    </button>
  )
  return tooltip ? (
    <Tooltip content={label} hotkey={hotkey}>
      {button}
    </Tooltip>
  ) : (
    button
  )
})
