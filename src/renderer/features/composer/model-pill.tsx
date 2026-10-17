import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { shortcutText } from '../../lib/keybindings'
import { useAgents } from '../../store/agents'
import { Spinner } from '../../ui'
import { ModelPicker, ProviderTile } from '../chat/ModelPicker'

const openers = new Map<string, () => void>()

/** Open the footer model picker of `agentId`; false when that session has no mounted composer. */
export function openModelPicker(agentId: string): boolean {
  const open = openers.get(agentId)
  open?.()
  return !!open
}

/** Composer footer model pill → the one shared ModelPicker popover (SPEC §9.1), styled like the thinking pill. */
export function ModelPill({ agentId }: { agentId: string }) {
  const model = useAgents((s) => s.agents[agentId]?.model)
  const changing = useAgents((state) => state.agents[agentId]?.modelChangePending ?? false)
  const ready = useAgents((state) => state.agents[agentId]?.status === 'ready')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const show = () => setOpen(true)
    openers.set(agentId, show)
    return () => {
      if (openers.get(agentId) === show) openers.delete(agentId)
    }
  }, [agentId])

  if (!model) return null

  return (
    <ModelPicker agentId={agentId} side="top" align="start" open={open} onOpenChange={setOpen}>
      <button
        type="button"
        aria-label={`Model: ${model.name}`}
        aria-busy={changing}
        disabled={!ready}
        title={`Change model (${shortcutText('mod+l')})`}
        className="no-drag pressable inline-flex h-7 max-w-[220px] min-w-0 items-center gap-2 rounded-md px-2 text-xs font-medium whitespace-nowrap text-fg-2 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
      >
        {changing ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            <Spinner size={11} />
          </span>
        ) : (
          <ProviderTile provider={model.provider} />
        )}
        <span className="truncate">{model.name}</span>
        <ChevronDown className="size-3 shrink-0 text-fg-3" />
      </button>
    </ModelPicker>
  )
}
