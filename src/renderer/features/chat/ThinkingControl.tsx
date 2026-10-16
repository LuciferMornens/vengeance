import type { ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ThinkingLevel } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { DropdownMenu, toast, type MenuItem } from '../../ui'

const LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

const STRENGTH: Record<ThinkingLevel, number> = { off: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }
const BARS = [0, 1, 2, 3, 4]

/** Five ascending bars filled to the level's strength; minimal lights the first bar faintly, so it differs from low. */
export function ThinkingMeter({ level, className }: { level: ThinkingLevel; className?: string }) {
  const strength = STRENGTH[level]
  const lit = level === 'minimal' ? 'bg-fg-3' : 'bg-fg-2'
  return (
    <span className={cn('inline-flex h-3 items-end gap-[2px]', className)} aria-hidden>
      {BARS.map((i) => (
        <span
          key={i}
          className={cn('w-[3px] rounded-[1px] transition-colors duration-[var(--dur-base)]', i < strength ? lit : 'bg-[var(--hairline-strong)]')}
          style={{ height: `${4 + i * 2}px` }}
        />
      ))}
    </span>
  )
}

export interface ThinkingControlProps {
  agentId: string
  /** Custom trigger (rendered via asChild). Without it the control shows its own pill. */
  children?: ReactElement
  align?: 'start' | 'center' | 'end'
}

/** Thinking-level menu (get_available_thinking_levels / set_thinking_level). Hidden for non-reasoning models. */
export function ThinkingControl({ agentId, children, align = 'end' }: ThinkingControlProps) {
  const level = useAgents((s) => s.agents[agentId]?.thinkingLevel)
  const levels = useAgents((s) => s.agents[agentId]?.thinkingLevels)
  if (!level || !levels || levels.length <= 1) return null

  const items: MenuItem[] = [
    { kind: 'label', label: 'Thinking effort' },
    ...levels.map((l) => ({
      label: LABELS[l] ?? l,
      icon: <ThinkingMeter level={l} />,
      checked: l === level,
      onSelect: () =>
        void useAgents
          .getState()
          .setThinkingLevel(agentId, l)
          .catch((e: Error) => toast({ level: 'error', title: 'Could not change thinking level', description: e.message }))
    }))
  ]

  return (
    <DropdownMenu
      align={align}
      items={items}
      trigger={
        children ?? (
          <button
            type="button"
            className="no-drag inline-flex h-7 items-center gap-2 rounded-md px-2.5 text-sm text-fg-2 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <ThinkingMeter level={level} />
            <span className="font-medium">{LABELS[level] ?? level}</span>
            <ChevronDown className="size-3.5 text-fg-3" />
          </button>
        )
      }
    />
  )
}
