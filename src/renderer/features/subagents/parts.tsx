import { motion } from 'motion/react'
import { Check, CircleSlash, Flag, MoreHorizontal, Pause, Square, X } from 'lucide-react'
import { formatSubagentDuration } from '@shared/subagents'
import { cn } from '../../lib/cn'
import { DropdownMenu, IconButton, listRowClass, toast, type MenuItem } from '../../ui'
import { subagentActions } from './actions'
import { formatClock } from './format'
import type { SubagentChildView, SubagentRunView } from './store'

type GlyphState = SubagentRunView['state']

/**
 * The live dot pulses three times when it appears, then stays solid (no infinite animation). It is amber
 * (`accent-2`) with a soft halo so it never reads as the rose danger dot at 6px.
 */
function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex size-1.5 shrink-0', className)}>
      <motion.span
        aria-hidden
        className="absolute inset-[-3px] rounded-full bg-accent-2"
        initial={{ opacity: 0.45, scale: 0.6 }}
        animate={{ opacity: 0, scale: 1.8 }}
        transition={{ duration: 0.9, repeat: 2, ease: 'easeOut' }}
      />
      <span className="relative size-1.5 rounded-full bg-accent-2 shadow-[0_0_0_2px_var(--accent-soft)]" />
    </span>
  )
}

/** 14px state glyph shared by the fleet popover, the Agents tab and its children list. */
export function RunGlyph({ state, needsDecision, unseen }: { state: GlyphState; needsDecision?: boolean; unseen?: boolean }) {
  const box = 'flex size-3.5 shrink-0 items-center justify-center'
  if (needsDecision) return <Flag className={cn(box, 'size-3.5 text-warning')} strokeWidth={2.25} aria-label="Needs you" />
  switch (state) {
    case 'running':
      return (
        <span className={box} aria-label="Running">
          <LiveDot />
        </span>
      )
    case 'queued':
      return (
        <span className={box} aria-label="Queued">
          <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.25px_var(--fg-3)]" />
        </span>
      )
    case 'complete':
      return <Check className={cn(box, 'text-fg-3')} strokeWidth={2.5} aria-label="Done" />
    case 'failed':
    case 'rejected':
      return (
        <span className={cn(box, 'rounded-xs bg-danger-soft text-danger', unseen && 'shadow-[inset_0_0_0_1px_var(--danger-border)]')} aria-label="Failed">
          <X className="size-2.5" strokeWidth={3} />
        </span>
      )
    case 'stopped':
      return <Square className={cn(box, 'size-3 text-fg-3')} strokeWidth={2.25} aria-label="Stopped" />
    case 'paused':
      return <Pause className={cn(box, 'size-3 text-fg-3')} strokeWidth={2.25} aria-label="Paused" />
    case 'partial':
      return <CircleSlash className={cn(box, 'size-3 text-fg-3')} strokeWidth={2.25} aria-label="Partly done" />
    default:
      return (
        <span className={box} aria-label="No live status">
          <span className="size-1.5 rounded-full shadow-[inset_0_0_0_1.25px_var(--fg-4)]" />
        </span>
      )
  }
}

const STATE_WORD: Record<GlyphState, string> = {
  queued: 'queued',
  running: 'running',
  complete: 'done',
  failed: 'failed',
  partial: 'partly done',
  paused: 'paused',
  stopped: 'stopped',
  rejected: 'rejected',
  unknown: 'no live status'
}

