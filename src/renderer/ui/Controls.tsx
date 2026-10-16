import { Checkbox as RCheckbox, Slider as RSlider, Switch as RSwitch } from 'radix-ui'
import { Check, Minus } from 'lucide-react'
import { cn } from '../lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

export function Switch({ checked, onCheckedChange, disabled, size = 'md', className, ...rest }: SwitchProps) {
  const sm = size === 'sm'
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={rest['aria-label']}
      className={cn(
        'no-drag group/switch relative inline-flex shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-[var(--dur-base)] ease-out',
        'bg-surface-4 shadow-[inset_0_0_0_1px_var(--hairline-strong)] data-[state=unchecked]:hover:bg-[color-mix(in_oklab,var(--surface-4)_90%,var(--fg))]',
        'data-[state=checked]:bg-control-on data-[state=checked]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--control-on)_70%,black),inset_0_1px_0_rgba(255,255,255,0.18)] data-[state=checked]:hover:brightness-105',
        'focus-visible:outline-offset-2',
        'disabled:opacity-40 disabled:saturate-0',
        sm ? 'h-4 w-7' : 'h-5 w-9',
        className
      )}
    >
      <RSwitch.Thumb
        className={cn(
          'block rounded-full bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.3)] transition-[transform,width] duration-[var(--dur-base)] ease-[var(--ease-spring)]',
          sm ? 'size-3 translate-x-0.5 data-[state=checked]:translate-x-[14px]' : 'size-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]'
        )}
      />
    </RSwitch.Root>
  )
}

export interface CheckboxProps {
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function Checkbox({ checked, onCheckedChange, disabled, className, ...rest }: CheckboxProps) {
  return (
    <RCheckbox.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      aria-label={rest['aria-label']}
      className={cn(
        'no-drag inline-flex size-4 shrink-0 items-center justify-center rounded-xs bg-surface-2 text-accent-fg transition-[background-color,box-shadow] duration-[var(--dur-instant)]',
        'shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--fg)_28%,transparent)] data-[state=checked]:bg-control-on data-[state=indeterminate]:bg-control-on',
        'data-[state=checked]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--control-on)_70%,black)] data-[state=indeterminate]:shadow-none disabled:opacity-40',
        className
      )}
    >
      <RCheckbox.Indicator>{checked === 'indeterminate' ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}</RCheckbox.Indicator>
    </RCheckbox.Root>
  )
}

export interface SliderProps {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

export function Slider({ value, onValueChange, min = 0, max = 100, step = 1, disabled, className, ...rest }: SliderProps) {
  return (
    <RSlider.Root
      value={[value]}
      onValueChange={(v) => onValueChange(v[0] ?? value)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('no-drag relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-45', className)}
    >
      <RSlider.Track className="relative h-1 grow overflow-hidden rounded-full bg-surface-4">
        <RSlider.Range className="absolute h-full rounded-full bg-control-on" />
      </RSlider.Track>
      <RSlider.Thumb
        aria-label={rest['aria-label']}
        className="block size-3.5 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_1px_4px_rgba(0,0,0,0.4)] transition-transform duration-[var(--dur-fast)] hover:scale-110 active:scale-95"
      />
    </RSlider.Root>
  )
}
