import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AtSign, Slash, SquareTerminal } from 'lucide-react'
import type { EngineId } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { useWindowFocused } from '../../lib/window-focus'
import { matchBuiltin } from './builtins'

const PLACEHOLDER_INTERVAL_MS = 4200

/**
 * Shows each hint once, ending on the one it started from, and rests there: rotating forever would keep an idle
 * window producing frames. A background window does not rotate; focusing the window starts another pass.
 */
export function RotatingPlaceholder({ hints }: { hints: string[] }) {
  const [index, setIndex] = useState(0)
  const focused = useWindowFocused()
  useEffect(() => {
    if (hints.length < 2 || !focused) return
    let steps = 0
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % hints.length)
      steps++
      if (steps === hints.length) clearInterval(timer)
    }, PLACEHOLDER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hints, focused])
  const hint = hints[index % hints.length]
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 h-9 overflow-hidden text-prose leading-[22px] text-fg-3"
      aria-hidden
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={hint}
          className="absolute inset-x-3 top-[7px] block truncate"
          initial={{ opacity: 0, y: 6 }}
          animate={{
            opacity: 1,
            y: 0,
            transition: { delay: 0.12, duration: 0.22, ease: [0.16, 1, 0.3, 1] }
          }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
        >
          {hint}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

interface ModeHintProps {
  text: string
  bashMode: 'include' | 'exclude' | null
  engine: EngineId
}

export function ModeHint({ text, bashMode, engine }: ModeHintProps) {
  const hint = bashMode
    ? {
        icon: <SquareTerminal />,
        label:
          bashMode === 'exclude'
            ? 'Shell · output kept out of context'
            : engine === 'prime'
              ? 'Shell · output kept in history'
              : 'Shell · output added to context',
        tone: 'text-warning'
      }
    : text.startsWith('/')
      ? {
          icon: <Slash />,
          label: matchBuiltin(text, engine) ? 'App command' : 'Command',
          tone: 'text-fg-3'
        }
      : /(^|\s)@\S/.test(text)
        ? { icon: <AtSign />, label: 'Files mentioned', tone: 'text-fg-3' }
        : null
  return (
    // popLayout: a changed hint shows at once while the old one fades out in place. A zero basis gives the hint
    // only the footer space the controls leave, so it truncates to its glyph before the model name gives way.
    <AnimatePresence mode="popLayout">
      {hint && (
        <motion.span
          key={hint.label}
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0 }}
          transition={spring.snappy}
          title={hint.label}
          className={cn(
            'ml-1 hidden min-w-5 grow basis-0 items-center gap-1.5 text-xs @min-[52em]/composer:inline-flex [&_svg]:size-3.5 [&_svg]:shrink-0',
            hint.tone
          )}
        >
          {hint.icon}
          <span className="truncate">{hint.label}</span>
        </motion.span>
      )}
    </AnimatePresence>
  )
}
