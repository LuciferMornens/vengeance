import type { ReactNode } from 'react'
import { ArrowRight, Circle, Eye, List, Pause, RotateCw, Square, SquareTerminal } from 'lucide-react'
import type { ToolCall } from '@shared/engine-types'
import { formatSubagentDuration, isSubagentRunState, type SubagentRunState } from '@shared/subagents'
import type { ToolExecution } from '../../../store/agent-state'
import { useAgents } from '../../../store/agents'
import { Markdown } from '../../../ui/Markdown'
import { openSubagentDetail, RunGlyph, runTitle, subagentActions, useResumedRunIds, useSubagentRun, type SubagentRunView } from '../../subagents'
import { registerToolRenderer, type ToolRendererProps } from '../registry'
import { DetailSection, Elapsed, RowDetail, ToolRow } from '../ToolRow'
import { detailsOf, firstLine, isActive, isBenignFailure, isRecord, payloadText, plural, records, resultPayload, str, toolPhase, type ToolPhase } from '../tool-utils'

/**
 * pi-subagents' `subagent` tool. The result text is written for the model (run ids, async dirs, "Detached.
 * Return control now…", `subagent({...})` hints), so it is never shown outside the Raw view: every action is
 * one human row built from the arguments, `details`, and the live run state the subagents feature keeps.
 */

/** Agent names a workflow row lists before "+N". */
const MAX_NAMED_AGENTS = 2

/** Run id a launch or resume result refers to (`details.runId`, else the async id). */
function subagentRunId(execution: ToolExecution | undefined): string | undefined {
  const details = detailsOf(execution)
  return str(details?.runId) ?? str(details?.asyncId) ?? str(records(details?.results)[0]?.runId)
}

/** A run fact after the first ("· 3m"), kept whole: a narrow launch row drops trailing facts, never half of one. */
function Fact({ children }: { children: ReactNode }) {
  return (
    <>
      {' '}
      <span className="whitespace-nowrap">
        {'\u00b7 '}
        {children}
      </span>
    </>
  )
}

/** "running · 3m · 41 tools" / "finished · 25m" / "needs you" for a run, tone included; facts by priority. */
function RunState({ view, resumed }: { view: SubagentRunView; resumed?: boolean }) {
  if (view.needsDecision)
    return <span className="font-medium whitespace-nowrap text-warning">needs you</span>
  const elapsed = view.startedAt && view.endedAt ? formatSubagentDuration(view.endedAt - view.startedAt) : undefined
  switch (view.state) {
    case 'running':
      return (
        <span>
          running
          {view.startedAt ? (
            <Fact>
              <Elapsed since={view.startedAt} />
            </Fact>
          ) : null}
          {view.tools ? <Fact>{plural(view.tools, 'tool')}</Fact> : null}
        </span>
      )
    case 'queued':
      return <span>queued</span>
    case 'paused':
      return <span>paused</span>
    case 'complete':
      return <span>finished{elapsed ? <Fact>{elapsed}</Fact> : null}</span>
    case 'partial':
      return <span className="whitespace-nowrap">partly finished</span>
    case 'failed':
    case 'rejected':
      // A failure a later run revived is handled: it stays in the history without the danger tone.
      if (resumed)
        return (
          <span>
            {view.state}
            <Fact>resumed</Fact>
          </span>
        )
      return <span className="text-danger">{view.state}</span>
    case 'stopped':
      return <span>stopped</span>
    default:
      return null
  }
}

/** Display name of the run a management call targets (`args.id`). */
function useTargetLabel(agentId: string, runId: string | undefined): string {
  const view = useSubagentRun(agentId, runId)
  return view?.label ?? 'agent'
}

function Quote({ text }: { text: string }) {
  return <span className="min-w-0 truncate text-fg-3">“{firstLine(text)}”</span>
}

function MarkdownDetail({ text, label }: { text: string; label?: string }) {
  const body = (
    <div className="px-3.5 py-3">
      <Markdown text={text.slice(0, 20_000)} size="compact" />
    </div>
  )
  return label ? <DetailSection label={label}>{body}</DetailSection> : body
}

function usePhase(agentId: string, execution: ToolExecution | undefined): ToolPhase {
  const running = useAgents((s) => s.agents[agentId]?.phase === 'running')
  return toolPhase(execution, running)
}

/** First line of an error result; pi-subagents' messages name the engine, which the app calls "Engine". */
function failureLine(execution: ToolExecution | undefined, fallback: string): string {
  return firstLine(payloadText(resultPayload(execution))).replace(/\bPi\b/g, 'Engine') || fallback
}

