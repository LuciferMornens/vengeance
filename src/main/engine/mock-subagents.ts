import { randomUUID } from 'node:crypto'
import type { SubagentsRpcReply } from '@shared/api/engine'
import type { EngineEvent, RpcExtensionUIRequest, ToolCall } from '@shared/engine-types'
import {
  SUBAGENT_ASYNC_PREFIX,
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_PREFIX,
  SUBAGENT_INSPECT_WIDGET_KEY,
  type SubagentInspectReply,
  type SubagentRunState,
  type SubagentSnapshotNode
} from '@shared/subagents'
import { call, ScriptBuilder, text, uid, type MockStep, type ScriptContext } from './mock-builder'
import {
  asyncDir,
  controlNotice,
  costData,
  GREP_COUNT_COMMAND,
  GREP_COUNT_OUTPUT,
  inspectMessages,
  launchDetails,
  launchText,
  notifyCompleted,
  notifyDetails,
  notifyFailed,
  PARENT_WAKE_TEXT,
  PEEK_OUTPUT,
  peekCommand,
  REQUEST_ID,
  RESUME_MESSAGE,
  resumeText,
  REVIEWER_OUTPUT_PATH,
  REVIEWER_SUMMARY,
  REVIEWER_TASK,
  RUN_IDS,
  STEER_MESSAGE,
  statusText,
  steerText,
  SUPERVISOR_REPLY,
  supervisorRequestContent,
  supervisorRequestDetails,
  WORKER_TASK,
  WORKSPACE
} from './mock-subagents-data'

const ESC = '\u001b['
const MINUTE = 60_000
const WORKER_TIMEOUT_MS = 1_800_000
/** pi-subagents re-renders the async snapshot about this often while runs are live. */
const SNAPSHOT_INTERVAL_MS = 400
const WORKER_TOOLS = ['read', 'edit', 'bash'] as const
/** The parent waits this long before peeking at the children's output logs. */
const PEEK_WAIT_S = 30

const LSP_IDLE = `${ESC}2mLSP Inactive${ESC}22m`
const LSP_TYPESCRIPT = `${ESC}32mLSP Active: typescript${ESC}39m`

function lspStatus(statusText: string): RpcExtensionUIRequest {
  return { type: 'extension_ui_request', id: uid('ui'), method: 'setStatus', statusKey: 'pi-lens-lsp', statusText }
}

function snapshotEvent(runs: SubagentSnapshotNode[] | undefined, generatedAt: number): RpcExtensionUIRequest {
  const payload = { kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt, caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 }, omitted: { runs: 0, children: 0, byteLimitExceeded: false }, runs }
  return {
    type: 'extension_ui_request',
    id: uid('ui'),
    method: 'setWidget',
    widgetKey: SUBAGENT_ASYNC_WIDGET_KEY,
    widgetLines: runs ? [`${SUBAGENT_ASYNC_PREFIX}${JSON.stringify(payload)}`] : undefined
  }
}

function customMessage(customType: string, content: string, details: Record<string, unknown>, at: number): EngineEvent[] {
  const message = { role: 'custom' as const, customType, content, display: true, details, timestamp: at }
  return [
    { type: 'message_start', message },
    { type: 'message_end', message }
  ]
}

type FleetPhase = 'early' | 'live' | 'reviewer-done'

