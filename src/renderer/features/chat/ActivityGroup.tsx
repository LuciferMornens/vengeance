import { memo, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { ToolCall } from '@shared/engine-types'
import { cn } from '../../lib/cn'
import { formatDuration } from '../../lib/format'
import { duration, spring } from '../../lib/motion'
import type { ToolExecution } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { Spinner } from '../../ui'
import { useSubagentFleet } from '../subagents'
import {
  isActive,
  isBenignFailure,
  isPinnedRun,
  ToolCallView,
  ToolGroupContext,
  toolPhase,
  useDisclosureChoice,
  useToolsExpanded,
  useUserAnswerRelayIds,
  type ToolPhase
} from '../tools'
import { summarizeCalls, type RunLabel } from './activity-summary'

/** A settled group folds this long after its last call finishes, so the final check is seen first. */
const SETTLE_FOLD_MS = 400
/** Rows a live group shows (the most recently started ones); the header counts the rest. */
const LIVE_ROWS = 3
/** Pinned rows shown under a folded header before "+N more". */
const MAX_PINNED = 3
const SHELLS = new Set(['bash', 'powershell'])

/** The running shell that started last: the only row of a group that shows a live output tail. */
function tailOwner(
  calls: ToolCall[],
  phases: ToolPhase[],
  tools: Record<string, ToolExecution | undefined>
): string | null {
  let owner: string | null = null
  let latest = -1
  calls.forEach((call, i) => {
    if (!SHELLS.has(call.name) || phases[i] !== 'running') return
    const started = tools[call.id]?.startedAt ?? 0
    if (started >= latest) {
      latest = started
      owner = call.id
    }
  })
  return owner
}

/**
 * Consecutive tool calls of a turn. One call is just its row. Two or more get a one-line summary header
 * ("Explored 3 files · ran 1 command") over their rows: while live the latest rows show under it; once settled
 * it folds to the header alone (after a short beat), keeping only failed rows and still-live subagent runs
 * pinned under it. An explicit open/close by the user sticks (keyed by the first call), and Ctrl+O opens every
 * group. Benign errors (a `grep` with no matches) count as done; relays of the user's own supervisor answers are
 * left out (their request row shows the answer).
 */
export const ActivityGroup = memo(function ActivityGroup({
  agentId,
  calls: groupCalls
}: {
  agentId: string
  calls: ToolCall[]
}) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  // Only this group's executions: a store update elsewhere (another call streaming) does not re-render it.
  const executions = useAgents(
    useShallow((s) => groupCalls.map((c) => s.agents[agentId]?.tools[c.id]))
  )
  const relayIds = useUserAnswerRelayIds(agentId, groupCalls)
  const calls = useMemo(() => {
    const relays = new Set(relayIds.split(' '))
    return groupCalls.filter((call, i) => !relays.has(call.id) || executions[i]?.status === 'error')
  }, [groupCalls, executions, relayIds])
  const tools = useMemo(
    () => Object.fromEntries(groupCalls.map((c, i) => [c.id, executions[i]])),
    [groupCalls, executions]
  )
  const phases = useMemo(
    () =>
      calls.map((c) =>
        isBenignFailure(c, tools[c.id]) ? 'done' : toolPhase(tools[c.id], running)
      ),
    [calls, tools, running]
  )
  const owner = useMemo(() => tailOwner(calls, phases, tools), [calls, phases, tools])
  const groupContext = useMemo(() => ({ tailOwner: owner }), [owner])
  const fleet = useSubagentFleet(agentId)
  const pinnedIds = useMemo(() => {
    const liveRuns = new Set(fleet.active.map((run) => run.runId))
    return new Set(
      calls
        .filter((call, i) => phases[i] === 'error' || isPinnedRun(call, tools[call.id], liveRuns))
        .map((call) => call.id)
    )
  }, [calls, phases, tools, fleet.active])
  const labelFor = useMemo<RunLabel>(() => {
    const labels = new Map(fleet.all.map((run) => [run.runId, run.label]))
    return (runId) => labels.get(runId)
  }, [fleet.all])

  if (calls.length === 0) return null
  if (calls.length === 1) {
    return (
      <div
        data-activity-group
        data-has-pinned={pinnedIds.size > 0 || undefined}
        className="flex flex-col"
      >
        <ToolGroupContext.Provider value={groupContext}>
          <ToolCallView agentId={agentId} call={calls[0]!} />
        </ToolGroupContext.Provider>
      </div>
    )
  }
  return (
    <ToolGroupContext.Provider value={groupContext}>
      <MultiGroup
        agentId={agentId}
        calls={calls}
        phases={phases}
        tools={tools}
        pinnedIds={pinnedIds}
        labelFor={labelFor}
      />
    </ToolGroupContext.Provider>
  )
})

