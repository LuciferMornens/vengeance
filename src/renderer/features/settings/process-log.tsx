import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, ChevronRight, X, XCircle } from 'lucide-react'
import { create } from 'zustand'
import type { ProcessDoneEvent, ProcessLogEvent } from '@shared/api/settings'
import type { EngineId } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { formatDuration } from '../../lib/format'
import { on } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import { AnsiText, Button, IconButton, Spinner } from '../../ui'
import { settingsInvoke } from './ipc'

/** Streamed engine CLI runs (package installs, MCP auth, updates): output buffered per run id. */

export interface ProcessRun {
  engine?: EngineId
  runId: string
  label: string
  /** Full output (status lines dimmed) for the "Details" disclosure. */
  text: string
  /** Latest human status line (`info` stream), shown as the run's calm one-line state. */
  summary?: string
  /** Diagnostics from the run's events (the raw engine command line), shown only under "Details". */
  detail?: string
  status: 'running' | 'ok' | 'error'
  error?: string
  startedAt: number
  finishedAt?: number
}

interface RunsStore {
  runs: Record<string, ProcessRun>
  append(event: ProcessLogEvent): void
  finish(event: ProcessDoneEvent): void
  /** Name a run once its id is known (output may already be buffered). */
  label(runId: string, label: string, engine?: EngineId): void
  dismiss(runId: string): void
}

const MAX_LOG = 200_000

export const useRuns = create<RunsStore>()((set) => ({
  runs: {},
  append(event) {
    set((state) => {
      const run = state.runs[event.runId] ?? {
        runId: event.runId,
        label: '',
        text: '',
        status: 'running' as const,
        startedAt: Date.now()
      }
      const line = event.stream === 'info' ? `\x1b[2m${event.text}\x1b[22m` : event.text
      const text = (run.text + line).slice(-MAX_LOG)
      const summary =
        event.stream === 'info'
          ? (event.text
              .split(/\r?\n/)
              .filter((l) => l.trim())
              .at(-1)
              ?.trim() ?? run.summary)
          : run.summary
      return {
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            engine: event.engine ?? run.engine,
            text,
            summary,
            detail: run.detail ?? event.detail
          }
        }
      }
    })
  },
  finish(event) {
    set((state) => {
      const run = state.runs[event.runId] ?? {
        runId: event.runId,
        label: '',
        text: '',
        status: 'running' as const,
        startedAt: Date.now()
      }
      return {
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            engine: event.engine ?? run.engine,
            status: event.ok ? 'ok' : 'error',
            error: event.error,
            finishedAt: Date.now()
          }
        }
      }
    })
  },
  label(runId, label, engine) {
    set((state) => ({
      runs: {
        ...state.runs,
        [runId]: {
          ...(state.runs[runId] ?? { runId, text: '', status: 'running', startedAt: Date.now() }),
          engine: engine ?? state.runs[runId]?.engine,
          label
        }
      }
    }))
  },
  dismiss(runId) {
    set((state) => {
      const { [runId]: _dismissed, ...rest } = state.runs
      return { runs: rest }
    })
  }
}))

on('settings:process-log', (event) => useRuns.getState().append(event))
on('settings:process-done', (event) => useRuns.getState().finish(event))
on('updates:log', (event) => useRuns.getState().append(event))
on('updates:done', (event) => useRuns.getState().finish(event))

export interface ProcessLogProps {
  run: ProcessRun
  /** Cancel a running process (settings runs only). */
  cancellable?: boolean
  /** Title once the run succeeded (e.g. "Updated"); the run label otherwise. */
  doneLabel?: string
  onDismiss?: () => void
  /** Height of the expanded output. */
  height?: number
  className?: string
}

/** The locale's own short time ("7:36 PM", "19:36"): no zero-padded hour in 12-hour locales. */
function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { timeStyle: 'short' })
}

