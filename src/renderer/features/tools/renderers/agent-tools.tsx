import { Check, CornerUpLeft, Flag, Hourglass, X } from 'lucide-react'
import { cn } from '../../../lib/cn'
import { formatDuration } from '../../../lib/format'
import { useAgents } from '../../../store/agents'
import { Markdown } from '../../../ui/Markdown'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { useUserSupervisorReply } from '../supervisor-exchange'
import { DetailSection, RowDetail, ToolRow } from '../ToolRow'
import { bool, detailsOf, firstLine, HIDDEN_TOOLS, isActive, isRecord, num, payloadText, records, resultPayload, str, strings, toolPhase } from '../tool-utils'

/**
 * Subagent plumbing tools the parent (or a child) model calls: `bg_wait`, `subagent_supervisor`,
 * `contact_supervisor`. Each reads as one human sentence; ids and recovery hints never show.
 */

function usePhase(agentId: string, props: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  return toolPhase(props.execution, running)
}

/** "worker, reviewer" / "worker +2" for the agents a call is about. */
function agentList(names: string[]): string {
  const unique = [...new Set(names)]
  if (unique.length <= 2) return unique.join(', ')
  return `${unique.slice(0, 2).join(', ')} +${unique.length - 2}`
}

const WAIT_INTERRUPTED: Record<string, string> = {
  supervisor_request: 'interrupted by a question',
  user_input: 'interrupted by you'
}

/** "finished" / "1 finished, 1 failed" / "interrupted by a question" / "still running after 30m". */
function waitOutcome(wait: Record<string, unknown> | undefined, completions: Record<string, unknown>[], waitedMs: number | undefined): string {
  const interrupted = WAIT_INTERRUPTED[str(wait?.reason) ?? '']
  if (interrupted) return interrupted
  const failed = completions.filter((c) => bool(c.success) === false).length
  if (completions.length > 0) {
    if (failed === 0) return 'finished'
    return failed === completions.length ? `${failed} failed` : `${completions.length - failed} finished, ${failed} failed`
  }
  if (strings(wait?.activeRunIds).length > 0 || bool(wait?.timedOut)) {
    return waitedMs ? `still running after ${formatDuration(waitedMs)}` : 'still running'
  }
  return ''
}

