import { memo, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, Circle, CornerUpLeft, Flag, RotateCw } from 'lucide-react'
import type { CustomMessage, UserMessage } from '@shared/engine-types'
import {
  asControlEvent,
  asNotifyDetails,
  asSupervisorRequest,
  formatSubagentDuration,
  parseNotifyContent,
  parseSupervisorReplyPrompt,
  SUBAGENT_MESSAGE_TYPES,
  type SubagentSupervisorRequest
} from '@shared/subagents'
import { cn } from '../../lib/cn'
import { formatRelativeTime } from '../../lib/format'
import { isImeComposing } from '../../lib/keybindings'
import { useAgents } from '../../store/agents'
import { Button, Textarea } from '../../ui'
import { Markdown } from '../../ui/Markdown'
import {
  openSubagentDetail,
  RunGlyph,
  subagentActions,
  useResumedRunIds,
  useSubagentFleet,
  useSupervisorRequestState
} from '../subagents'
import { DetailSection, RowDetail, ToolRow, useDisclosure, useHasSupervisorRequest, useUserSupervisorReply } from '../tools'
import { toastFailure } from './failure-toast'

/**
 * pi-subagents' custom messages (completion, attention, supervisor requests and the rest) as one quiet row
 * each, a folded "Subagent updates" row for a run of them, and the wake prompt / reply prompts the host sends
 * as non-bubble lines. Their text is written for the model, so rows are built from `details` and cleaned text.
 */

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const WINDOWS_PATH = /[A-Z]:\\[^\s)"'`]*/g
const POSIX_PATH = /(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/g
const MODEL_HINT = /subagent(?:_supervisor)?\(\{.*?\}\)/g

function messageText(message: CustomMessage | UserMessage): string {
  return typeof message.content === 'string' ? message.content : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

/** Model-facing text with ids, paths and `subagent({...})` hints removed, and the engine called "Engine". */
function cleanNoticeText(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(MODEL_HINT, '')
        .replace(UUID, '')
        .replace(WINDOWS_PATH, '')
        .replace(POSIX_PATH, ' ')
        .replace(/\bPi\b/g, 'Engine')
        .replace(/\s{2,}/g, ' ')
        .trimEnd()
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** First sentence of a text (one line, at most 140 characters). */
function firstSentence(text: string): string {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
  return sentence.length > 140 ? `${sentence.slice(0, 139)}\u2026` : sentence
}

/** "worker has had tool 'bash' open for 240s" → "worker has had bash open for 4m". */
function humanizeAttention(message: string): string {
  return message.replace(/tool '([^']+)'/g, '$1').replace(/\b(\d+)s\b/g, (_, seconds: string) => formatSubagentDuration(Number(seconds) * 1000))
}

function Quote({ text }: { text: string }) {
  return text ? <span className="min-w-0 truncate text-fg-3">“{text}”</span> : null
}

function RowAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 items-center rounded-sm px-1.5 text-xs font-medium text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  )
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="px-3.5 py-3">
      <Markdown text={text.slice(0, 20_000)} size="compact" />
    </div>
  )
}

// ─── subagent-notify ─────────────────────────────────────────────────────────────────────────────

/** A completion or failure; a failure whose run a later run revived is handled, so neither red nor offering Resume. */
function NotifyRow({ agentId, message, rowKey }: { agentId: string; message: CustomMessage; rowKey: string }) {
  const text = messageText(message)
  const parsed = parseNotifyContent(text)
  const run = asNotifyDetails(message.details)?.runs[0]
  const resumed = isResumedFailure(message, useResumedRunIds(agentId))
  const agent = parsed.agent ?? run?.agent ?? 'agent'
  const duration = run?.durationMs !== undefined ? formatSubagentDuration(run.durationMs) : undefined
  const summary = cleanNoticeText(parsed.summary)
  const outputPath = parsed.outputPath
  const failure = `failed${parsed.reason ? ` \u00b7 ${parsed.reason}` : ''}${resumed ? ' \u00b7 resumed' : ''}`
  const status = parsed.failed ? failure : `finished${duration ? ` \u00b7 ${duration}` : ''}`
  const unresolved = parsed.failed && !resumed
  return (
    <ToolRow
      disclosureKey={`notice:${rowKey}`}
      icon={resumed ? <RotateCw className="text-fg-3" /> : <RunGlyph state={parsed.failed ? 'failed' : 'complete'} />}
      verb={agent}
      subject={
        <>
          <span className={cn('shrink-0', unresolved ? 'text-danger' : 'text-fg-3')}>{status}</span>
          {!parsed.failed && <Quote text={firstSentence(summary)} />}
        </>
      }
      phase="done"
      actions={
        <>
          {outputPath && <RowAction onClick={() => void subagentActions.openOutput(outputPath)}>Output</RowAction>}
          {unresolved && run && <RowAction onClick={() => openSubagentDetail(agentId, run.runId)}>Resume</RowAction>}
        </>
      }
      detail={
        summary ? (
          <RowDetail copy={summary} raw={{ text, key: `notice:${rowKey}` }}>
            <MarkdownBody text={summary} />
          </RowDetail>
        ) : undefined
      }
    />
  )
}