interface MultiGroupProps {
  agentId: string
  calls: ToolCall[]
  phases: ToolPhase[]
  tools: Record<string, ToolExecution | undefined>
  /** Calls that stay visible under the folded header (failures, live subagent runs). */
  pinnedIds: ReadonlySet<string>
  labelFor: RunLabel
}

function MultiGroup({ agentId, calls, phases, tools, pinnedIds, labelFor }: MultiGroupProps) {
  const toolsExpanded = useToolsExpanded()
  const durations = calls.map((c) => tools[c.id]?.durationMs ?? 0)
  const pending = phases.filter(isActive).length
  const active = pending > 0
  const failed = phases.filter((p) => p === 'error').length
  const stopped = phases.some((p) => p === 'aborted')
  const [choice, setChoice] = useDisclosureChoice(`group:${calls[0]!.id}`)
  const [liveOpen, setLiveOpen] = useState(active)

  useEffect(() => {
    if (active) {
      setLiveOpen(true)
      return
    }
    const timer = setTimeout(() => setLiveOpen(false), SETTLE_FOLD_MS)
    return () => clearTimeout(timer)
  }, [active])

  const showAll = choice === true || (choice === undefined && toolsExpanded)
  const open = choice ?? (toolsExpanded || liveOpen)
  const pinnedShown = [...pinnedIds].slice(0, MAX_PINNED)
  // Calls queued behind the running one have not started yet: the window ends at the latest started call.
  const started = phases.reduce((last, phase, i) => (phase === 'pending' ? last : i), -1)
  const visibleCalls = showAll
    ? calls
    : open
      ? calls.slice(Math.max(0, started + 1 - LIVE_ROWS), Math.max(started + 1, 1))
      : calls.filter((call) => pinnedShown.includes(call.id))
  const morePinned = !open ? pinnedIds.size - pinnedShown.length : 0
  const total = durations.reduce((a, b) => a + b, 0)
  const summary = useMemo(
    () => summarizeCalls(calls, tools, active, labelFor),
    [calls, tools, active, labelFor]
  )

  return (
    <div
      data-activity-group
      data-has-pinned={pinnedIds.size > 0 || undefined}
      className="flex flex-col"
    >
      <button
        type="button"
        data-group-header
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="group/stack -mx-1.5 flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-sm transition-colors duration-[var(--dur-instant)] hover:bg-hover"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-fg-3">
          {active ? (
            <Spinner size={13} className="text-fg-2" />
          ) : failed > 0 ? (
            <span className="inline-flex size-3.5 items-center justify-center rounded-xs bg-danger-soft text-danger">
              <X className="size-2.5" strokeWidth={3} />
            </span>
          ) : (
            <StackGlyph />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span
            className={cn(
              'truncate font-medium',
              active ? 'text-fg' : 'text-fg-2 group-hover/stack:text-fg'
            )}
          >
            {summary}
          </span>
          {failed > 0 && (
            <span className="shrink-0 font-medium text-danger">· {failed} failed</span>
          )}
          {stopped && !active && <span className="shrink-0 text-fg-3">· stopped</span>}
        </span>
        <span className="w-11 shrink-0 text-right text-xs text-fg-3 tabular">
          {active
            ? `${calls.length - pending}/${calls.length}`
            : total > 0
              ? formatDuration(total)
              : null}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] group-hover/stack:text-fg-2',
            open && 'rotate-90'
          )}
        />
      </button>
      <div className="flex flex-col pl-5">
        <AnimatePresence initial={false}>
          {visibleCalls.map((call) => (
            <motion.div
              key={call.id}
              initial={{ height: 0, opacity: 0 }}
              animate={{
                height: 'auto',
                opacity: 1,
                transition: { height: spring.layout, opacity: { duration: duration.base } }
              }}
              exit={{
                height: 0,
                opacity: 0,
                transition: { height: spring.snappy, opacity: { duration: duration.instant } }
              }}
              style={{ overflow: 'hidden' }}
              className="-mx-1.5 px-1.5"
            >
              <div data-pinned-row={pinnedIds.has(call.id) || undefined}>
                <ToolCallView agentId={agentId} call={call} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {morePinned > 0 && (
          <button
            type="button"
            onClick={() => setChoice(true)}
            className="h-6 self-start pl-6 text-xs text-fg-3 hover:text-fg"
          >
            +{morePinned} more
          </button>
        )}
      </div>
    </div>
  )
}

function StackGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 5.5 8 2.75l5.5 2.75L8 8.25z" />
      <path d="m2.5 8.25 5.5 2.75 5.5-2.75" opacity="0.7" />
      <path d="m2.5 11 5.5 2.75L13.5 11" opacity="0.45" />
    </svg>
  )
}
