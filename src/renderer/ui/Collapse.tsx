import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { duration, spring } from '../lib/motion'

export interface CollapseProps {
  open: boolean
  children: ReactNode
  className?: string
}

/** Height + fade expand/collapse (layout spring in, snappy spring out); children unmount once collapsed. */
export function Collapse({ open, children, className }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="collapse"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1, transition: { height: spring.layout, opacity: { duration: duration.base } } }}
          exit={{ height: 0, opacity: 0, transition: { height: spring.snappy, opacity: { duration: duration.instant } } }}
          style={{ overflow: 'hidden' }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