// ─── subagent_control_notice ─────────────────────────────────────────────────────────────────────

/** Runs still working, by id: attention notices only matter while their run is. */
function useLiveRunIds(agentId: string): ReadonlySet<string> {
  const { active } = useSubagentFleet(agentId)
  return useMemo(() => new Set(active.filter((run) => run.live).map((run) => run.runId)), [active])
}

/** An attention notice ("worker has had bash open for 4m") while its run is live; it leaves with the run. */
function ControlRow({ agentId, message, rowKey }: { agentId: string; message: CustomMessage; rowKey: string }) {
  const event = asControlEvent(message.details)
  const liveRuns = useLiveRunIds(agentId)
  if (!event) return <OtherNoticeRow message={message} rowKey={rowKey} />
  if (!liveRuns.has(event.runId)) return null
  return (
    <ToolRow
      disclosureKey={`notice:${rowKey}`}
      icon={<AlertTriangle className="text-warning" />}
      verb={humanizeAttention(event.message)}
      phase="done"
      actions={
        <>
          <RowAction onClick={() => openSubagentDetail(agentId, event.runId)}>Peek</RowAction>
          <RowAction onClick={() => openSubagentDetail(agentId, event.runId, undefined, 'steer')}>Steer</RowAction>
        </>
      }
    />
  )
}

// ─── subagent_supervisor_request ─────────────────────────────────────────────────────────────────

/** Question lines kept visible before "Show more". */
const QUESTION_CLAMP = 'line-clamp-4'

