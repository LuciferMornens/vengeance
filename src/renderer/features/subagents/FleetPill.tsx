import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Flag, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { basename } from '../../lib/format'
import { spring } from '../../lib/motion'
import { Popover } from '../../ui'
import { FleetPopover } from './FleetPopover'
import { useSubagentNotifications } from './notifications'
import { isUnseenFailure, useSubagentFleet, useSubagentsSlice, useSubagentUi, type SubagentRunView } from './store'

const FilePreviewDialog = lazy(() => import('../inspector/FilePreviewDialog').then((m) => ({ default: m.FilePreviewDialog })))

/** How long a finished run's "✓ worker done" stays on the pill. */
const DONE_MORPH_MS = 4000
/** The pill shows at most this many state dots. */
const MAX_DOTS = 3

type DotTone = 'running' | 'queued' | 'decision' | 'failed'

const DOT_CLASS: Record<Exclude<DotTone, 'failed'>, string> = {
  running: 'bg-accent-2 shadow-[0_0_0_2px_var(--accent-soft)]',
  queued: 'shadow-[inset_0_0_0_1.25px_var(--fg-3)]',
  decision: 'bg-warning'
}

function dotTone(view: SubagentRunView): DotTone {
  if (view.needsDecision) return 'decision'
  return view.state === 'running' ? 'running' : 'queued'
}

/**
 * Up to three marks, one per run: amber dot = running, hollow = queued, warning dot = needs you, rose "x" = failed
 * (a different shape, so a failure never passes for a running dot).
 */
function StateDots({ tones }: { tones: DotTone[] }) {
  return (
    <span className="flex items-center gap-[4px]" aria-hidden>
      {tones.slice(0, MAX_DOTS).map((tone, i) =>
        tone === 'failed' ? (
          <X key={i} className="size-2 text-danger" strokeWidth={3.5} />
        ) : (
          <span key={i} className={cn('size-1.5 rounded-full', DOT_CLASS[tone])} />
        )
      )}
    </span>
  )
}

/** Remember runs that just finished, to show "✓ <agent> done" for a few seconds. */
function useDoneMorph(active: SubagentRunView[], recent: SubagentRunView[]): string | null {
  const previous = useRef(new Set(active.map((view) => view.runId)))
  const [done, setDone] = useState<{ label: string; runId: string } | null>(null)
  useEffect(() => {
    const finished = recent.find((view) => view.state === 'complete' && previous.current.has(view.runId))
    previous.current = new Set(active.map((view) => view.runId))
    if (finished) setDone({ label: finished.label, runId: finished.runId })
  }, [active, recent])
  // Keyed on the finished run so later fleet updates don't restart (or cancel) the countdown.
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), DONE_MORPH_MS)
    return () => clearTimeout(timer)
  }, [done])
  return done?.label ?? null
}

function pillText(active: number, decisions: number): string {
  const agents = `${active} ${active === 1 ? 'agent' : 'agents'}`
  if (decisions === 0) return agents
  return `${decisions} needs you · ${agents}`
}

/**
 * Live fleet status at the left of the row above the composer: zero extra height, hidden when no run is
 * active and no failure is unseen. Opens the fleet popover.
 */
export function FleetPill({ agentId }: { agentId: string }) {
  useSubagentNotifications()
  const slice = useSubagentsSlice(agentId)
  const { active, recent, needsDecision } = useSubagentFleet(agentId)
  const unseenFailures = useMemo(() => (slice ? recent.filter((view) => isUnseenFailure(view, slice)) : []), [recent, slice])
  const done = useDoneMorph(active, recent)
  const [open, setOpen] = useState(false)
  const visible = active.length > 0 || unseenFailures.length > 0 || done !== null

  const tones: DotTone[] = [...unseenFailures.map((): DotTone => 'failed'), ...active.map(dotTone)]
  const warning = needsDecision > 0
  let label: string
  if (done && active.length === 0) label = `${done} done`
  else if (active.length === 0) label = unseenFailures.length === 1 ? `${unseenFailures[0]!.label} failed` : `${unseenFailures.length} failed`
  else label = done ? `${done} done` : pillText(active.length, needsDecision)

  return (
    <>
      <AnimatePresence initial={false}>
        {visible && (
          <motion.div
            key="fleet"
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={spring.snappy}
            className="shrink-0"
          >
            <Popover
              open={open}
              onOpenChange={setOpen}
              side="top"
              align="start"
              className="w-[400px] p-1.5"
              trigger={
                <button
                  type="button"
                  data-fleet-pill
                  aria-label={`Agents: ${label}`}
                  className={cn(
                    'pressable inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap backdrop-blur-xl',
                    'transition-colors duration-[var(--dur-instant)]',
                    warning
                      ? 'bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--warning-border)] hover:brightness-110'
                      : 'bg-[var(--glass-strong)] text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] hover:text-fg'
                  )}
                >
                  {done ? (
                    <Check className="size-3 text-fg-3" strokeWidth={2.75} />
                  ) : warning ? (
                    <Flag className="size-3" strokeWidth={2.5} />
                  ) : (
                    <StateDots tones={tones} />
                  )}
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={label} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={spring.snappy} className="tabular">
                      {label}
                    </motion.span>
                  </AnimatePresence>
                </button>
              }
            >
              <FleetPopover agentId={agentId} onClose={() => setOpen(false)} />
            </Popover>
          </motion.div>
        )}
      </AnimatePresence>
      <OutputPreview />
    </>
  )
}

function OutputPreview() {
  const preview = useSubagentUi((s) => s.preview)
  if (!preview) return null
  return (
    <Suspense fallback={null}>
      <FilePreviewDialog path={preview.path} display={basename(preview.path)} cwd={preview.cwd} onClose={() => useSubagentUi.getState().setPreview(null)} />
    </Suspense>
  )
}