/** `bg_wait`: blocks the parent until a background run changes (details.wait, details.completions). */
function BgWaitRow(props: ToolRendererProps) {
  const { agentId, execution } = props
  const phase = usePhase(agentId, props)
  const details = detailsOf(execution)
  const wait = isRecord(details?.wait) ? details.wait : undefined
  const completions = records(details?.completions)
  const failed = completions.some((c) => bool(c.success) === false)
  const names = completions.map((c) => str(c.agent) ?? 'agent')
  const outcome = waitOutcome(wait, completions, execution?.durationMs)
  return (
    <ToolRow
      icon={<Hourglass className="text-fg-3" />}
      verb={isActive(phase) ? 'Waiting for' : 'Waited for'}
      subject={<span className="min-w-0 truncate">{names.length > 0 ? agentList(names) : 'background agents'}</span>}
      meta={phase === 'done' && outcome ? <span className={cn(failed && 'text-danger')}>{outcome}</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={phase === 'error' ? firstLine(payloadText(resultPayload(execution))) || 'Wait failed' : undefined}
      sublineTone="danger"
      detail={
        completions.length > 0 ? (
          <RowDetail>
            <div className="py-1.5">
              {completions.map((c, i) => {
                const ok = bool(c.success) !== false
                return (
                  <div key={i} className="flex h-7 items-center gap-2 px-3.5 text-sm">
                    {ok ? <Check className="size-3.5 text-fg-3" strokeWidth={2.5} aria-label="Finished" /> : <X className="size-3.5 text-danger" strokeWidth={2.75} aria-label="Failed" />}
                    <span className="font-medium text-fg">{str(c.agent) ?? 'agent'}</span>
                    <span className="text-fg-3">{ok ? 'finished' : (str(c.state) ?? 'failed')}</span>
                  </div>
                )
              })}
            </div>
          </RowDetail>
        ) : undefined
      }
    />
  )
}

/**
 * `subagent_supervisor` (parent side): replies to a child's question, or checks the open ones. Relaying an
 * answer the user gave from the app renders nothing: the request row already shows it (unless the relay failed).
 */
function SupervisorRow(props: ToolRendererProps) {
  const { agentId, call, execution } = props
  const phase = usePhase(agentId, props)
  const details = detailsOf(execution)
  const action = str(call.arguments.action) ?? 'reply'
  const message = str(call.arguments.message) ?? ''
  const agent = str(details?.agent) ?? 'subagent'
  const text = payloadText(resultPayload(execution))
  const failed = phase === 'error'
  const userReply = useUserSupervisorReply(agentId, str(call.arguments.replyTo))
  if (action === 'reply') {
    if (userReply !== undefined && !failed) return null
    return (
      <ToolRow
        icon={<CornerUpLeft className="text-fg-3" />}
        verb={isActive(phase) ? 'Answering' : 'Answered'}
        subject={
          <>
            <span className="shrink-0 text-fg">{agent}</span>
            {message && <span className="min-w-0 truncate text-fg-3">“{firstLine(message)}”</span>}
          </>
        }
        phase={phase}
        subline={failed ? firstLine(text) || 'Reply failed' : undefined}
        sublineTone="danger"
        detail={
          message ? (
            <RowDetail copy={message}>
              <div className="px-3.5 py-3">
                <Markdown text={message} size="compact" />
              </div>
            </RowDetail>
          ) : undefined
        }
      />
    )
  }
  const pendingInText = /(\d+)\s+pending/i.exec(text)
  const pending = num(details?.pending) ?? (pendingInText ? Number(pendingInText[1]) : undefined)
  return (
    <ToolRow
      icon={<CornerUpLeft className="text-fg-3" />}
      verb={isActive(phase) ? 'Checking open questions' : 'Checked open questions'}
      meta={phase === 'done' && pending !== undefined ? <span>{pending} pending</span> : null}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Check failed' : undefined}
      sublineTone="danger"
    />
  )
}

const REPLY_PREFIX = /^\s*\*\*Reply from supervisor:\*\*\s*/

/** `contact_supervisor` (child side): a question to the parent session and the reply it got. */
function ContactSupervisorRow(props: ToolRendererProps) {
  const { agentId, call, execution } = props
  const phase = usePhase(agentId, props)
  const question = str(call.arguments.message) ?? ''
  const reason = (str(call.arguments.reason) ?? '').replace(/_/g, ' ')
  const text = payloadText(resultPayload(execution))
  const reply = REPLY_PREFIX.test(text) ? text.replace(REPLY_PREFIX, '').trim() : ''
  const failed = phase === 'error'
  const answered = phase === 'done' && reply !== ''
  return (
    <ToolRow
      icon={answered ? <CornerUpLeft className="text-fg-3" /> : <Flag className="text-fg-3" />}
      verb={answered ? 'Supervisor replied' : 'Asked the supervisor'}
      subject={<span className="min-w-0 truncate text-fg-3">{answered ? `“${firstLine(reply)}”` : reason}</span>}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(text) || 'Request failed' : undefined}
      sublineTone="danger"
      detail={
        question ? (
          <RowDetail copy={reply || question}>
            <DetailSection label="Question">
              <div className="px-3.5 pt-1 pb-3">
                <Markdown text={question} size="compact" />
              </div>
            </DetailSection>
            {reply && (
              <DetailSection label="Reply">
                <div className="px-3.5 pt-1 pb-3">
                  <Markdown text={reply} size="compact" />
                </div>
              </DetailSection>
            )}
          </RowDetail>
        ) : undefined
      }
    />
  )
}

/** Tools that only switch other tools on render nothing (the transcript also leaves them out of groups). */
function HiddenTool() {
  return null
}

registerToolRenderer('bg_wait', BgWaitRow)
registerToolRenderer('subagent_supervisor', SupervisorRow)
registerToolRenderer('contact_supervisor', ContactSupervisorRow)
registerToolRenderer([...HIDDEN_TOOLS], HiddenTool)