function SupervisorCard({ agentId, request, receivedAt }: { agentId: string; request: SubagentSupervisorRequest; receivedAt: number }) {
  const state = useSupervisorRequestState(agentId, request.requestId)
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useDisclosure(`request:${request.requestId}`, false)
  const sending = state === 'sending'
  const question = cleanNoticeText(request.requestBody)
  const long = question.split('\n').length > 4 || question.length > 320

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    try {
      await subagentActions.replyToSupervisor(agentId, request, text)
      setDraft('')
    } catch (error) {
      toastFailure(`Couldn\u2019t reply to ${request.agent}`, error)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div
      data-supervisor-card
      className="overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--warning-border),var(--shadow-sm)]"
    >
      <div className="flex h-7 items-center gap-2 px-3">
        <span className="flex size-4.5 items-center justify-center rounded-sm bg-warning-soft text-warning">
          <Flag className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {request.agent} needs a decision
        </span>
        {long && (
          <button type="button" onClick={() => setExpanded(!expanded)} className="shrink-0 text-xs font-medium text-fg-3 hover:text-fg">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <span className="shrink-0 text-xs text-fg-3 tabular">{formatRelativeTime(receivedAt)}</span>
      </div>
      <div className={cn('selectable px-3.5', !expanded && QUESTION_CLAMP)}>
        <Markdown text={question} size="compact" />
      </div>
      <div className="flex items-end gap-2 px-3 pt-2 pb-2.5">
        <Textarea
          aria-label={`Reply to ${request.agent}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Reply to ${request.agent}\u2026`}
          rows={1}
          disabled={sending}
          className="field-sizing-content max-h-32 min-h-9 flex-1 py-[7px]"
        />
        <Button variant="primary" size="md" loading={sending} disabled={!draft.trim()} onClick={() => void send()}>
          Reply
        </Button>
      </div>
    </div>
  )
}

/**
 * An answered request: "worker asked "…"", plus "you answered" and the answer when the user replied from the
 * app (the reply prompt and the parent's relay call then render nothing, so the exchange is one row).
 */
function SupervisorRequestNotice({ agentId, message, rowKey }: { agentId: string; message: CustomMessage; rowKey: string }) {
  const request = asSupervisorRequest(message.details)
  const state = useSupervisorRequestState(agentId, request?.requestId ?? '')
  const userReply = useUserSupervisorReply(agentId, request?.requestId)
  if (!request) return <OtherNoticeRow message={message} rowKey={rowKey} />
  if (state !== 'answered') return <SupervisorCard agentId={agentId} request={request} receivedAt={message.timestamp} />
  const question = cleanNoticeText(request.requestBody)
  return (
    <ToolRow
      disclosureKey={`notice:${rowKey}`}
      icon={<CornerUpLeft className="text-fg-3" />}
      verb={`${request.agent} asked`}
      subject={<Quote text={firstSentence(question)} />}
      meta={userReply !== undefined ? <span>you answered</span> : null}
      phase="done"
      detail={
        <RowDetail copy={userReply ?? question} raw={{ text: messageText(message), key: `notice:${rowKey}` }}>
          {userReply === undefined ? (
            <MarkdownBody text={question} />
          ) : (
            <>
              <DetailSection label="Question">
                <MarkdownBody text={question} />
              </DetailSection>
              <DetailSection label="Your answer">
                <MarkdownBody text={userReply} />
              </DetailSection>
            </>
          )}
        </RowDetail>
      }
    />
  )
}

// ─── Everything else ─────────────────────────────────────────────────────────────────────────────

function OtherNoticeRow({ message, rowKey }: { message: CustomMessage; rowKey: string }) {
  const text = messageText(message)
  const clean = cleanNoticeText(text)
  return (
    <ToolRow
      disclosureKey={`notice:${rowKey}`}
      icon={<Circle className="size-2.5 text-fg-3" strokeWidth={2.5} />}
      verb={<span className="font-normal text-fg-2">{firstSentence(clean) || 'Subagent update'}</span>}
      phase="done"
      detail={
        clean ? (
          <RowDetail copy={clean} raw={{ text, key: `notice:${rowKey}` }}>
            <MarkdownBody text={clean} />
          </RowDetail>
        ) : undefined
      }
    />
  )
}

/** One subagent custom message as its row (or the supervisor card while a request is open). */
const SubagentNotice = memo(function SubagentNotice({ agentId, message, rowKey }: { agentId: string; message: CustomMessage; rowKey: string }) {
  switch (message.customType) {
    case SUBAGENT_MESSAGE_TYPES.notify:
      return <NotifyRow agentId={agentId} message={message} rowKey={rowKey} />
    case SUBAGENT_MESSAGE_TYPES.controlNotice:
      return <ControlRow agentId={agentId} message={message} rowKey={rowKey} />
    case SUBAGENT_MESSAGE_TYPES.supervisorRequest:
      return <SupervisorRequestNotice agentId={agentId} message={message} rowKey={rowKey} />
    default:
      return <OtherNoticeRow message={message} rowKey={rowKey} />
  }
})

// ─── Folded updates ──────────────────────────────────────────────────────────────────────────────

export interface NoticeEntry {
  key: string
  message: CustomMessage
}

/** A completion notice that reports a failure. */
function isFailureNotice(message: CustomMessage): boolean {
  return message.customType === SUBAGENT_MESSAGE_TYPES.notify && parseNotifyContent(messageText(message)).failed
}

/** A failure notice whose run a later run revived. */
function isResumedFailure(message: CustomMessage, resumed: ReadonlySet<string>): boolean {
  const runId = asNotifyDetails(message.details)?.runs[0]?.runId
  return runId !== undefined && resumed.has(runId) && isFailureNotice(message)
}

/** "2 finished · 1 failed · 1 resumed · 1 needs attention" for a run of notices. */
function updateCounts(notices: NoticeEntry[], resumed: ReadonlySet<string>): string {
  let finished = 0
  let failed = 0
  let resumedCount = 0
  let attention = 0
  let answered = 0
  let other = 0
  for (const { message } of notices) {
    if (isResumedFailure(message, resumed)) resumedCount++
    else if (isFailureNotice(message)) failed++
    else if (message.customType === SUBAGENT_MESSAGE_TYPES.notify) finished++
    else if (message.customType === SUBAGENT_MESSAGE_TYPES.controlNotice) attention++
    else if (message.customType === SUBAGENT_MESSAGE_TYPES.supervisorRequest) answered++
    else other++
  }
  return [
    finished ? `${finished} finished` : '',
    failed ? `${failed} failed` : '',
    resumedCount ? `${resumedCount} resumed` : '',
    attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : '',
    answered ? `${answered} answered` : '',
    other ? `${other} ${other === 1 ? 'update' : 'updates'}` : ''
  ]
    .filter(Boolean)
    .join(' \u00b7 ')
}

/** Supervisor requests still waiting for the user are never folded away. */
function usePendingRequestKeys(agentId: string, notices: NoticeEntry[]): Set<string> {
  const requests = useAgents((s) => s.agents[agentId]?.subagents.requests)
  const pending = new Set<string>()
  for (const notice of notices) {
    if (notice.message.customType !== SUBAGENT_MESSAGE_TYPES.supervisorRequest) continue
    const request = asSupervisorRequest(notice.message.details)
    if (request && requests?.[request.requestId]?.state !== 'answered') pending.add(notice.key)
  }
  return pending
}

/** Attention notices of runs that are no longer live: they render nothing and are not counted. */
function isStaleAttention(message: CustomMessage, liveRuns: ReadonlySet<string>): boolean {
  if (message.customType !== SUBAGENT_MESSAGE_TYPES.controlNotice) return false
  const event = asControlEvent(message.details)
  return event !== null && !liveRuns.has(event.runId)
}

/** Two or more consecutive subagent notices (plus the wake prompt after them) as one folded row. */
export const SubagentUpdates = memo(function SubagentUpdates({ agentId, notices, groupKey }: { agentId: string; notices: NoticeEntry[]; groupKey: string }) {
  const liveRuns = useLiveRunIds(agentId)
  const resumed = useResumedRunIds(agentId)
  const shown = notices.filter((notice) => !isStaleAttention(notice.message, liveRuns))
  const pending = usePendingRequestKeys(agentId, shown)
  const folded = shown.filter((notice) => !pending.has(notice.key))
  const cards = shown.filter((notice) => pending.has(notice.key))
  const failed = folded.some(({ message }) => isFailureNotice(message) && !isResumedFailure(message, resumed))
  if (shown.length === 0) return null
  return (
    <div data-subagent-updates className="flex flex-col gap-1">
      {folded.length === 1 && <SubagentNotice agentId={agentId} message={folded[0]!.message} rowKey={folded[0]!.key} />}
      {folded.length > 1 && (
        <ToolRow
          disclosureKey={`updates:${groupKey}`}
          icon={failed ? <RunGlyph state="failed" /> : <span aria-hidden className="size-1.5 rounded-full bg-fg-4" />}
          verb="Subagent updates"
          subject={<span className="min-w-0 truncate text-fg-3">{updateCounts(folded, resumed)}</span>}
          phase="done"
          detail={
            <div className="flex flex-col py-1 pl-5">
              {folded.map((notice) => (
                <SubagentNotice key={notice.key} agentId={agentId} message={notice.message} rowKey={notice.key} />
              ))}
            </div>
          }
        />
      )}
      {cards.map((notice) => (
        <SubagentNotice key={notice.key} agentId={agentId} message={notice.message} rowKey={notice.key} />
      ))}
    </div>
  )
})

// ─── Host-sent prompts ───────────────────────────────────────────────────────────────────────────

/** pi-subagents woke the idle parent (its synthetic prompt), with no notices right before it. */
export function WakeDivider() {
  return (
    <div data-wake className="flex h-5 items-center gap-2 text-xs text-fg-3">
      <Circle className="size-2 text-fg-4" strokeWidth={3} />
      Woke up for subagent updates
    </div>
  )
}

/**
 * The user's answer to a supervisor request (sent to the parent model as a reply prompt), instead of a bubble.
 * Nothing when the request's own row is in the transcript: it shows the answer.
 */
export const SupervisorReplyRow = memo(function SupervisorReplyRow({ agentId, message, rowKey }: { agentId: string; message: UserMessage; rowKey: string }) {
  const reply = parseSupervisorReplyPrompt(messageText(message))
  const requestShown = useHasSupervisorRequest(agentId, reply?.requestId ?? '')
  if (!reply || requestShown) return null
  return (
    <ToolRow
      disclosureKey={`reply:${rowKey}`}
      icon={<CornerUpLeft className="text-fg-3" />}
      verb="You answered"
      subject={
        <>
          <span className="shrink-0 text-fg">{reply.agent}</span>
          <Quote text={firstSentence(reply.message)} />
        </>
      }
      phase="done"
      detail={
        <RowDetail copy={reply.message}>
          <MarkdownBody text={reply.message} />
        </RowDetail>
      }
    />
  )
})
