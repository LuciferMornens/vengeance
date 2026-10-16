import type { ReactNode } from 'react'
import { Select as RSelect } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'
import { listRowClass } from './ListRow'
import { floatingSurface } from './Popover'

export interface SelectOption<V extends string> {
  value: V
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface SelectProps<V extends string> {
  value: V | undefined
  onValueChange: (value: V) => void
  options: SelectOption<V>[]
  placeholder?: string
  size?: 'sm' | 'md'
  className?: string
  disabled?: boolean
  'aria-label'?: string
}

export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  size = 'md',
  className,
  disabled,
  'aria-label': ariaLabel
}: SelectProps<V>) {
  const selectedLabel = options.find((option) => option.value === value)?.label

  return (
    <RSelect.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <RSelect.Trigger
        aria-label={ariaLabel}
        title={typeof selectedLabel === 'string' ? selectedLabel : undefined}
        className={cn(
          'no-drag inline-flex min-w-0 items-center justify-between gap-2 rounded-md bg-surface-2 px-2.5 text-fg outline-none',
          'shadow-[var(--highlight),0_0_0_1px_var(--hairline)] transition-[background-color,box-shadow] duration-[var(--dur-instant)] hover:bg-surface-3',
          'focus-visible:shadow-focus data-[state=open]:shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong)]',
          'data-[placeholder]:text-fg-3 disabled:text-fg-4 disabled:shadow-[inset_0_0_0_1px_var(--hairline-soft)]',
          size === 'sm' ? 'h-7 text-sm' : 'h-8 text-ui',
          className
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon className="shrink-0">
          <ChevronDown className="size-3.5 text-fg-3" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={10}
          className={cn(
            floatingSurface,
            'min-w-[var(--radix-select-trigger-width)] max-w-[var(--radix-select-content-available-width)] max-h-80'
          )}
        >
          <RSelect.Viewport>
            {options.map((option) => (
              <RSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(listRowClass({ density: 'menu' }), 'pr-8')}
              >
                <div className="min-w-0 whitespace-normal break-words">
                  <RSelect.ItemText>{option.label}</RSelect.ItemText>
                  {option.description && (
                    <div className="text-xs text-fg-3">{option.description}</div>
                  )}
                </div>
                <RSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-4 text-fg" />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  )
}
