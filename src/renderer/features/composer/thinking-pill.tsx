import { useState } from 'react'
import { DropdownMenu as RDropdown } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import type { ThinkingLevel } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { floatingSurface, Kbd, listRowClass, Spinner, Tooltip } from '../../ui'
import { ThinkingMeter } from '../chat/ThinkingControl'
import { setThinkingLevel } from './operations'

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export const THINKING_INFO: Record<ThinkingLevel, string> = {
  off: 'No extended reasoning, fastest',
  minimal: 'A quick check before answering',
  low: 'Light reasoning for everyday tasks',
  medium: 'Balanced depth and speed',
  high: 'Deep reasoning for hard problems',
  xhigh: 'Extra-deep reasoning',
  max: 'The full reasoning budget'
}

/** Footer pill showing the thinking level; opens a compact level picker (levels from get_available_thinking_levels). */
export function ThinkingPill({ agentId }: { agentId: string }) {
  const level = useAgents((s) => s.agents[agentId]?.thinkingLevel)
  const levels = useAgents((s) => s.agents[agentId]?.thinkingLevels)
  const changing = useAgents((state) => state.agents[agentId]?.modelChangePending ?? false)
  const ready = useAgents((state) => state.agents[agentId]?.status === 'ready')
  const [open, setOpen] = useState(false)
  if (!level || !levels || levels.length <= 1) return null

  return (
    <RDropdown.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Thinking level" hotkey="shift+tab" side="top">
        <RDropdown.Trigger asChild>
          <button
            type="button"
            aria-label={`Thinking level: ${THINKING_LABELS[level]}`}
            aria-busy={changing}
            disabled={!ready}
            className={cn(
              'no-drag pressable inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors duration-[var(--dur-instant)] hover:bg-hover data-[state=open]:bg-active data-[state=open]:text-fg @max-[40em]/composer:gap-1.5',
              level === 'off' ? 'text-fg-3 hover:text-fg-2' : 'text-fg-2 hover:text-fg'
            )}
          >
            <span className="relative inline-flex">
              <ThinkingMeter level={level} className={changing ? 'invisible' : undefined} />
              {changing && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Spinner size={11} />
                </span>
              )}
            </span>
            <span className="@max-[40em]/composer:hidden">{THINKING_LABELS[level]}</span>
            <ChevronDown className="size-3 shrink-0 text-fg-3" />
          </button>
        </RDropdown.Trigger>
      </Tooltip>
      <RDropdown.Portal>
        <RDropdown.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          className={cn(floatingSurface, 'w-[300px] p-1.5')}
        >
          <RDropdown.Label className="flex h-7 items-center justify-between px-2.5 text-xs font-medium text-fg-3">
            Thinking
            <span className="inline-flex items-center gap-1.5 font-normal">
              <Kbd combo="shift+tab" size="xs" /> cycles
            </span>
          </RDropdown.Label>
          <RDropdown.RadioGroup
            value={level}
            onValueChange={(next) => void setThinkingLevel(agentId, next as ThinkingLevel)}
          >
            {levels.map((l) => (
              <RDropdown.RadioItem
                key={l}
                value={l}
                className={cn(listRowClass({ density: 'list' }), 'cursor-default')}
              >
                <span className="flex w-6 shrink-0 justify-center">
                  <ThinkingMeter level={l} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('truncate', l === level ? 'font-medium text-fg' : undefined)}>
                    {THINKING_LABELS[l]}
                  </span>
                  <span className="truncate text-xs text-fg-3">{THINKING_INFO[l]}</span>
                </span>
                <RDropdown.ItemIndicator>
                  <Check className="size-3.5 text-fg" strokeWidth={2.5} />
                </RDropdown.ItemIndicator>
              </RDropdown.RadioItem>
            ))}
          </RDropdown.RadioGroup>
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  )
}
