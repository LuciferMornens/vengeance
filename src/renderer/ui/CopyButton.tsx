import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../lib/cn'
import { Tooltip } from './Tooltip'

/** Write text to the clipboard; resolves false when the clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export interface CopyButtonProps {
  /** Text to copy, or a function producing it at click time. */
  value: string | (() => string)
  label?: string
  className?: string
  /** Render the label next to the icon. */
  showLabel?: boolean
}

/** Icon button that copies and morphs into a check for a moment. */
export function CopyButton({ value, label = 'Copy', className, showLabel }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onClick = async () => {
    const ok = await copyText(typeof value === 'function' ? value() : value)
    if (!ok) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1400)
  }

  const button = (
    <button
      type="button"
      aria-label={label}
      onClick={() => void onClick()}
      className={cn(
        'no-drag inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs font-medium text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg',
        copied && 'text-success hover:text-success',
        className
      )}
    >
      <span className="relative inline-flex size-3.5">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? 'check' : 'copy'}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ duration: 0.14 }}
            className="absolute inset-0 inline-flex"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </motion.span>
        </AnimatePresence>
      </span>
      {showLabel && <span>{copied ? 'Copied' : label}</span>}
    </button>
  )
  return showLabel ? button : <Tooltip content={copied ? 'Copied' : label}>{button}</Tooltip>
}
