import { memo, useEffect, useState } from 'react'
import { ChevronRight, EyeOff } from 'lucide-react'
import type { ThinkingContent } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { useAgents } from '../../store/agents'
import { Shimmer, Tooltip } from '../../ui'
import { Collapse } from '../../ui/Collapse'
import { useDisclosure } from '../tools'
import { useThinkingHidden } from './thinking-visibility'

/** Client-side timing of thinking blocks seen live (history has no timing → "Thought"). */
type ThinkingTiming = { start: number; end?: number }
const timings = new Map<string, Map<string, ThinkingTiming>>()
const unsubscribeTimings = useAgents.subscribe((state, previous) => {
  if (state.order === previous.order) return
  for (const agentId of timings.keys()) {
    if (!state.agents[agentId]) timings.delete(agentId)
  }
})
import.meta.hot?.dispose(unsubscribeTimings)

function useThinkingTiming(agentId: string, key: string, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  let sessionTimings = timings.get(agentId)
  if (live && !sessionTimings) {
    sessionTimings = new Map()
    timings.set(agentId, sessionTimings)
  }
  if (live && !sessionTimings?.has(key)) sessionTimings?.set(key, { start: Date.now() })
  const timing = sessionTimings?.get(key)
  if (!live && timing && timing.end === undefined) timing.end = Date.now()
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [live])
  if (!timing) return null
  const end = timing.end ?? now
  return Math.max(1, Math.round((end - timing.start) / 1000))
}

function BrainGlyph({ live }: { live: boolean }) {
  return (
    <span className="relative flex size-4 items-center justify-center">
      {live && (
        <span className="absolute inset-0 animate-[v-pulse_1.6s_ease-in-out_infinite] rounded-full bg-accent-soft" />
      )}
      <svg
        viewBox="0 0 16 16"
        className={cn('relative size-3.5', live ? 'text-accent-text' : 'text-fg-3')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        <path d="M8 2.5v11" opacity="0.55" />
        <path d="M5.5 3.2A2.3 2.3 0 0 0 3.6 6.4a2.4 2.4 0 0 0-.6 3.9 2.3 2.3 0 0 0 2.4 3.2A2 2 0 0 0 8 13.5" />
        <path d="M10.5 3.2a2.3 2.3 0 0 1 1.9 3.2 2.4 2.4 0 0 1 .6 3.9 2.3 2.3 0 0 1-2.4 3.2A2 2 0 0 1 8 13.5" />
        <path d="M5.5 3.2A2 2 0 0 1 8 2.5a2 2 0 0 1 2.5.7" />
      </svg>
    </span>
  )
}

/**
 * "Thinking… 4s" shimmer chip while streaming; "Thought for 12s" afterwards, expandable to the reasoning.
 * Consecutive settled blocks share one chip ("Thought ×2") with every block in the expand.
 * With `hideThinkingBlock` (Ctrl+T) only the chip remains: no live preview and nothing to expand.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  agentId,
  itemKey,
  blocks,
  live
}: {
  agentId: string
  itemKey: string
  blocks: ThinkingContent[]
  live: boolean
}) {
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd)
  const engine = useAgents((s) => s.agents[agentId]?.info.engine ?? 'pi')
  const hidden = useThinkingHidden(cwd, engine)
  const [open, setOpen] = useDisclosure(`thinking:${itemKey}`, false)
  const seconds = useThinkingTiming(agentId, itemKey, live)
  const texts = blocks.map((block) => block.thinking.trim()).filter(Boolean)
  const text = texts.join('\n\n')
  const expandable = !!text && !hidden
  const redacted = blocks.every((block) => block.redacted) && !text
  const count = blocks.length > 1 ? ` \u00d7${blocks.length}` : ''
  const label = redacted
    ? 'Reasoning hidden by the provider'
    : seconds && !count
      ? `Thought for ${seconds}s`
      : `Thought${count}`
  const chip = (
    <button
      type="button"
      disabled={!expandable && !hidden}
      aria-expanded={expandable ? open : undefined}
      onClick={() => expandable && setOpen(!open)}
      data-thinking-hidden={hidden || undefined}
      className={cn(
        'group inline-flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-sm transition-colors duration-[var(--dur-instant)]',
        expandable ? 'text-fg-3 hover:bg-hover hover:text-fg-2' : 'cursor-default text-fg-3'
      )}
    >
      <BrainGlyph live={live} />
      {live ? (
        <span className="flex items-center gap-1.5">
          <Shimmer className="font-medium">Thinking…</Shimmer>
          {seconds !== null && <span className="text-xs text-fg-3 tabular">{seconds}s</span>}
        </span>
      ) : (
        <span>{label}</span>
      )}
      {hidden && text ? <EyeOff className="size-3 text-fg-4" aria-label="Hidden" /> : null}
      {expandable && (
        <ChevronRight
          className={cn(
            'size-3 text-fg-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
            open && 'rotate-90'
          )}
        />
      )}
    </button>
  )
  return (
    <div className="-ml-1.5">
      {hidden && text ? (
        <Tooltip content="Thinking is hidden" hotkey="mod+t" side="right">
          {chip}
        </Tooltip>
      ) : (
        chip
      )}
      {live && !open && expandable && (
        // Exactly two lines of the latest reasoning, cut on a line boundary: plain text, no fade or shimmer.
        <div className="mt-0.5 ml-[13px] flex h-[42px] flex-col justify-end overflow-hidden border-l-2 border-hairline-strong pl-4 text-[13px] leading-[21px] text-fg-2">
          <p>{text.slice(-320)}</p>
        </div>
      )}
      <Collapse open={open && expandable}>
        <div className="selectable mt-1.5 mb-1 ml-[13px] flex flex-col gap-3 border-l-2 border-hairline-strong pl-4 text-[13.5px] leading-[1.6] whitespace-pre-wrap text-fg-2">
          {texts.map((blockText, i) => (
            <p key={i}>{blockText}</p>
          ))}
        </div>
      </Collapse>
    </div>
  )
})