/** Workflow / multi-agent launches: agent names from the workflow tasks or the live children. */
function workflowAgents(call: ToolCall, view: SubagentRunView | null): string[] {
  const args = isRecord(call.arguments.args) ? call.arguments.args : {}
  const fromArgs = records(args.tasks ?? args.steps ?? call.arguments.tasks).map((task) => str(task.agent) ?? 'agent')
  return fromArgs.length > 0 ? fromArgs : (view?.children.map((child) => child.label) ?? [])
}

function WorkflowSubject({ agents }: { agents: string[] }) {
  if (agents.length === 0) return null
  const named = agents.slice(0, MAX_NAMED_AGENTS).join(' \u00b7 ')
  return (
    <>
      <span className="shrink-0 text-fg">{plural(agents.length, 'agent')}</span>
      <span className="min-w-0 truncate text-fg-3">
        {named}
        {agents.length > MAX_NAMED_AGENTS ? ` \u00b7 +${agents.length - MAX_NAMED_AGENTS}` : ''}
      </span>
    </>
  )
}

/** Foreground progress (`details.progress[0]` / `results[0].progress`) while a synchronous run streams. */
function foregroundActivity(execution: ToolExecution | undefined): string | undefined {
  const details = detailsOf(execution)
  const resultProgress = records(details?.results)[0]?.progress
  const progress = records(details?.progress)[0] ?? (isRecord(resultProgress) ? resultProgress : undefined)
  const tool = str(progress?.currentTool)
  if (!tool) return undefined
  const args = str(progress?.currentToolArgs)
  return args ? `${tool} \u00b7 ${firstLine(args)}` : tool
}

const FOREGROUND_STATE: Record<ToolPhase, SubagentRunView['state']> = {
  streaming: 'queued',
  pending: 'queued',
  running: 'running',
  done: 'complete',
  error: 'failed',
  aborted: 'stopped'
}

/** A launch: one agent with a task, a workflow, or a synchronous (foreground) run. */
function LaunchRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = usePhase(agentId, execution)
  const runId = subagentRunId(execution)
  const view = useSubagentRun(agentId, runId)
  const workflow = call.arguments.workflow !== undefined || records(call.arguments.tasks).length > 0
  const foreground = call.arguments.async === false || (!str(detailsOf(execution)?.asyncId) && records(detailsOf(execution)?.results).length > 0)
  const label = view?.label ?? str(call.arguments.agent) ?? (workflow ? 'workflow' : 'agent')
  const title = view?.title ?? runTitle(undefined, str(call.arguments.task)) ?? ''
  const output = str(call.arguments.output)
  const failed = phase === 'error'
  // A foreground run's own call is its lifecycle; async runs without a snapshot or notice stay unknown.
  const settledState: SubagentRunView['state'] = view?.state ?? (foreground ? FOREGROUND_STATE[phase] : 'unknown')
  const first = records(detailsOf(execution)?.results)[0]
  const finalOutput = str(first?.finalOutput) ?? str(first?.error)
  const live = isActive(phase)
  const activity = foreground && live ? foregroundActivity(execution) : undefined
  const agents = workflow ? workflowAgents(call, view) : []
  const runningChildren = view?.children.filter((child) => child.state === 'running').length ?? 0
  const resumed = useResumedRunIds(agentId).has(runId ?? '')

  let meta: ReactNode = null
  if (view && !live && !failed)
    meta =
      workflow && runningChildren > 0 ? (
        <span className="whitespace-nowrap">{runningChildren} running</span>
      ) : (
        <RunState view={view} resumed={resumed} />
      )
  // The run facts ride in the subject rather than ToolRow's fixed meta slot, so a narrow row gives them up first:
  // trailing facts wrap whole onto a clipped second line, and the task title truncates only once the state is alone.
  const subject = (
    <>
      {workflow ? (
        <WorkflowSubject agents={agents} />
      ) : (
        <>
          <span className="min-w-0 truncate">{title}</span>
          {output && (
            <span className="max-w-[40%] shrink-0 truncate font-mono text-[11.5px] text-fg-3">
              {'\u2192'} {output.split(/[\\/]/).pop()}
            </span>
          )}
        </>
      )}
      {meta && (
        <span className="ml-auto h-lh shrink-[100] overflow-clip text-right text-xs text-fg-3 tabular">
          {meta}
        </span>
      )}
    </>
  )
  const resumedFailure = resumed && !failed && (settledState === 'failed' || settledState === 'rejected')
  const glyph = resumedFailure ? <RotateCw className="text-fg-3" /> : <RunGlyph state={failed ? 'failed' : settledState} needsDecision={view?.needsDecision} />

  return (
    <ToolRow
      icon={glyph}
      verb={label}
      subject={subject}
      phase={phase}
      startedAt={execution?.startedAt}
      durationMs={foreground ? execution?.durationMs : undefined}
      subline={
        failed ? (
          failureLine(execution, 'Launch failed')
        ) : activity ? (
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-[11.5px]">{activity}</span>
            <button
              type="button"
              onClick={() => void subagentActions.detachForeground(agentId, runId)}
              className="shrink-0 font-sans font-medium text-fg-2 transition-colors hover:text-fg"
            >
              Send to background
            </button>
          </span>
        ) : undefined
      }
      sublineTone={failed ? 'danger' : 'neutral'}
      onOpen={!foreground && runId ? () => openSubagentDetail(agentId, runId) : undefined}
      detail={
        foreground && !live ? (
          <RowDetail copy={finalOutput}>
            {str(call.arguments.task) && <MarkdownDetail label="Task" text={str(call.arguments.task)!} />}
            {finalOutput && <MarkdownDetail label="Output" text={finalOutput} />}
          </RowDetail>
        ) : undefined
      }
    />
  )
}

