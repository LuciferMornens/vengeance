import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

/** Shared text-field look (also for custom fields): r8 well, hairline, neutral focus ring. */
export const fieldClass =
  'w-full rounded-md bg-surface-2 text-fg placeholder:text-fg-3 shadow-[var(--highlight),0_0_0_1px_var(--hairline)] ' +
  'transition-[box-shadow,background-color] duration-[var(--dur-fast)] hover:shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong)] ' +
  'focus:shadow-focus focus:bg-surface-2 focus-visible:outline-none disabled:text-fg-3 disabled:shadow-[inset_0_0_0_1px_var(--hairline-soft)] ' +
  'aria-[invalid=true]:shadow-[0_0_0_1px_var(--danger-border),0_0_0_4px_var(--danger-soft)]'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode
  trailing?: ReactNode
  inputSize?: 'sm' | 'md'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ leading, trailing, inputSize = 'md', className, ...props }, ref) {
  const height = inputSize === 'sm' ? 'h-7 text-sm' : 'h-8 text-ui'
  if (!leading && !trailing) return <input ref={ref} className={cn(fieldClass, height, 'px-2.5', className)} {...props} />
  return (
    <div className={cn('relative flex items-center', className)}>
      {leading && <span className="pointer-events-none absolute left-2.5 flex text-fg-3 [&_svg]:size-3.5">{leading}</span>}
      <input ref={ref} className={cn(fieldClass, height, leading ? 'pl-8' : 'pl-2.5', trailing ? 'pr-8' : 'pr-2.5')} {...props} />
      {trailing && <span className="absolute right-2 flex text-fg-3">{trailing}</span>}
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldClass, 'min-h-20 resize-none px-2.5 py-2 text-ui leading-relaxed', className)} {...props} />
})