/** Live state of the scripted fleet at one tick; `tick` grows the counters. */
function fleet(t0: number, tick: number, phase: FleetPhase): SubagentSnapshotNode[] {
  const worker: SubagentSnapshotNode = {
    id: RUN_IDS.worker,
    kind: 'subagent',
    label: 'worker',
    state: 'running',
    startedAt: t0,
    updatedAt: t0 + tick * 1000,
    activity: { state: 'active', currentTool: WORKER_TOOLS[tick % WORKER_TOOLS.length], currentToolStartedAt: t0 + 12 * MINUTE - (8 + tick) * 1000, turnCount: 38 + tick, toolCount: 57 + tick * 2 }
  }
  const reviewerRunning = phase !== 'early'
  const reviewer: SubagentSnapshotNode = reviewerRunning
    ? { id: RUN_IDS.reviewer, kind: 'subagent', label: 'reviewer', state: phase === 'live' ? 'running' : 'complete', startedAt: t0 + 30_000, updatedAt: t0 + 11 * MINUTE, activity: { state: 'active', currentTool: 'read', currentToolStartedAt: t0 + 12 * MINUTE - 4000, turnCount: 9 + tick, toolCount: 14 + tick } }
    : { id: RUN_IDS.reviewer, kind: 'subagent', label: 'reviewer', state: 'queued', startedAt: t0 + 30_000 }
  if (reviewer.state === 'complete') reviewer.endedAt = t0 + 11 * MINUTE
  const workflowDone = phase === 'reviewer-done'
  const workflow: SubagentSnapshotNode = {
    id: RUN_IDS.workflow,
    kind: 'workflow',
    label: 'scout, reviewer',
    state: workflowDone ? 'complete' : 'running',
    startedAt: t0 + 9 * MINUTE,
    ...(workflowDone ? { endedAt: t0 + 11 * MINUTE } : {}),
    children: [
      { id: 'step:0', kind: 'step', label: 'scout', state: workflowDone ? 'complete' : 'running', startedAt: t0 + 9 * MINUTE, activity: { currentTool: 'grep', currentToolStartedAt: t0 + 12 * MINUTE - 2000, turnCount: 4 + tick, toolCount: 7 + tick } },
      { id: 'step:1', kind: 'step', label: 'reviewer', state: workflowDone ? 'complete' : 'queued' }
    ]
  }
  return phase === 'early' ? [worker, reviewer] : [worker, reviewer, workflow]
}