/** `resume`: revives a finished run with a message; the new run id is in `details.runId`. */
function ResumeRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = usePhase(agentId, execution)
  const newRunId = subagentRunId(execution)
  const view = useSubagentRun(agentId, newRunId)
  const label = useTargetLabel(agentId, str(call.arguments.id))
  const message = str(call.arguments.message) ?? ''
  return (
    <ToolRow
      icon={<RotateCw className="text-fg-3" />}
      verb="Resumed"
      subject={
        <>
          <span className="shrink-0 text-fg">{view?.label ?? label}</span>
          {message && <Quote text={message} />}
        </>
      }
      meta={view && phase === 'done' ? <RunState view={view} /> : null}
      phase={phase}
      subline={phase === 'error' ? failureLine(execution, 'Resume failed') : undefined}
      sublineTone="danger"
      onOpen={newRunId ? () => openSubagentDetail(agentId, newRunId) : undefined}
    />
  )
}

/** `steer`: a message into a running child (`options.mode: follow_up` waits for its current turn). */
function SteerRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = usePhase(agentId, execution)
  const label = useTargetLabel(agentId, str(call.arguments.id))
  const options = isRecord(call.arguments.options) ? call.arguments.options : {}
  const followUp = str(options.mode) === 'follow_up'
  const steering = detailsOf(execution)?.steering
  const delivery = isRecord(steering) ? str(steering.deliveryStatus) : undefined
  const message = str(call.arguments.message) ?? ''
  return (
    <ToolRow
      icon={<ArrowRight className="text-fg-3" />}
      verb={followUp ? 'Queued for' : 'Told'}
      subject={
        <>
          <span className="shrink-0 text-fg">{label}</span>
          {message && <Quote text={message} />}
        </>
      }
      meta={phase === 'done' && delivery ? <span>{delivery}</span> : null}
      phase={phase}
      subline={phase === 'error' ? failureLine(execution, 'Steering failed') : undefined}
      sublineTone="danger"
      detail={message ? <RowDetail copy={message}>{<MarkdownDetail text={message} />}</RowDetail> : undefined}
    />
  )
}

/** Header lines of a status reply that are ids, paths or hints for the model. */
const STATUS_NOISE = /^(Status target|Spawn budget|Run fan-out|Dir|Async dir|Output|Revive|Events|Session|Intercom target|Mission|Status if needed|One-shot check)\b.*$/
const MODEL_HINT = /subagent\(\{.*\}\)/