/**
 * A streamed run as a calm status card: icon, title, one human status line, and the raw output behind a collapsed
 * "Details" disclosure (opened automatically when the run fails).
 */
export function ProcessLog({
  run,
  cancellable,
  doneLabel,
  onDismiss,
  height = 220,
  className
}: ProcessLogProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const failed = run.status === 'error'
  useEffect(() => {
    if (failed) setDetailsOpen(true)
  }, [failed])
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [run.text, detailsOpen])

  const done = run.status === 'ok'
  const finished = run.finishedAt ? clock(run.finishedAt) : ''
  const title = done && doneLabel ? doneLabel : run.label || 'Engine'
  // With a done title ("Updated") the time alone completes it; otherwise the state says what happened.
  const state =
    run.status === 'running'
      ? 'Running'
      : failed
        ? `Failed${finished && ` · ${finished}`}`
        : doneLabel
          ? finished
          : `Done${finished && ` · ${finished}`}`
  // A progress line ("Installing…") is stale once the run is over.
  const settled =
    run.summary && !/(…|\.\.\.)$/.test(run.summary)
      ? run.summary
      : `Finished${run.finishedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''}.`
  const line = failed ? (run.error ?? run.summary) : done ? settled : (run.summary ?? 'Starting…')

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={spring.smooth}
      className={cn('overflow-hidden rounded-card bg-surface-2 shadow-elev-1', className)}
    >
      <div className="flex items-start gap-3 px-3.5 pt-3 pb-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          {run.status === 'running' && <Spinner size={14} className="text-fg-3" />}
          {run.status === 'ok' && <CheckCircle2 className="size-4 text-success" />}
          {failed && <XCircle className="size-4 text-danger" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{title}</span>
            <span className="tabular shrink-0 text-xs text-fg-3">{state}</span>
          </div>
          <div
            className={cn(
              'mt-0.5 line-clamp-2 text-sm leading-snug break-words',
              failed ? 'text-danger' : 'text-fg-3'
            )}
          >
            {line}
          </div>
        </div>
        {cancellable && run.status === 'running' && (
          <Button
            size="xs"
            variant="ghost"
            className="-my-0.5"
            onClick={() =>
              void settingsInvoke(run.engine ?? 'pi', 'settings:cancel-run', run.runId)
            }
          >
            Cancel
          </Button>
        )}
        {onDismiss && run.status !== 'running' && (
          <IconButton label="Dismiss" size="xs" className="-my-0.5 -mr-1" onClick={onDismiss}>
            <X />
          </IconButton>
        )}
      </div>
      <div className="border-t border-hairline-soft">
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
          className="flex h-8 w-full items-center gap-1.5 px-3.5 text-xs font-medium text-fg-3 transition-colors duration-[var(--dur-instant)] hover:text-fg-2 focus-visible:text-fg-2 focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-[var(--dur-fast)]',
              detailsOpen && 'rotate-90'
            )}
          />
          Details
        </button>
        <AnimatePresence initial={false}>
          {detailsOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0, transition: { duration: 0.14 } }}
              transition={spring.layout}
              className="overflow-hidden"
            >
              <div
                ref={scroller}
                onScroll={(e) => {
                  const el = e.currentTarget
                  stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                }}
                className="selectable mx-3.5 mb-3.5 overflow-auto rounded-md bg-surface-1 px-3 pt-3 pb-2.5 font-mono text-xs leading-[18px] text-fg-2 shadow-elev-0 [mask-image:linear-gradient(to_bottom,transparent,black_16px)]"
                style={{ height }}
              >
                {run.detail && <div className="mb-2 break-all text-fg-3">{run.detail}</div>}
                {run.text ? (
                  <AnsiText as="pre" text={run.text} className="whitespace-pre-wrap break-words" />
                ) : (
                  <span className="font-sans text-fg-3">No output yet.</span>
                )}
                {run.error && <div className="mt-1 text-danger">{run.error}</div>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