/** Async subagent lifecycle: launches, live snapshots, steer, supervisor request, attention, completion, failure, resume. */
export function subagents(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  // The fleet started twelve minutes ago, so clocks in screenshots read like real work.
  const t0 = ctx.now - 12 * MINUTE
  let tick = 0
  const snap = (phase: FleetPhase) => {
    tick += 1
    b.ui(snapshotEvent(fleet(t0, tick, phase), ctx.now + tick * SNAPSHOT_INTERVAL_MS), SNAPSHOT_INTERVAL_MS)
  }
  const custom = (type: string, content: string, details: Record<string, unknown>) => {
    for (const event of customMessage(type, content, details, ctx.now)) b.emit(event)
  }

  b.ui(lspStatus(LSP_IDLE))
  b.emit({ type: 'agent_start' })
  b.ui({ type: 'extension_ui_request', id: uid('ui'), method: 'setStatus', statusKey: 'subagent-slash', statusText: 'running... 2 tools | ctrl+o live detail' })
  b.turn(() => {
    b.user(ctx.prompt)
    const worker = call('subagent', { agent: 'worker', model: 'anthropic/claude-opus-5-5:high', cwd: WORKSPACE, async: true, task: WORKER_TASK, options: { timeoutMs: WORKER_TIMEOUT_MS } })
    const reviewer = call('subagent', { agent: 'reviewer', cwd: WORKSPACE, async: true, task: REVIEWER_TASK, output: 'reports/r1-code.md' })
    const message = b.assistant([{ text: 'Splitting this in two: a **worker** fixes the tree jump while a **reviewer** checks the tool rows.' }, { tool: worker }, { tool: reviewer }])
    const results = [
      b.tool(worker, launch('worker', RUN_IDS.worker, worker, ctx.now + WORKER_TIMEOUT_MS), { durationMs: 1840 }),
      b.tool(reviewer, launch('reviewer', RUN_IDS.reviewer, reviewer, ctx.now + WORKER_TIMEOUT_MS), { durationMs: 1210 })
    ]
    return { message, results }
  })
  snap('early')
  b.label('launched')
  // pi-lens starts the TypeScript server once a source file is read, and stops it after idle minutes (below).
  b.ui(lspStatus(LSP_TYPESCRIPT))
  b.turn(() => {
    const steer = call('subagent', { action: 'steer', id: RUN_IDS.worker, message: STEER_MESSAGE, options: { index: 0 } })
    const message = b.assistant([{ tool: steer }])
    const requestId = randomUUID()
    const result = b.tool(
      steer,
      {
        content: [{ type: 'text', text: steerText(RUN_IDS.worker, requestId, STEER_MESSAGE) }],
        details: { mode: 'management', results: [], steering: { requestId, state: 'pending', deliveryStatus: 'queued', sourceRunId: RUN_IDS.worker, targets: [{ index: 0, state: 'queued' }] } }
      },
      { durationMs: 40 }
    )
    return { message, results: [result] }
  })
  b.turn(() => ({ message: b.assistant([{ text: 'Both are running in the background. I will pick up their results when they report back.' }], 'stop'), results: [] }))
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.emit({ type: 'agent_settled', aborted: false }, 20)
  // The TUI progress line outlives the launches; it must never reach the screen.
  b.ui({ type: 'extension_ui_request', id: uid('ui'), method: 'setStatus', statusKey: 'subagent-slash', statusText: undefined })

  for (let i = 0; i < 4; i++) snap('live')
  b.label('fleet-live')
  snap('live')
  custom('subagent_supervisor_request', supervisorRequestContent(RUN_IDS.worker), supervisorRequestDetails(RUN_IDS.worker))
  b.label('needs-decision')
  snap('live')
  const notice = controlNotice(RUN_IDS.worker, ctx.now)
  custom('subagent_control_notice', notice.content, notice.details)
  b.label('attention')
  snap('live')

  // The parent wakes for the notices, answers the request and checks on the worker.
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(PARENT_WAKE_TEXT)
    const reply = call('subagent_supervisor', { action: 'reply', replyTo: REQUEST_ID, message: SUPERVISOR_REPLY })
    const status = call('subagent', { action: 'status', id: RUN_IDS.worker })
    const peek = call('bash', {
      command: peekCommand(PEEK_WAIT_S, [
        { runId: RUN_IDS.worker, bytes: 900 },
        { runId: RUN_IDS.reviewer, bytes: 300 }
      ])
    })
    const grepCount = call('bash', { command: GREP_COUNT_COMMAND })
    const message = b.assistant([{ tool: reply }, { tool: status }, { tool: peek }, { tool: grepCount }])
    const results = [
      b.tool(reply, { content: [{ type: 'text', text: `Replied to supervisor request ${REQUEST_ID}.` }], details: { replyTo: REQUEST_ID, runId: RUN_IDS.worker, agent: 'worker' } }, { durationMs: 30 }),
      b.tool(status, { content: [{ type: 'text', text: statusText(RUN_IDS.worker) }], details: { mode: 'single', runId: RUN_IDS.worker, results: [], lifecycleStatus: { processTerminal: { state: 'pending' } } } }, { durationMs: 60 }),
      b.tool(peek, text(PEEK_OUTPUT), { durationMs: PEEK_WAIT_S * 1000 + 33 }),
      b.tool(grepCount, text(GREP_COUNT_OUTPUT), { durationMs: 3_400, isError: true })
    ]
    return { message, results }
  })
  b.turn(() => ({ message: b.assistant([{ text: 'Answered the worker (option A). The long bash call is its test run, so I am leaving it alone.' }], 'stop'), results: [] }))
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.emit({ type: 'agent_settled', aborted: false }, 20)

  snap('reviewer-done')
  custom('subagent-notify', notifyCompleted('reviewer', RUN_IDS.reviewer, REVIEWER_SUMMARY, REVIEWER_OUTPUT_PATH), notifyDetails('reviewer', RUN_IDS.reviewer, 'completed', 10 * MINUTE + 31_000))
  custom('subagent-notify', notifyFailed('worker', RUN_IDS.worker, WORKER_TIMEOUT_MS), notifyDetails('worker', RUN_IDS.worker, 'failed', WORKER_TIMEOUT_MS - 279))
  b.ui(snapshotEvent(undefined, ctx.now), SNAPSHOT_INTERVAL_MS)
  b.ui(lspStatus(LSP_IDLE))

  // Woken again: the worker timed out, so the parent revives it.
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(PARENT_WAKE_TEXT)
    const resume = call('subagent', { action: 'resume', id: RUN_IDS.worker, message: RESUME_MESSAGE, options: { timeoutMs: 5_400_000 } })
    const message = b.assistant([{ text: 'The reviewer is done. The worker hit its timeout, so I am reviving it with a checkpoint note.' }, { tool: resume }])
    const result = b.tool(
      resume,
      {
        content: [{ type: 'text', text: resumeText(RUN_IDS.worker, RUN_IDS.resumed) }],
        details: { mode: 'single', runId: RUN_IDS.resumed, results: [], asyncId: RUN_IDS.resumed, asyncDir: asyncDir(RUN_IDS.resumed), context: 'fresh', timeoutMs: 5_400_000, sourceLaunchContractDigest: 'c0b6650d1df3cea2' }
      },
      { durationMs: 900 }
    )
    return { message, results: [result] }
  })
  const resumedAt = ctx.now - 20_000
  const resumed = (state: SubagentRunState, toolCount: number): SubagentSnapshotNode => ({
    id: RUN_IDS.resumed,
    kind: 'subagent',
    label: 'worker',
    state,
    startedAt: resumedAt,
    ...(state === 'complete' ? { endedAt: ctx.now + 4000 } : {}),
    activity: { currentTool: state === 'running' ? 'bash' : undefined, currentToolStartedAt: ctx.now - 6000, turnCount: 3 + toolCount, toolCount }
  })
  b.ui(snapshotEvent([resumed('running', 2)], ctx.now), SNAPSHOT_INTERVAL_MS)
  b.label('finished')
  b.turn(() => {
    const wait = call('bg_wait', { timeoutMs: 600_000 })
    const message = b.assistant([{ tool: wait }])
    const result = b.tool(
      wait,
      {
        content: [{ type: 'text', text: `Async run ${RUN_IDS.resumed} (worker) completed.` }],
        details: {
          wait: { reason: 'window_elapsed', timedOut: false, activeRunIds: [] },
          completions: [{ runId: RUN_IDS.resumed, agent: 'worker', mode: 'single', state: 'complete', success: true, archivePath: asyncDir(RUN_IDS.resumed), results: [{ agent: 'worker', runId: RUN_IDS.resumed, success: true, model: 'anthropic/claude-opus-5-5' }] }]
        }
      },
      {
        durationMs: 64_000,
        during: (s) => {
          s.ui(snapshotEvent([resumed('running', 6)], ctx.now), SNAPSHOT_INTERVAL_MS)
          s.ui(snapshotEvent([resumed('complete', 9)], ctx.now), SNAPSHOT_INTERVAL_MS)
          s.ui(snapshotEvent(undefined, ctx.now), SNAPSHOT_INTERVAL_MS)
        }
      }
    )
    return { message, results: [result] }
  })
  b.turn(() => ({
    message: b.assistant([{ text: 'Both are done. The tree now keeps the forked node selected, and the reviewer\'s three findings are in `reports/r1-code.md`.' }], 'stop'),
    results: []
  }))
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.label('settled').emit({ type: 'agent_settled', aborted: false }, 20)
  return b.steps
}