/** The human part of a status reply: its transcript lines without the id/path header or `subagent({...})` hints. */
function statusBody(text: string): string {
  return text
    .split('\n')
    .filter((line) => !STATUS_NOISE.test(line.trim()) && !MODEL_HINT.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** `State: running` from a status reply (used when the run has no live snapshot). */
function parsedState(text: string): SubagentRunState | undefined {
  const state = /^State:\s*(\w+)\s*$/m.exec(text)?.[1]
  return isSubagentRunState(state) ? state : undefined
}

const STATE_WORD: Partial<Record<SubagentRunView['state'], string>> = { complete: 'finished' }

/** `status`: a look at a run (or its transcript with `options.view: "transcript"`). */
function StatusRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = usePhase(agentId, execution)
  const runId = str(call.arguments.id)
  const view = useSubagentRun(agentId, runId)
  const label = view?.label ?? 'agent'
  const options = isRecord(call.arguments.options) ? call.arguments.options : {}
  const transcript = str(options.view) === 'transcript'
  const text = payloadText(resultPayload(execution))
  const state = view?.live ? view.state : (parsedState(text) ?? view?.state)
  const body = statusBody(text)
  return (
    <ToolRow
      icon={<Eye className="text-fg-3" />}
      verb={transcript ? 'Looked at' : 'Checked on'}
      subject={<span className="shrink-0 text-fg">{transcript ? `${label}\u2019s transcript` : label}</span>}
      meta={!transcript && phase === 'done' && state && state !== 'unknown' ? <span>{STATE_WORD[state] ?? state}</span> : null}
      phase={phase}
      subline={phase === 'error' ? failureLine(execution, 'Status check failed') : undefined}
      sublineTone="danger"
      detail={body && phase !== 'error' ? <RowDetail copy={body}>{<MarkdownDetail text={body} />}</RowDetail> : undefined}
    />
  )
}

/** `stop` / `interrupt`. */
function StopRow({ agentId, call, execution }: ToolRendererProps) {
  const phase = usePhase(agentId, execution)
  const label = useTargetLabel(agentId, str(call.arguments.id))
  const pause = str(call.arguments.action) === 'interrupt'
  return (
    <ToolRow
      icon={pause ? <Pause className="text-fg-3" /> : <Square className="size-3 fill-current text-fg-3" />}
      verb={pause ? 'Paused' : 'Stopped'}
      subject={<span className="shrink-0 text-fg">{label}</span>}
      phase={phase}
      subline={phase === 'error' ? failureLine(execution, pause ? 'Pause failed' : 'Stop failed') : undefined}
      sublineTone="danger"
    />
  )
}

const MANAGEMENT_VERBS: Record<string, string> = {
  list: 'Listed agents',
  get: 'Read agent',
  models: 'Listed models',
  guide: 'Read the subagents guide',
  doctor: 'Ran subagent diagnostics',
  'children.list': 'Listed retained agents',
  validate: 'Validated workflow'
}

const COMMAND_VERBS: Record<string, string> = {
  'command.status': 'Checked',
  'command.yield': 'Released',
  'command.cancel': 'Cancelled'
}

const LIST_ACTIONS = new Set(['list', 'models', 'children.list'])

function ManageGlyph({ action }: { action: string }) {
  if (LIST_ACTIONS.has(action)) return <List className="text-fg-3" />
  if (COMMAND_VERBS[action]) return <SquareTerminal className="text-fg-3" />
  return <Circle className="size-2.5 text-fg-3" strokeWidth={2.5} />
}

/**
 * Management (`list`, `get`, `guide`…) and child command control (`command.status|yield|cancel`). A command
 * check on a child with no command running is an answer, not a failure.
 */
function ManageRow({ agentId, call, execution }: ToolRendererProps) {
  const noCommand = isBenignFailure(call, execution)
  const callPhase = usePhase(agentId, execution)
  const phase = noCommand ? 'done' : callPhase
  const action = str(call.arguments.action) ?? ''
  const label = useTargetLabel(agentId, str(call.arguments.id))
  const text = noCommand ? '' : payloadText(resultPayload(execution))
  const failed = phase === 'error'
  const command = COMMAND_VERBS[action]
  const topic = str(call.arguments.agent) ?? str(call.arguments.name) ?? str(call.arguments.topic)
  const verb = command ?? MANAGEMENT_VERBS[action] ?? 'Managed agents'
  return (
    <ToolRow
      icon={<ManageGlyph action={action} />}
      verb={verb}
      subject={
        command ? (
          <span className="shrink-0 text-fg">{`${label}\u2019s command`}</span>
        ) : topic ? (
          <span className="min-w-0 truncate">{topic}</span>
        ) : !MANAGEMENT_VERBS[action] && action ? (
          <span className="min-w-0 truncate text-fg-3">{action.replace(/[._]/g, ' ')}</span>
        ) : undefined
      }
      meta={noCommand ? <span>no command running</span> : null}
      phase={phase}
      subline={failed ? failureLine(execution, 'Failed') : undefined}
      sublineTone="danger"
      detail={text && !failed ? <RowDetail copy={text}>{<MarkdownDetail text={statusBody(text)} />}</RowDetail> : undefined}
    />
  )
}

const ACTION_ROWS: Record<string, (props: ToolRendererProps) => ReactNode> = {
  resume: ResumeRow,
  steer: SteerRow,
  status: StatusRow,
  stop: StopRow,
  interrupt: StopRow
}

function SubagentRow(props: ToolRendererProps) {
  const action = str(props.call.arguments.action)
  if (!action) return <LaunchRow {...props} />
  const Row = ACTION_ROWS[action] ?? ManageRow
  return <Row {...props} />
}

/** Whether a call is a live run that stays pinned under a folded group (a launch or resume whose run is active). */
export function isPinnedRun(call: ToolCall, execution: ToolExecution | undefined, liveRunIds: ReadonlySet<string>): boolean {
  if (call.name !== 'subagent') return false
  const action = str(call.arguments.action)
  if (action !== undefined && action !== 'resume') return false
  const runId = subagentRunId(execution)
  return runId !== undefined && liveRunIds.has(runId)
}

registerToolRenderer(['subagent', 'subagents', 'task', 'Task'], SubagentRow)
