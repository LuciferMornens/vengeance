import { useState, type ReactNode } from 'react'
import { GitBranchPlus, PencilLine, RotateCcw } from 'lucide-react'
import type { UserMessage } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { Spinner, Tooltip } from '../../ui'
import { CopyButton } from '../../ui/CopyButton'
import { editAndResend, forkFromTurn, retryTurn } from './session-actions'
import { userText, type TurnInfo } from './transcript-items'

function ActionButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => Promise<void>; disabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true)
          void onClick().finally(() => setBusy(false))
        }}
        className="no-drag inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5"
      >
        {busy ? <Spinner size={12} /> : icon}
      </button>
    </Tooltip>
  )
}

/** Hover actions under a user bubble: copy, edit & resend. */
export function UserActions({ agentId, message, className }: { agentId: string; message: UserMessage; className?: string }) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <CopyButton value={() => userText(message)} label="Copy message" />
      <ActionButton label="Edit & resend" icon={<PencilLine />} disabled={running} onClick={() => editAndResend(agentId, message)} />
    </div>
  )
}

/**
 * Actions after an assistant turn: copy markdown, fork from here, retry (latest turn only). The row floats in
 * the gap below its turn (absolute), so turns never reserve space for it; the latest turn shows it at rest.
 */
export function TurnActions({ agentId, turn, latest }: { agentId: string; turn: TurnInfo; latest: boolean }) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  if (latest && running) return null
  return (
    <div
      data-turn-actions
      className={cn(
        'absolute top-full left-0 z-[1] -ml-1.5 flex h-7 items-center gap-0.5 pt-1 transition-opacity duration-[var(--dur-base)]',
        latest ? 'opacity-100' : 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100'
      )}
    >
      {turn.texts.length > 0 && <CopyButton value={() => turn.texts.join('\n\n')} label="Copy response" />}
      <ActionButton label="Fork from here" icon={<GitBranchPlus />} disabled={running} onClick={() => forkFromTurn(agentId, turn)} />
      {latest && turn.prompt && <ActionButton label="Retry" icon={<RotateCcw />} disabled={running} onClick={() => retryTurn(agentId, turn)} />}
    </div>
  )
}