function launch(agent: string, runId: string, toolCall: ToolCall, deadlineAt: number) {
  return { content: text(launchText(agent, runId)).content, details: launchDetails(runId, toolCall.id, WORKER_TIMEOUT_MS, deadlineAt) }
}

// ─── Runtime: the mock's answers to the host's subagent commands ──────────────────────────────────

interface RunInfo {
  label: string
  task: string
}

const KNOWN_RUNS: Record<string, RunInfo> = {
  [RUN_IDS.worker]: { label: 'worker', task: WORKER_TASK },
  [RUN_IDS.reviewer]: { label: 'reviewer', task: REVIEWER_TASK },
  [RUN_IDS.workflow]: { label: 'scout, reviewer', task: 'Fan out the lane review: scout maps the tool renderers, reviewer checks each one.' },
  [RUN_IDS.resumed]: { label: 'worker', task: WORKER_TASK }
}

function parsePayloadRuns(lines: string[] | undefined): SubagentSnapshotNode[] | null {
  const line = lines?.[0]
  if (!line?.startsWith(SUBAGENT_ASYNC_PREFIX)) return null
  return (JSON.parse(line.slice(SUBAGENT_ASYNC_PREFIX.length)) as { runs: SubagentSnapshotNode[] }).runs
}

/**
 * Stand-in for pi-subagents inside the mock engine: answers the bridge's event-bus RPC
 * (`vengeance-subagents`), `/subagents-inspect-rpc` and the stop/steer/detach slash commands, and folds
 * the host's stops and resumes into every snapshot the script emits afterwards.
 */
