import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { Check, ChevronLeft, Copy, FileText, Flag, MoreHorizontal, X } from 'lucide-react'
import type { SubagentInspectReply } from '@shared/subagents'
import { cn } from '../../lib/cn'
import { formatCost, formatRelativeTime, formatTokens } from '../../lib/format'
import { useApp } from '../../store/app'
import {
  Avatar,
  Button,
  DropdownMenu,
  IconButton,
  Pill,
  Spinner,
  toast,
  type MenuItem,
  type Tone
} from '../../ui'
import { Markdown } from '../../ui/Markdown'
import { Section, Well } from '../inspector/parts'
import { subagentActions } from './actions'
import { activityItems, activityLine, type ActivityItem } from './activity'
import { modelLabel, splitSavedOutput, useNow } from './format'
import { ChildRows, elapsedLabel, RunGlyph, stateLabel } from './parts'
import { SteerBox, type SteerBoxMode } from './SteerBox'
import {
  ACTIVE_STATES,
  usePendingRequest,
  useSubagentRun,
  useSubagentUi,
  type SubagentChildView,
  type SubagentRunView
} from './store'

/** Live runs are re-inspected this often while the detail is visible. */
const POLL_MS = 2000
const ACTIVITY_LINES = 40

/** Polls `/subagents-inspect-rpc` while the run is live and the panel is visible; never overlapping. */
function useInspect(agentId: string, runId: string, childId: string | undefined, live: boolean) {
  const visible = useApp((s) => s.prefs.inspector.open)
  const [reply, setReply] = useState<SubagentInspectReply | null>(null)
  const [gone, setGone] = useState(false)
  const [at, setAt] = useState<number | null>(null)

  useEffect(() => {
    setReply(null)
    setGone(false)
  }, [runId, childId])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let inflight = false
    const load = async () => {
      if (inflight) return
      inflight = true
      try {
        const next = await subagentActions.inspect(agentId, {
          asyncId: runId,
          childId,
          lines: ACTIVITY_LINES
        })
        if (cancelled) return
        if (next.error)
          setGone(
            next.error.code === 'stale' ||
              next.error.code === 'not_found' ||
              next.error.code === 'unavailable'
          )
        else {
          setReply(next)
          setGone(false)
          setAt(Date.now())
        }
      } catch {
        if (!cancelled) setGone(true)
      } finally {
        inflight = false
      }
    }
    void load()
    if (!live) {
      return () => {
        cancelled = true
      }
    }
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [agentId, runId, childId, live, visible])

  return { reply, gone, at }
}

/** Tokens and cost of a finished run, from pi-subagents' `cost` accounting (once per open). */
function useRunCost(agentId: string, runId: string, finished: boolean): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!finished) return
    let cancelled = false
    void subagentActions.cost(agentId).then((data) => {
      const children = Array.isArray(data?.children)
        ? (data.children as Array<{
            runId?: string
            usage?: { input?: number; output?: number; cost?: number }
          }>)
        : []
      const usage = children.find((child) => child.runId === runId)?.usage
      if (cancelled || !usage) return
      setText(
        `${formatTokens((usage.input ?? 0) + (usage.output ?? 0))} tokens · ${formatCost(usage.cost)}`
      )
    })
    return () => {
      cancelled = true
    }
  }, [agentId, runId, finished])
  return text
}

function pillTone(view: Pick<SubagentRunView, 'state' | 'needsDecision'>): Tone {
  if (view.needsDecision) return 'warning'
  return view.state === 'failed' || view.state === 'rejected' ? 'danger' : 'neutral'
}

function StatePill({ view, now }: { view: SubagentRunView; now: number }) {
  const label = stateLabel(view)
  const tone = pillTone(view)
  const elapsed = elapsedLabel(view, now)
  return (
    <Pill
      tone={tone}
      icon={tone === 'neutral' ? <RunGlyph state={view.state} /> : undefined}
      indicator={tone === 'neutral' ? undefined : 'dot'}
      data-state-pill={view.state}
    >
      {label}
      {elapsed && <span className="tabular font-normal opacity-80">· {elapsed}</span>}
    </Pill>
  )
}