/** Pill/badge label for a state (sentence case). */
export function stateLabel(view: Pick<SubagentRunView, 'state' | 'needsDecision'>): string {
  if (view.needsDecision) return 'Needs you'
  const word = STATE_WORD[view.state]
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** What the run is doing right now, in a few words; nothing once done (the glyph says so). */
export function activityLabel(view: SubagentRunView | SubagentChildView, now: number): { text: string; tone: 'neutral' | 'warning' | 'danger' } {
  if ('needsDecision' in view && view.needsDecision) return { text: 'needs you', tone: 'warning' }
  const attention = 'attention' in view && view.attention !== undefined
  if (view.state === 'running') {
    if (view.children.length > 0 && 'kind' in view && view.kind === 'workflow') {
      const done = view.children.filter((child) => child.state === 'complete').length
      return { text: `${done} of ${view.children.length}`, tone: 'neutral' }
    }
    if (view.currentTool) {
      const open = view.currentToolStartedAt !== undefined ? ` · ${formatSubagentDuration(now - view.currentToolStartedAt)}` : ''
      return { text: `${view.currentTool}${open}`, tone: attention ? 'warning' : 'neutral' }
    }
    return { text: 'working', tone: 'neutral' }
  }
  if (view.state === 'complete') return { text: '', tone: 'neutral' }
  return { text: STATE_WORD[view.state], tone: view.state === 'failed' || view.state === 'rejected' ? 'danger' : 'neutral' }
}

/** Live clock while active; total time once settled. */
export function elapsedLabel(view: Pick<SubagentRunView, 'startedAt' | 'endedAt' | 'state'>, now: number): string | undefined {
  if (view.startedAt === undefined) return undefined
  if (view.state === 'running' || view.state === 'paused') return formatClock(now - view.startedAt)
  if (view.endedAt === undefined) return undefined
  return formatSubagentDuration(view.endedAt - view.startedAt)
}

const ACTIVITY_TONE = { neutral: 'text-fg-3', warning: 'text-warning', danger: 'text-danger' } as const

/** Title of a workflow launched without a name or task: `2-step workflow`. */
function workflowTitle(steps: number): string {
  return steps > 0 ? `${steps}-step workflow` : 'Workflow'
}

/** One 36px run row: glyph · agent · title · activity · elapsed · ⋯. */
export function AgentRow({
  view,
  now,
  unseen,
  onOpen,
  menu
}: {
  view: SubagentRunView
  now: number
  unseen?: boolean
  onOpen: () => void
  menu?: MenuItem[]
}) {
  const activity = activityLabel(view, now)
  const elapsed = elapsedLabel(view, now)
  const title = view.title ?? (view.kind === 'workflow' ? workflowTitle(view.children.length) : undefined)
  return (
    <div className={cn(listRowClass({ density: 'list' }), 'cursor-default pr-1')} data-subagent-row={view.state}>
      <button
        type="button"
        onClick={onOpen}
        className="absolute inset-0 rounded-md focus-visible:-outline-offset-2"
        aria-label={`Open ${view.label}`}
      />
      <RunGlyph state={view.state} needsDecision={view.needsDecision} unseen={unseen} />
      <span className="pointer-events-none flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-sm font-medium text-fg">{view.label}</span>
        {title && <span className="min-w-0 truncate text-sm text-fg-3">{title}</span>}
      </span>
      {activity.text && <span className={cn('pointer-events-none w-[72px] shrink-0 truncate text-right text-xs', ACTIVITY_TONE[activity.tone])}>{activity.text}</span>}
      <span className="tabular pointer-events-none w-11 shrink-0 text-right text-xs text-fg-3">{elapsed}</span>
      {menu ? (
        <span className="relative opacity-0 transition-opacity duration-[var(--dur-instant)] group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
          <DropdownMenu
            align="end"
            items={menu}
            trigger={
              <IconButton label="More" size="xs">
                <MoreHorizontal />
              </IconButton>
            }
          />
        </span>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </div>
  )
}

/** Child rows of a workflow (one level; deeper levels collapse into "+N more"). */
export function ChildRows({ items, now, onOpen }: { items: SubagentChildView[]; now: number; onOpen: (child: SubagentChildView) => void }) {
  return (
    <div className="flex flex-col">
      {items.map((child) => {
        const activity = activityLabel(child, now)
        const nested = child.children.length
        return (
          <button
            key={child.id}
            type="button"
            onClick={() => onOpen(child)}
            className={cn(listRowClass({ density: 'menu' }), 'pl-6')}
            data-subagent-child={child.state}
          >
            <RunGlyph state={child.state} />
            <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{child.label}</span>
            {nested > 0 && <span className="text-xs text-fg-3">+{nested} more</span>}
            {activity.text && <span className={cn('w-[72px] shrink-0 truncate text-right text-xs', ACTIVITY_TONE[activity.tone])}>{activity.text}</span>}
            <span className="tabular w-11 shrink-0 text-right text-xs text-fg-3">{elapsedLabel(child, now)}</span>
            <span className="w-6 shrink-0" />
          </button>
        )
      })}
    </div>
  )
}

/** Overflow menu shared by fleet rows and the detail header. */
export function runMenu(agentId: string, view: SubagentRunView, open: (intent?: 'steer') => void): MenuItem[] {
  const live = view.state === 'running' || view.state === 'queued' || view.state === 'paused'
  const items: MenuItem[] = [{ label: 'Open', onSelect: () => open() }]
  if (live) {
    items.push({ label: 'Steer…', onSelect: () => open('steer') })
    items.push({
      label: 'Stop',
      danger: true,
      onSelect: () => {
        subagentActions.stop(agentId, { runId: view.runId }).catch((error: Error) => toast({ level: 'error', title: `Couldn't stop ${view.label}`, description: error.message }))
      }
    })
  }
  items.push({ kind: 'separator' }, { label: 'Copy run ID', onSelect: () => void navigator.clipboard.writeText(view.runId) })
  return items
}