export class MockSubagentRuntime {
  /** Runs of the last snapshot as sent (after overrides). */
  private runs: SubagentSnapshotNode[] = []
  private readonly states = new Map<string, SubagentRunState>()
  private readonly overrides = new Map<string, Partial<SubagentSnapshotNode>>()
  /** Runs started by the host (resume) that the script does not know about. */
  private readonly extra: SubagentSnapshotNode[] = []
  private readonly infos = new Map<string, RunInfo>(Object.entries(KNOWN_RUNS))

  constructor(private readonly emit: (event: EngineEvent) => void) {}

  /** Apply host-made changes to an outgoing snapshot and remember run states (call for every emitted event). */
  rewrite(event: EngineEvent): EngineEvent {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'subagent-notify') {
      const runs = (event.message.details as { runs?: Array<{ runId: string; status: string }> } | undefined)?.runs ?? []
      for (const run of runs) this.states.set(run.runId, run.status === 'completed' ? 'complete' : 'failed')
    }
    if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== SUBAGENT_ASYNC_WIDGET_KEY) return event
    const scripted = parsePayloadRuns(event.widgetLines) ?? []
    const runs = [...scripted, ...this.extra.filter((run) => !scripted.some((s) => s.id === run.id))].map((run) => ({ ...run, ...this.overrides.get(run.id) }))
    this.runs = runs
    for (const run of runs) this.states.set(run.id, run.state)
    return snapshotEvent(runs.length ? runs : undefined, Date.now())
  }

  /** `/subagents-*` prompts; true when handled (extension commands run even while the agent streams). */
  command(message: string): boolean {
    const inspect = /^\/subagents-inspect-rpc\s+(\S+)\s+(\S+)(?:\s+(?!--)(\S+))?/.exec(message)
    if (inspect) {
      this.emitWidget(SUBAGENT_INSPECT_WIDGET_KEY, [`${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1, ...this.inspect(inspect[1]!, inspect[2]!, inspect[3]) })}`])
      this.emitWidget(SUBAGENT_INSPECT_WIDGET_KEY, undefined)
      return true
    }
    const slash = /^\/subagents-(stop|steer|detach)(?:\s+(\S+))?(?:\s+--child\s+(\S+))?\s*(.*)$/s.exec(message)
    if (!slash) return false
    const [, verb, runId = '', child] = slash
    if (verb === 'stop' && runId) this.stop(runId, child)
    const text = verb === 'stop' ? `Stop requested for async run ${runId}.` : verb === 'steer' ? `Steering queued for async run ${runId}.` : 'Detached the foreground subagent run.'
    for (const event of customMessage('subagent-slash-text-result', text, { command: `subagents-${verb}` }, Date.now())) this.emit(event)
    return true
  }

  /** pi-subagents' event-bus RPC as the bridge sees it. */
  rpc(method: string, params: Record<string, unknown>): SubagentsRpcReply {
    const id = typeof params.id === 'string' ? params.id : ''
    switch (method) {
      case 'ping':
        return { success: true, data: { version: 1, methods: ['ping', 'status', 'manage', 'spawn', 'steer', 'interrupt', 'stop', 'resume', 'cost'], capabilities: { status: true, steer: true, nonRecoveringSteer: true, interrupt: true, stop: true, resume: true, cost: { version: 1 } } } }
      case 'steer': {
        if (!this.known(id)) return this.notFound(id)
        const requestId = randomUUID()
        return { success: true, data: { text: `Steering delivered to async run ${id} (request ${requestId}).`, details: { mode: 'management', results: [], steering: { requestId, state: 'delivered', deliveryStatus: 'delivered', sourceRunId: id, targets: [{ index: 0, state: 'delivered' }] } } } }
      }
      case 'stop':
      case 'interrupt':
        if (!this.known(id)) return this.notFound(id)
        this.stop(id, typeof params.childId === 'string' ? params.childId : undefined, method === 'interrupt' ? 'paused' : 'stopped')
        return { success: true, data: { runId: id, previousState: 'running', state: 'stopping', message: `Stop requested for async run ${id}.` } }
      case 'resume':
        return this.resume(id)
      case 'status':
        return { success: true, data: { text: statusText(id), details: { mode: 'single', runId: id, results: [] } } }
      case 'cost':
        return {
          success: true,
          data: costData([
            { agent: 'reviewer', runId: RUN_IDS.reviewer, input: 58_400, output: 9_100, cost: 0.84, turns: 21 },
            { agent: 'worker', runId: RUN_IDS.worker, input: 88_000, output: 10_300, cost: 1.2, turns: 41 }
          ])
        }
      default:
        return { success: false, error: { code: 'unsupported_method', message: `Unsupported subagent RPC method: ${method}` } }
    }
  }

  private known(id: string): boolean {
    return this.infos.has(id)
  }

  private notFound(id: string): SubagentsRpcReply {
    return { success: false, error: { code: 'not_found', message: `Async run '${id}' was not found in the active session.` } }
  }

  private emitWidget(widgetKey: string, widgetLines: string[] | undefined): void {
    this.emit({ type: 'extension_ui_request', id: uid('ui'), method: 'setWidget', widgetKey, widgetLines })
  }

  /** Re-send the last snapshot so host changes show without waiting for the script's next one. */
  private republish(): void {
    const scripted = this.runs.filter((run) => !this.extra.some((extra) => extra.id === run.id))
    this.emit(snapshotEvent(scripted, Date.now()))
  }

  private stop(runId: string, childId: string | undefined, state: SubagentRunState = 'stopped'): void {
    if (childId) {
      const run = this.runs.find((candidate) => candidate.id === runId)
      const children = run?.children?.map((child) => (child.id === childId ? { ...child, state } : child))
      if (children) this.overrides.set(runId, { ...this.overrides.get(runId), children })
    } else {
      this.overrides.set(runId, { state, endedAt: Date.now(), activity: undefined })
    }
    this.republish()
  }

  private resume(id: string): SubagentsRpcReply {
    const info = this.infos.get(id)
    if (!info) return this.notFound(id)
    const runId = randomUUID()
    this.infos.set(runId, info)
    this.extra.push({ id: runId, kind: 'subagent', label: info.label, state: 'running', startedAt: Date.now(), activity: { state: 'active', turnCount: 0, toolCount: 0 } })
    this.republish()
    return { success: true, data: { text: resumeText(id, runId), details: { mode: 'single', runId, asyncId: runId, results: [] } } }
  }

  private inspect(requestId: string, asyncId: string, childId: string | undefined): SubagentInspectReply {
    const info = this.infos.get(asyncId)
    if (!info) return { requestId, asyncId, error: { code: 'not_found', message: `Async run '${asyncId}' was not found in the current session.` } }
    const status = this.states.get(asyncId) ?? 'running'
    const label = childId ? (this.runs.find((run) => run.id === asyncId)?.children?.find((child) => child.id === childId)?.label ?? info.label) : info.label
    return {
      requestId,
      asyncId,
      childId,
      status,
      label,
      task: info.task,
      messages: inspectMessages(label),
      ...(status === 'complete' ? { finalOutput: label === 'reviewer' ? REVIEWER_SUMMARY : 'The forked node now stays selected and in view. Typecheck, build and shots pass.' } : {}),
      truncated: { task: false, messages: 28, finalOutput: false }
    }
  }
}