/** The open supervisor request, word for word (it is the user's to answer), clamped to four lines like the transcript card. */
function Decision({ body, sending }: { body: string; sending: boolean }) {
  const [all, setAll] = useState(false)
  return (
    <Section
      title={
        <span className="flex items-center gap-1.5 text-warning">
          <Flag className="size-3" strokeWidth={2.5} />
          Needs your decision
        </span>
      }
      aside={
        sending ? (
          <span className="text-xs text-fg-3">Sending…</span>
        ) : (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="text-xs text-fg-3 hover:text-fg-2"
          >
            {all ? 'Show less' : 'Show all'}
          </button>
        )
      }
    >
      <div
        className="rounded-card bg-warning-soft px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--warning-border)]"
        data-subagent-decision
      >
        <Markdown text={body} size="compact" className={cn('!text-sm', !all && 'line-clamp-4')} />
      </div>
    </Section>
  )
}

function TaskText({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  return (
    <Section
      title="Task"
      aside={
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="text-xs text-fg-3 hover:text-fg-2"
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      }
    >
      <p
        className={cn(
          'selectable px-0.5 text-sm leading-relaxed whitespace-pre-wrap text-fg-2',
          !all && 'line-clamp-3'
        )}
      >
        {text}
      </p>
    </Section>
  )
}

function Activity({
  items,
  live,
  at,
  now
}: {
  items: ActivityItem[]
  live: boolean
  at: number | null
  now: number
}) {
  const lastTool = items.findLastIndex((item) => item.kind === 'tool')
  return (
    <Section
      title="Activity"
      aside={
        at !== null && (
          <span className="text-xs text-fg-3 tabular">
            {live ? `live · ${formatRelativeTime(at, now)}` : 'final'}
          </span>
        )
      }
    >
      <div className="flex flex-col gap-1.5" data-subagent-activity>
        {items.map((item, i) => {
          if (item.kind === 'text') {
            return (
              <Markdown
                key={i}
                text={item.text}
                size="compact"
                className="border-l-2 border-hairline-strong pl-2.5 !text-sm !text-fg-2"
              />
            )
          }
          const running = item.result === undefined && live && i === lastTool
          const line = activityLine(item, running)
          return (
            <div
              key={i}
              className="flex h-6 min-w-0 items-center gap-2 px-0.5"
              data-activity-tool={item.name}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {item.isError ? (
                  <X className="size-3 text-danger" strokeWidth={2.75} />
                ) : running ? (
                  <Spinner size={11} />
                ) : (
                  <Check className="size-3 text-fg-3" strokeWidth={2.5} />
                )}
              </span>
              <span className="shrink-0 text-sm text-fg-2">{line.verb}</span>
              {line.subject && (
                <span className="min-w-0 shrink truncate text-sm font-medium text-fg">
                  {line.subject}
                </span>
              )}
              {line.meta && <span className="shrink-0 text-xs text-fg-3">· {line.meta}</span>}
              {line.reason && (
                <span className="min-w-0 truncate font-mono text-xs text-danger">
                  {line.reason}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

function Output({ text, path }: { text: string; path?: string }) {
  const [copied, setCopied] = useState(false)
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (receiptTimer.current !== null) clearTimeout(receiptTimer.current)
    },
    []
  )
  return (
    <Section
      title="Output"
      aside={
        <span className="flex items-center gap-0.5">
          {path && (
            <Button
              size="xs"
              variant="ghost"
              leading={<FileText />}
              onClick={() => void subagentActions.openOutput(path)}
            >
              Open file
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            leading={copied ? <Check /> : <Copy />}
            onClick={() => {
              void navigator.clipboard.writeText(text)
              setCopied(true)
              if (receiptTimer.current !== null) clearTimeout(receiptTimer.current)
              const copyReceiptMs = 1500
              receiptTimer.current = setTimeout(() => setCopied(false), copyReceiptMs)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </span>
      }
    >
      <Well className="px-3 py-2.5">
        <Markdown text={text} size="compact" />
      </Well>
    </Section>
  )
}

/** The run open in the Agents tab: header with state and actions, task, live activity, output, children. */
export function AgentDetail({
  agentId,
  runId,
  childId,
  intent
}: {
  agentId: string
  runId: string
  childId?: string
  intent?: 'steer'
}) {
  const view = useSubagentRun(agentId, runId)
  const live = view !== null && ACTIVE_STATES.has(view.state)
  const now = useNow(live)
  const child = useMemo(() => findChild(view?.children ?? [], childId), [view, childId])
  const { reply, gone, at } = useInspect(agentId, runId, childId, live)
  const finished = view !== null && !live && view.state !== 'unknown'
  const cost = useRunCost(agentId, runId, finished)
  const request = usePendingRequest(agentId, runId)
  const [box, setBox] = useState<SteerBoxMode | null>(intent === 'steer' ? { kind: 'steer' } : null)
  const [raw, setRaw] = useState<string | null>(null)

  useEffect(() => {
    if (intent === 'steer') setBox({ kind: 'steer' })
  }, [intent, runId])
  useEffect(() => {
    if (!live && box?.kind === 'steer') setBox(null)
  }, [live, box])
  const toggle = (next: SteerBoxMode) => setBox(box?.kind === next.kind ? null : next)

  const back = () => useSubagentUi.getState().select(null)
  if (!view) {
    return (
      <div className="px-4 pt-3">
        <BackButton onClick={back} />
        <p className="mt-6 text-center text-sm text-fg-3">This run is no longer in the session.</p>
      </div>
    )
  }

  const label = child ? child.label : view.label
  const target = { runId, childId }
  const items = reply?.messages ? activityItems(reply.messages) : []
  const task = reply?.task ?? (child ? undefined : view.task)
  const output = splitSavedOutput(reply?.finalOutput ?? (child ? undefined : view.summary) ?? '')
  const outputPath = child ? undefined : (view.outputPath ?? output.path)
  const meta = [
    view.turns !== undefined ? `${view.turns} turns` : null,
    view.tools !== undefined ? `${view.tools} tools` : null,
    modelLabel(view.model),
    cost
  ].filter(Boolean)

  const menu: MenuItem[] = []
  if (!live && view.state !== 'stopped' && view.state !== 'unknown' && !child)
    menu.push({ label: 'Resume with a message…', onSelect: () => setBox({ kind: 'resume' }) })
  menu.push({ label: 'Copy run ID', onSelect: () => void navigator.clipboard.writeText(runId) })
  menu.push({
    label: 'Show raw status',
    onSelect: () => {
      subagentActions
        .status(agentId, runId)
        .then(setRaw)
        .catch((error: Error) =>
          toast({ level: 'error', title: "Couldn't read the status", description: error.message })
        )
    }
  })

  const stop = () => {
    subagentActions
      .stop(agentId, target)
      .catch((error: Error) =>
        toast({ level: 'error', title: `Couldn't stop ${label}`, description: error.message })
      )
  }

  return (
    <div className="flex flex-col gap-5 px-4 pt-2 pb-6" data-subagent-detail={view.state}>
      <div className="flex flex-col gap-2">
        <BackButton onClick={back} />
        <Well className="px-3 pt-3 pb-3">
          <div className="flex items-start gap-2.5">
            <Avatar name={label} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex min-h-7 items-center gap-2">
                <span className="min-w-0 truncate text-ui font-semibold text-fg">
                  {child ? (
                    <>
                      <span className="font-normal text-fg-3">{view.label} › </span>
                      {child.label}
                    </>
                  ) : (
                    view.label
                  )}
                </span>
                <span className="flex-1" />
                <StatePill
                  view={
                    child
                      ? {
                          ...view,
                          state: child.state,
                          startedAt: child.startedAt,
                          endedAt: child.endedAt,
                          needsDecision: false
                        }
                      : view
                  }
                  now={now}
                />
                <DropdownMenu
                  align="end"
                  items={menu}
                  trigger={
                    <IconButton label="More" size="xs" className="-mr-1">
                      <MoreHorizontal />
                    </IconButton>
                  }
                />
              </div>
              {view.title && !child && (
                <div className="mt-0.5 line-clamp-2 text-sm text-fg-2">{view.title}</div>
              )}
              {view.failureReason && (
                <div className="mt-0.5 text-sm text-danger">
                  {view.failureReason.charAt(0).toUpperCase() + view.failureReason.slice(1)}
                </div>
              )}
              {meta.length > 0 && (
                <div className="tabular mt-1 truncate text-xs text-fg-3">{meta.join(' · ')}</div>
              )}
              {view.resumedFrom && (
                <button
                  type="button"
                  onClick={() =>
                    useSubagentUi.getState().select({ agentId, runId: view.resumedFrom! })
                  }
                  className="mt-1 text-xs text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline"
                >
                  Continues an earlier run
                </button>
              )}
            </div>
          </div>
          {(request || live) && (
            <div className="mt-3 flex items-center gap-1.5 pl-[38px]">
              {request && (
                <Button
                  size="xs"
                  variant={box ? 'secondary' : 'primary'}
                  onClick={() => toggle({ kind: 'reply', request: request.request })}
                  aria-expanded={box?.kind === 'reply'}
                  disabled={request.state === 'sending'}
                >
                  Answer…
                </Button>
              )}
              {live && (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => toggle({ kind: 'steer' })}
                    aria-expanded={box?.kind === 'steer'}
                  >
                    Steer…
                  </Button>
                  <Button size="xs" variant="ghost" className="text-danger" onClick={stop}>
                    Stop
                  </Button>
                </>
              )}
            </div>
          )}
          <AnimatePresence initial={false}>
            {box && (
              <SteerBox
                key={box.kind}
                agentId={agentId}
                target={target}
                label={label}
                mode={box}
                onClose={() => setBox(null)}
              />
            )}
          </AnimatePresence>
        </Well>
      </div>

      {request && !child && (
        <Decision body={request.request.requestBody} sending={request.state === 'sending'} />
      )}

      {raw !== null && (
        <Section
          title="Raw status"
          aside={
            <IconButton label="Hide raw status" size="xs" onClick={() => setRaw(null)}>
              <X />
            </IconButton>
          }
        >
          <Well className="selectable max-h-72 overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg-2">
            {raw}
          </Well>
        </Section>
      )}

      {task && <TaskText text={task} />}

      {gone && !reply && (
        <p className="px-0.5 text-sm text-fg-3">
          Live view no longer available; showing the saved result.
        </p>
      )}
      {items.length > 0 && <Activity items={items} live={live} at={at} now={now} />}

      {output.text && !live && <Output text={output.text} path={outputPath} />}

      {view.kind === 'workflow' && view.children.length > 0 && !child && (
        <Section title="Children">
          <div className="-mx-2">
            <ChildRows
              items={view.children}
              now={now}
              onOpen={(next) =>
                useSubagentUi.getState().select({ agentId, runId, childId: next.id })
              }
            />
          </div>
        </Section>
      )}
    </div>
  )
}

function findChild(
  children: SubagentChildView[],
  id: string | undefined
): SubagentChildView | undefined {
  if (!id) return undefined
  for (const child of children) {
    if (child.id === id) return child
    const nested = findChild(child.children, id)
    if (nested) return nested
  }
  return undefined
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-1 flex h-7 w-fit items-center gap-0.5 rounded-md px-1 text-sm text-fg-3 hover:bg-hover hover:text-fg-2"
    >
      <ChevronLeft className="size-4" />
      All agents
    </button>
  )
}
