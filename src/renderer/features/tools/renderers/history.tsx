import { useAgents } from '../../../store/agents'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { MonoSubject, ToolRow } from '../ToolRow'
import { firstLine, isActive, isRecord, payloadText, resultPayload, str, toolPhase } from '../tool-utils'
import { GenericDetail, PrimaryArgSubject } from './generic'

/**
 * pi-compaction-recall (`history_*`) and pi-sessions (`session_*`) tools: generic rows with human verbs. Their
 * results have no stable structure yet, so the detail is the generic arguments + result view.
 */
const VERBS: Record<string, { live: string; done: string }> = {
  history_recall: { live: 'Recalling', done: 'Recalled history' },
  history_grep: { live: 'Searching history', done: 'Searched history' },
  history_expand: { live: 'Expanding', done: 'Expanded history' },
  session_search: { live: 'Searching sessions', done: 'Searched sessions' },
  session_ask: { live: 'Asking a session', done: 'Asked session' },
  session_send_message: { live: 'Messaging a session', done: 'Messaged session' },
  session_handoff: { live: 'Handing off', done: 'Handed off' },
  session_cancel: { live: 'Cancelling a session', done: 'Cancelled session' },
  session_reachable: { live: 'Checking a session', done: 'Checked session' }
}

/** Search-like arguments read better as a quoted query than as the generic primary argument. */
function querySubject(args: Record<string, unknown>) {
  const query = str(args.query) ?? str(args.question)
  if (query) return <span className="min-w-0 truncate">“{firstLine(query)}”</span>
  const pattern = str(args.pattern)
  if (pattern) return <MonoSubject>{pattern}</MonoSubject>
  return <PrimaryArgSubject args={args} />
}

function HistoryRow({ agentId, call, execution }: ToolRendererProps) {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  const phase = toolPhase(execution, running)
  const verbs = VERBS[call.name] ?? { live: 'Using', done: call.name }
  const args = isRecord(call.arguments) ? call.arguments : {}
  const failed = phase === 'error'
  return (
    <ToolRow
      verb={isActive(phase) ? verbs.live : verbs.done}
      subject={querySubject(args)}
      phase={phase}
      durationMs={execution?.durationMs}
      startedAt={execution?.startedAt}
      subline={failed ? firstLine(payloadText(resultPayload(execution))) || 'Failed' : undefined}
      sublineTone="danger"
      detail={<GenericDetail args={args} execution={execution} failed={failed} />}
    />
  )
}

registerToolRenderer(Object.keys(VERBS), HistoryRow)
