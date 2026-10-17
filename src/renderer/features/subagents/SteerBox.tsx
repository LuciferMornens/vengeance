import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft } from 'lucide-react'
import type { SubagentSupervisorRequest } from '@shared/subagents'
import { isImeComposing } from '../../lib/keybindings'
import { spring } from '../../lib/motion'
import { Button, SegmentedControl, Textarea, toast } from '../../ui'
import { subagentActions } from './actions'
import { openSubagentDetail } from './open'
import type { SubagentTarget } from './store'

/** How long the receipt word ("Delivered", "Queued") stays on the send button. */
const RECEIPT_MS = 2000
/** The box grows with its text up to four lines (20px line height + 12px padding), then scrolls. */
const MAX_HEIGHT = 4 * 20 + 12

type SteerMode = 'steer' | 'follow_up'

export type SteerBoxMode = { kind: 'steer' } | { kind: 'resume' } | { kind: 'reply'; request: SubagentSupervisorRequest }

const ACTION: Record<SteerBoxMode['kind'], string> = { steer: 'Send', resume: 'Resume', reply: 'Answer' }

/**
 * Message box in the run detail. `steer` talks to a running agent (now, or after its current turn); `resume`
 * revives a finished run with the message and opens the new run; `reply` answers a supervisor request (through
 * the parent model, which relays it with `subagent_supervisor`).
 */
export function SteerBox({
  agentId,
  target,
  label,
  mode,
  onClose
}: {
  agentId: string
  target: SubagentTarget
  label: string
  mode: SteerBoxMode
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [timing, setTiming] = useState<SteerMode>('steer')
  const [sending, setSending] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => input.current?.focus(), [])
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])
  useEffect(() => {
    if (!receipt) return
    const timer = setTimeout(() => setReceipt(null), RECEIPT_MS)
    return () => clearTimeout(timer)
  }, [receipt])

  const send = async () => {
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    try {
      if (mode.kind === 'resume') {
        const next = await subagentActions.resume(agentId, target.runId, message)
        setText('')
        onClose()
        openSubagentDetail(agentId, next.runId)
        return
      }
      if (mode.kind === 'reply') {
        await subagentActions.replyToSupervisor(agentId, mode.request, message)
        setText('')
        onClose()
        return
      }
      const result = await subagentActions.steer(agentId, target, message, timing)
      if (result.delivery === 'failed') throw new Error(result.error ?? 'No reply')
      setText('')
      setReceipt(result.delivery === 'delivered' ? 'Delivered' : 'Queued')
    } catch (error) {
      toast({ level: 'error', title: `Couldn't reach ${label}`, description: (error as Error).message })
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)) {
      event.preventDefault()
      void send()
    }
  }

  const action = ACTION[mode.kind]
  const placeholder = { steer: `Guide ${label}…`, resume: `Tell ${label} how to continue…`, reply: `Your answer to ${label}…` }[mode.kind]
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={spring.snappy}
      className="overflow-hidden"
      data-steer-box={mode.kind}
    >
      <div className="flex flex-col gap-2 pt-3">
        <Textarea
          ref={input}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={mode.kind === 'steer' ? `Message to ${label}` : mode.kind === 'resume' ? `Message to resume ${label}` : `Answer to ${label}`}
          placeholder={placeholder}
          className="min-h-0 py-1.5 text-sm leading-5"
        />
        <div className="flex items-center gap-2">
          {mode.kind === 'steer' && (
            <SegmentedControl
              size="sm"
              aria-label="When to deliver"
              value={timing}
              onValueChange={setTiming}
              segments={[
                { value: 'steer', label: 'Now' },
                { value: 'follow_up', label: 'After this turn' }
              ]}
            />
          )}
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" variant="primary" loading={sending} disabled={!text.trim() && !receipt} onClick={() => void send()} trailing={receipt ? undefined : <CornerDownLeft />}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={receipt ?? action} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={spring.snappy}>
                {receipt ?? action}
              </motion.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>
    </motion.div>
  )
}
