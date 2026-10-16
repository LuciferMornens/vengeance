import { useState } from 'react'
import { motion } from 'motion/react'
import { GitBranch } from 'lucide-react'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { Button, Dialog, Textarea } from '../../ui'
import type { GoToPointOptions } from '../sessions/actions'

type Choice = 'none' | 'summary' | 'custom'

const CHOICES: Array<{ id: Choice; title: string; detail: string }> = [
  { id: 'none', title: 'No summary', detail: 'Jump straight there. The branch you leave stays in the tree.' },
  { id: 'summary', title: 'Summarize the branch', detail: 'Carries what it found into where you go. Uses one model call.' },
  { id: 'custom', title: 'Summarize with instructions', detail: 'Tell the summary what to keep.' }
]

/**
 * The engine's "Summarize branch?" prompt before moving in place (TUI /tree). Skipped entirely when
 * `branchSummary.skipPrompt` is on (the caller then moves without a summary).
 */
export function NavigateDialog({
  userMessage,
  running,
  onCancel,
  onConfirm
}: {
  /** The target is one of your messages (it goes back into the composer). */
  userMessage: boolean
  /** A response is streaming and will be stopped first. */
  running: boolean
  onCancel: () => void
  onConfirm: (options: GoToPointOptions) => Promise<boolean>
}) {
  const [choice, setChoice] = useState<Choice>('none')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)

  const confirm = async () => {
    if (busy || (choice === 'custom' && !instructions.trim())) return
    setBusy(true)
    const ok = await onConfirm({ summarize: choice !== 'none', customInstructions: choice === 'custom' ? instructions.trim() : undefined })
    setBusy(false)
    if (ok) onCancel()
  }

  const notes = [userMessage && 'Your message goes back into the composer to edit and resend.', running && 'The current response stops first.'].filter(Boolean)

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onCancel()}
      persistent={busy || choice === 'custom'}
      size="form"
      icon={<GitBranch />}
      title="Go to this point"
      description="You're leaving the current branch. Summarize it first?"
      hint={{ combo: 'mod+enter', label: 'to go' }}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={choice === 'custom' && !instructions.trim()} data-autofocus onClick={() => void confirm()}>
            {busy && choice !== 'none' ? 'Summarizing…' : 'Go to this point'}
          </Button>
        </>
      }
    >
      <div
        role="radiogroup"
        aria-label="Branch summary"
        className="flex flex-col gap-1.5 pb-1"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void confirm()
          }
        }}
      >
        {CHOICES.map((option) => {
          const active = option.id === choice
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              onClick={() => setChoice(option.id)}
              className={cn(
                'flex items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors duration-[var(--dur-instant)]',
                active ? 'bg-active shadow-[inset_0_0_0_1px_var(--hairline-strong)]' : 'hover:bg-hover'
              )}
            >
              <span className={cn('mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_1.5px_var(--fg-3)]', active && 'shadow-[inset_0_0_0_1.5px_var(--fg)]')}>
                {active && <motion.span layoutId="navigate-choice" transition={spring.snappy} className="size-1.5 rounded-full bg-fg" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="weight-row block text-ui text-fg">{option.title}</span>
                <span className="block text-xs leading-relaxed text-fg-3">{option.detail}</span>
              </span>
            </button>
          )
        })}
        {choice === 'custom' && (
          <Textarea
            autoFocus
            value={instructions}
            disabled={busy}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. Keep the failing test names and the API we ruled out."
            className="mt-1 min-h-[72px]"
          />
        )}
        {notes.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5 px-0.5 text-xs leading-relaxed text-fg-3">
            {notes.map((note) => (
              <span key={String(note)}>{note}</span>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
