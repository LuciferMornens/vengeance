import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_STATUS_PREFIX,
  type BridgeResult,
  type BridgeTreeResult,
  type CreateAgentArgs,
  type EngineStatus,
  type MockPlayArgs,
  type MockScriptName
} from '@shared/api/engine'
import { isSpeedMode, SPEED_STATUS_KEY, type SpeedMode, type SpeedState } from '@shared/api/speed'
import type {
  AgentMessage,
  AssistantMessage,
  EngineEvent,
  FlatTreeNode,
  Model,
  QueueMode,
  RpcCommand,
  RpcCommandType,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcResponseDataMap,
  RpcSessionState,
  SessionEntry,
  SessionStats,
  SessionTreeNode,
  ThinkingLevel,
  UserMessage
} from '@shared/engine-types'
import { Emitter, type EngineHandle, type EngineHandleEvents } from './handle'
import {
  MOCK_BRIDGE_COMMANDS,
  MOCK_COMMANDS,
  MOCK_DEFAULT_ACTIVE_TOOLS,
  MOCK_MODELS,
  MOCK_SUBAGENT_COMMANDS,
  MOCK_TOOLS,
  thinkingLevelsFor
} from './mock-data'
import { buildScript, type MockStep } from './mock-scripts'
import { MockSpeed } from './mock-speed'
import { MockSubagentRuntime } from './mock-subagents'
import { mockLongSessionEntries, mockSessionHistory } from './mock-sessions'
import { mockUiRequests } from './mock-ui'
import { flattenSessionTree } from './session-tree'

const ESC = '\u001b['

function hex8(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

function sleep(ms: number, timers: Set<() => void>): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      timers.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timers.add(finish)
  })
}

function textOf(message: UserMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

interface Run {
  steps: MockStep[]
  index: number
  instant: boolean
  pauseAt: string | undefined
  aborted: boolean
  resume: (() => void) | null
  dialog: { id: string; resolve: (response: RpcExtensionUIResponse | null) => void } | null
}

/**
 * Scripted stand-in for `pi --mode rpc` (VENGEANCE_MOCK=1). Speaks the same event protocol, keeps a
 * plausible session (messages, entries/tree, stats, queue, model/thinking state) and answers every command.
 */
export class MockEngineProcess implements EngineHandle {
  readonly pid = undefined
  readonly error = undefined
  private readonly emitter = new Emitter<EngineHandleEvents>()
  private _status: EngineStatus = 'starting'
  private readonly timers = new Set<() => void>()

  private model: Model
  private thinkingLevel: ThinkingLevel = 'medium'
  private steeringMode: QueueMode = 'one-at-a-time'
  private followUpMode: QueueMode = 'one-at-a-time'
  private autoCompaction = true
  private sessionId = randomUUID()
  private sessionName: string | undefined
  private messages: AgentMessage[] = []
  private entries: SessionEntry[] = []
  private leafId: string | null = null
  private runsPlayed = 0
  private run: Run | null = null
  private streaming = false
  private openAssistant: AssistantMessage | null = null
  private readonly openTools = new Map<string, string>()
  private steering: string[] = []
  private followUp: string[] = []
  private stderrLog = ''
  /** The listed session file this process resumed (`--session`); cleared when the session changes. */
  private resumedFile: string | undefined
  /** Dialogs opened by `/mock-ui` outside of a scripted run, by request id. */
  private readonly standaloneDialogs = new Map<
    string,
    (response: RpcExtensionUIResponse | null) => void
  >()
  /** Active tools as reported/changed through the bridge's `vengeance-tools`. */
  private activeTools = [...MOCK_DEFAULT_ACTIVE_TOOLS]
  /** pi-subagents stand-in: event-bus RPC, inspect replies, slash commands. */
  private readonly subagents = new MockSubagentRuntime((event) => this.emit(event))
  /** The bridge's response speed (`vengeance-speed`). */
  private readonly speed: MockSpeed

  /** `env` is the engine environment the bridge reads (e.g. the default response speed). */
  constructor(
    private readonly args: CreateAgentArgs,
    env: Record<string, string | undefined> = {}
  ) {
    this.speed = new MockSpeed(env)
    const wanted = args.model?.split(':')[0]
    this.model =
      MOCK_MODELS.find((m) => wanted && (m.id === wanted || `${m.provider}/${m.id}` === wanted)) ??
      MOCK_MODELS[0]!
    if (args.thinking) this.thinkingLevel = args.thinking
    this.sessionName = args.name
    this.resetEntries()
    this.resumedFile = args.sessionPath
    const source = args.sessionPath ?? args.forkFrom
    if (source) this.seedHistory(source)
  }

  get status(): EngineStatus {
    return this._status
  }

  private get sessionFile(): string | undefined {
    if (this.resumedFile) return this.resumedFile
    return this.args.noSession
      ? undefined
      : join(tmpdir(), 'vengeance-mock', `${this.sessionId}.jsonl`)
  }

  on<K extends keyof EngineHandleEvents>(
    event: K,
    listener: (payload: EngineHandleEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, listener)
  }

  stderr(): string {
    return this.stderrLog
  }

  async start(): Promise<void> {
    this.stderrLog += `[mock] engine started in ${this.args.cwd}\n`
    await sleep(220, this.timers)
    this.setStatus('ready')
    this.emit({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'setStatus',
      statusKey: 'pi-lens-lsp',
      statusText: `${ESC}2mLSP Inactive${ESC}22m`
    })
    this.publishSpeed()
  }

  async stop(): Promise<void> {
    if (this._status === 'exited') return
    this.setStatus('stopping')
    if (this.run) this.run.aborted = true
    this.wakeAll()
    this.setStatus('exited')
    this.emitter.emit('exit', { code: 0, signal: null, expected: true })
  }

  respondUi(response: RpcExtensionUIResponse): void {
    const dialog = this.run?.dialog
    if (dialog && dialog.id === response.id) dialog.resolve(response)
    this.standaloneDialogs.get(response.id)?.(response)
  }

  /** Drive a scripted run (mock:play IPC). */
  async play(args: MockPlayArgs): Promise<void> {
    if (args.resume) {
      const run = this.run
      if (run) {
        run.pauseAt = args.pauseAt
        if (args.instant !== undefined) run.instant = args.instant
        run.resume?.()
      }
      return
    }
    if (this.run) throw new Error('A mock run is already active')
    this.startRun(
      args.script ?? 'showcase',
      args.prompt ??
        'Session titles sometimes revert after I rename two sessions quickly. Can you find out why?',
      {
        instant: args.instant ?? false,
        pauseAt: args.pauseAt
      }
    )
  }

  async send(command: RpcCommand): Promise<RpcResponse> {
    if (this._status !== 'ready') {
      return {
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: 'Engine is not running'
      }
    }
    await sleep(8, this.timers)
    try {
      return await this.handle(command)
    } catch (error) {
      return {
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: (error as Error).message
      }
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private ok<T extends RpcCommandType>(
    command: { id?: string; type: T },
    data: RpcResponseDataMap[T]
  ): RpcResponse {
    return {
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data
    } as RpcResponse
  }

  private async handle(command: RpcCommand): Promise<RpcResponse> {
    switch (command.type) {
      case 'prompt': {
        // Extension commands run immediately, even while streaming (like pi).
        const bridge = /^\/(vengeance-[a-z]+) (.*)$/s.exec(command.message)
        if (bridge) {
          this.runBridgeCommand(bridge[1]!, bridge[2]!)
          return this.ok(command, { disposition: 'handled' })
        }
        if (this.subagents.command(command.message))
          return this.ok(command, { disposition: 'handled' })
        if (this.streaming) {
          if (!command.streamingBehavior) {
            throw new Error(
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
            )
          }
          this.enqueue(
            command.streamingBehavior === 'steer' ? 'steering' : 'followUp',
            command.message
          )
          return this.ok(command, { disposition: 'queued' })
        }
        const mockUi = /^\/mock-ui\s+(\S+)/.exec(command.message)?.[1]
        if (mockUi) {
          this.openMockUi(mockUi)
          return this.ok(command, { disposition: 'handled' })
        }
        const extension = /^\/(\S+)/.exec(command.message)?.[1]
        if (
          extension &&
          MOCK_COMMANDS.some((c) => c.name === extension && c.source === 'extension')
        ) {
          this.emit({
            type: 'extension_ui_request',
            id: randomUUID(),
            method: 'notify',
            message: `/${extension} ran (mock engine).`,
            notifyType: 'info'
          })
          return this.ok(command, { disposition: 'handled' })
        }
        this.startRun(this.runsPlayed === 0 ? 'showcase' : 'short', command.message, {
          instant: false
        })
        return this.ok(command, { disposition: 'started' })
      }
      case 'steer':
      case 'follow_up':
        this.enqueue(command.type === 'steer' ? 'steering' : 'followUp', command.message)
        return this.ok(command, { disposition: 'queued' })
      case 'abort':
        await this.abortRun()
        return this.ok(command, undefined)
      case 'clear_queue': {
        const data = { steering: this.steering, followUp: this.followUp }
        this.steering = []
        this.followUp = []
        this.emit({ type: 'queue_update', steering: [], followUp: [] })
        return this.ok(command, data)
      }
      case 'new_session':
        this.resetSession()
        return this.ok(command, { cancelled: false })
      case 'get_state':
        return this.ok(command, this.state())
      case 'set_model': {
        const found = MOCK_MODELS.find(
          (m) => m.provider === command.provider && m.id === command.modelId
        )
        if (!found) throw new Error(`Model not found: ${command.provider}/${command.modelId}`)
        this.model = found
        this.clampThinking()
        this.publishSpeed()
        return this.ok(command, found)
      }
      case 'cycle_model': {
        const index = MOCK_MODELS.indexOf(this.model)
        this.model = MOCK_MODELS[(index + 1) % MOCK_MODELS.length]!
        this.clampThinking()
        this.publishSpeed()
        return this.ok(command, {
          model: this.model,
          thinkingLevel: this.thinkingLevel,
          isScoped: false
        })
      }
      case 'get_available_models':
        return this.ok(command, { models: MOCK_MODELS })
      case 'set_thinking_level':
        this.thinkingLevel = command.level
        this.clampThinking()
        this.emit({ type: 'thinking_level_changed', level: this.thinkingLevel })
        return this.ok(command, undefined)
      case 'cycle_thinking_level': {
        const levels = thinkingLevelsFor(this.model)
        if (levels.length <= 1) return this.ok(command, null)
        this.thinkingLevel = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length]!
        this.emit({ type: 'thinking_level_changed', level: this.thinkingLevel })
        return this.ok(command, { level: this.thinkingLevel })
      }
      case 'get_available_thinking_levels':
        return this.ok(command, { levels: thinkingLevelsFor(this.model) })
      case 'set_steering_mode':
        this.steeringMode = command.mode
        return this.ok(command, undefined)
      case 'set_follow_up_mode':
        this.followUpMode = command.mode
        return this.ok(command, undefined)
      case 'compact': {
        this.emit({ type: 'compaction_start', reason: 'manual' })
        await sleep(1200, this.timers)
        const result = {
          summary:
            '## Goal\nContinue the current task.\n\n## Progress\n- Conversation compacted manually (mock engine).',
          firstKeptEntryId: this.leafId ?? 'root',
          tokensBefore: this.contextTokens(),
          estimatedTokensAfter: 4_200
        }
        this.emit({
          type: 'compaction_end',
          reason: 'manual',
          result,
          aborted: false,
          willRetry: false
        })
        return this.ok(command, result)
      }
      case 'set_auto_compaction':
        this.autoCompaction = command.enabled
        return this.ok(command, undefined)
      case 'set_auto_retry':
      case 'abort_retry':
      case 'abort_bash':
        return this.ok(command, undefined)
      case 'bash':
        return this.ok(
          command,
          await this.runBash(command.command, command.id, command.excludeFromContext)
        )
      case 'get_session_stats':
        return this.ok(command, this.stats())
      case 'export_html':
        return this.ok(command, {
          path: command.outputPath ?? join(tmpdir(), `vengeance-mock-${this.sessionId}.html`)
        })
      case 'switch_session':
        this.resetSession()
        return this.ok(command, { cancelled: false })
      case 'fork': {
        const index = this.entries.findIndex((e) => e.id === command.entryId)
        const entry = this.entries[index]
        if (!entry || entry.type !== 'message' || entry.message.role !== 'user')
          throw new Error(`Entry not found: ${command.entryId}`)
        const forkedText = textOf(entry.message)
        const keep = this.messages.indexOf(entry.message)
        this.messages = keep >= 0 ? this.messages.slice(0, keep) : []
        this.sessionId = randomUUID()
        this.resumedFile = undefined
        this.leafId = entry.parentId
        this.speed.sessionChanged()
        this.publishSpeed()
        return this.ok(command, { text: forkedText, cancelled: false })
      }
      case 'clone':
        this.sessionId = randomUUID()
        this.resumedFile = undefined
        this.speed.sessionChanged()
        this.publishSpeed()
        return this.ok(command, { cancelled: false })
      case 'get_fork_messages':
        return this.ok(command, {
          messages: this.entries.flatMap((e) =>
            e.type === 'message' && e.message.role === 'user' && this.messages.includes(e.message)
              ? [{ entryId: e.id, text: textOf(e.message) }]
              : []
          )
        })
      case 'get_entries': {
        if (command.since === undefined)
          return this.ok(command, { entries: this.entries, leafId: this.leafId })
        const index = this.entries.findIndex((e) => e.id === command.since)
        if (index < 0) throw new Error(`Unknown entry id: ${command.since}`)
        return this.ok(command, { entries: this.entries.slice(index + 1), leafId: this.leafId })
      }
      case 'get_tree':
        return this.ok(command, { nodes: this.tree(), leafId: this.leafId })
      case 'get_last_assistant_text': {
        const last = [...this.messages]
          .reverse()
          .find((m): m is AssistantMessage => m.role === 'assistant' && m.stopReason !== 'error')
        const lastText =
          last?.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('') ?? null
        return this.ok(command, { text: lastText })
      }
      case 'set_session_name':
        this.sessionName = command.name
        this.append({
          type: 'session_info',
          id: hex8(),
          parentId: this.leafId,
          timestamp: new Date().toISOString(),
          name: command.name
        })
        this.emit({ type: 'session_info_changed', name: command.name })
        return this.ok(command, undefined)
      case 'get_messages':
        return this.ok(command, { messages: this.messages })
      case 'get_commands':
        return this.ok(command, {
          commands: [...MOCK_COMMANDS, ...MOCK_SUBAGENT_COMMANDS, ...MOCK_BRIDGE_COMMANDS]
        })
    }
  }

  /**
   * Mock of the Vengeance bridge extension (resources/bridge/vengeance-bridge.ts): same commands, same
   * `setStatus('__vengeance:<reqId>', json)` replies, operating on the mock session tree.
   */
  private runBridgeCommand(name: string, args: string): void {
    const payload = JSON.parse(args) as Record<string, unknown> & { reqId: string }
    let reply: { ok: true; data: BridgeResult } | { ok: false; error: string }
    try {
      reply = { ok: true, data: this.bridgeOperation(name, payload) }
    } catch (error) {
      reply = { ok: false, error: (error as Error).message }
    }
    this.emit({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'setStatus',
      statusKey: `${BRIDGE_STATUS_PREFIX}${payload.reqId}`,
      statusText: JSON.stringify(reply)
    })
  }

  private bridgeOperation(name: string, payload: Record<string, unknown>): BridgeResult {
    switch (name) {
      case 'vengeance-tree':
        return this.navigateTree(
          String(payload.entryId),
          payload.summarize === true,
          typeof payload.label === 'string' ? payload.label : undefined
        )
      case 'vengeance-reload':
        return null
      case 'vengeance-tools':
        if (payload.op === 'set' && Array.isArray(payload.names)) {
          const known = new Set(
            MOCK_TOOLS.filter((t) => t.exposure !== 'hidden').map((t) => t.name)
          )
          this.activeTools = payload.names.filter(
            (n): n is string => typeof n === 'string' && known.has(n)
          )
        }
        return { active: this.activeTools, tools: MOCK_TOOLS }
      case 'vengeance-label': {
        const targetId = String(payload.entryId)
        if (!this.entries.some((e) => e.id === targetId))
          throw new Error(`Entry ${targetId} not found`)
        const label =
          typeof payload.label === 'string' && payload.label.trim()
            ? payload.label.trim()
            : undefined
        this.append({
          type: 'label',
          id: hex8(),
          parentId: this.leafId,
          timestamp: new Date().toISOString(),
          targetId,
          label
        })
        return null
      }
      case 'vengeance-subagents': {
        const params =
          typeof payload.params === 'object' && payload.params !== null
            ? (payload.params as Record<string, unknown>)
            : {}
        return this.subagents.rpc(String(payload.method), params)
      }
      case 'vengeance-speed': {
        const mode = payload.mode
        if (mode !== undefined && !isSpeedMode(mode)) {
          throw new Error('Vengeance bridge: "mode" must be "standard", "fast" or "ultrafast"')
        }
        if (mode) {
          const entry = this.speed.entryFor(mode, this.branchPath())
          if (entry) this.appendSpeedEntry(entry)
          this.speed.chose()
          this.publishSpeed()
        }
        return this.speedState()
      }
      default:
        throw new Error(`Unknown bridge command ${name}`)
    }
  }

  /** pi `navigateTree` semantics: a user message moves the leaf to its parent and returns its text. */
  private navigateTree(
    targetId: string,
    summarize: boolean,
    label: string | undefined
  ): BridgeTreeResult {
    if (this.streaming)
      throw new Error('Wait for the current response to finish before navigating the session tree.')
    const target = this.entries.find((e) => e.id === targetId)
    if (!target) throw new Error(`Entry ${targetId} not found`)
    const oldLeaf = this.leafId
    const isUser = target.type === 'message' && target.message.role === 'user'
    const editorText = isUser && target.message.role === 'user' ? textOf(target.message) : undefined
    const newLeaf = isUser ? target.parentId : targetId
    this.leafId = newLeaf
    const now = new Date().toISOString()
    if (summarize && oldLeaf) {
      this.append({
        type: 'branch_summary',
        id: hex8(),
        parentId: newLeaf,
        timestamp: now,
        fromId: oldLeaf,
        summary:
          '## Abandoned branch\n- Explored the debounced persist path and drafted a dirty-set fix (mock summary).'
      })
    }
    if (label)
      this.append({
        type: 'label',
        id: hex8(),
        parentId: this.leafId,
        timestamp: now,
        targetId: summarize && oldLeaf ? this.leafId! : targetId,
        label
      })
    this.messages = this.branchMessages()
    this.publishSpeed()
    return { cancelled: false, leafId: this.leafId, editorText }
  }

  /** Entries on the path root \u2192 leaf. */
  private branchPath(): SessionEntry[] {
    const byId = new Map(this.entries.map((e) => [e.id, e]))
    const path: SessionEntry[] = []
    for (let id = this.leafId; id;) {
      const entry = byId.get(id)
      if (!entry) break
      path.unshift(entry)
      id = entry.parentId
    }
    return path
  }

  /** Messages on the path root \u2192 leaf (what pi rebuilds the context from). */
  private branchMessages(): AgentMessage[] {
    return this.branchPath().flatMap((entry): AgentMessage[] => {
      if (entry.type === 'message') return [entry.message]
      if (entry.type === 'custom_message')
        return [
          {
            role: 'custom',
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      if (entry.type === 'branch_summary')
        return [
          {
            role: 'branchSummary',
            summary: entry.summary,
            fromId: entry.fromId,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      if (entry.type === 'compaction')
        return [
          {
            role: 'compactionSummary',
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      return []
    })
  }

  /** Hidden `/mock-ui <kind>` command: extension UI outside of a run (see `mockUiRequests`). */
  private openMockUi(kind: string): void {
    const { events, dialog: request } = mockUiRequests(kind)
    for (const event of events) this.emit(event)
    if (!request) return
    const id = request.id
    this.emit(request)
    const settle = (response: RpcExtensionUIResponse | null) => {
      if (!this.standaloneDialogs.delete(id)) return
      const answer =
        !response || 'cancelled' in response
          ? 'cancelled'
          : 'confirmed' in response
            ? response.confirmed
              ? 'confirmed'
              : 'declined'
            : `“${response.value}”`
      this.emit({
        type: 'extension_ui_request',
        id: randomUUID(),
        method: 'notify',
        message: `Extension received: ${answer}`,
        notifyType: 'info'
      })
    }
    this.standaloneDialogs.set(id, settle)
    if (request.method !== 'editor' && request.timeout)
      void sleep(request.timeout, this.timers).then(() => settle(null))
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  private startRun(
    script: MockScriptName,
    prompt: string,
    opts: { instant: boolean; pauseAt?: string }
  ): void {
    if (this.runsPlayed === 0 && script === 'showcase') this.seedAbandonedBranch()
    this.runsPlayed += 1
    const steps = buildScript(script, {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      cwd: this.args.cwd,
      prompt,
      now: Date.now()
    })
    const run: Run = {
      steps,
      index: 0,
      instant: opts.instant,
      pauseAt: opts.pauseAt,
      aborted: false,
      resume: null,
      dialog: null
    }
    this.run = run
    void this.drive(run)
  }

  private async drive(run: Run): Promise<void> {
    while (run.index < run.steps.length && !run.aborted) {
      const step = run.steps[run.index]!
      if (run.pauseAt && step.label === run.pauseAt) {
        await new Promise<void>((resolve) => {
          run.resume = resolve
        })
        run.resume = null
        if (run.aborted) break
        continue
      }
      if (!run.instant && step.delay > 0) await sleep(step.delay, this.timers)
      else if (run.instant && run.index % 50 === 49) await new Promise((r) => setImmediate(r))
      if (run.aborted) break
      run.index += 1
      if (step.kind === 'event') {
        this.emit(step.event)
        if (step.event.type === 'turn_start') this.deliverSteering()
        continue
      }
      this.emit(step.request)
      const response = await new Promise<RpcExtensionUIResponse | null>((resolve) => {
        run.dialog = { id: step.request.id, resolve }
        if (step.request.method !== 'editor' && step.request.timeout) {
          void sleep(step.request.timeout, this.timers).then(() => resolve(null))
        }
      })
      run.dialog = null
      if (run.aborted) break
      const answer = response && 'cancelled' in response ? null : response
      run.steps.splice(run.index, 0, ...step.then(answer))
    }
    if (this.run === run) this.run = null
    if (!run.aborted && this.followUp.length > 0) {
      const next =
        this.followUpMode === 'all' ? this.followUp.splice(0).join('\n\n') : this.followUp.shift()!
      this.emit({
        type: 'queue_update',
        steering: [...this.steering],
        followUp: [...this.followUp]
      })
      this.startRun('short', next, { instant: run.instant })
    }
  }

  private async abortRun(): Promise<void> {
    const run = this.run
    if (!run && !this.streaming) return
    if (run) {
      run.aborted = true
      run.dialog?.resolve(null)
      run.resume?.()
    }
    this.wakeAll()
    await sleep(30, this.timers)
    if (this.openAssistant) {
      this.emit({
        type: 'message_end',
        message: {
          ...this.openAssistant,
          stopReason: 'aborted',
          errorMessage: 'Request was aborted'
        }
      })
    }
    for (const [toolCallId, toolName] of [...this.openTools]) {
      this.emit({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: [{ type: 'text', text: 'Tool execution was aborted' }], details: {} },
        isError: true
      })
    }
    this.emit({ type: 'agent_end', messages: [], willRetry: false })
    this.emit({ type: 'agent_settled', aborted: true })
    this.run = null
  }

  private enqueue(kind: 'steering' | 'followUp', message: string): void {
    if (!this.streaming) {
      this.startRun('short', message, { instant: false })
      return
    }
    this[kind].push(message)
    this.emit({ type: 'queue_update', steering: [...this.steering], followUp: [...this.followUp] })
  }

  private deliverSteering(): void {
    if (this.steering.length === 0) return
    const batch = this.steeringMode === 'all' ? this.steering.splice(0) : [this.steering.shift()!]
    this.emit({ type: 'queue_update', steering: [...this.steering], followUp: [...this.followUp] })
    for (const text of batch) {
      const message: UserMessage = { role: 'user', content: text, timestamp: Date.now() }
      this.emit({ type: 'message_start', message })
      this.emit({ type: 'message_end', message })
    }
  }

  private async runBash(
    command: string,
    id: string | undefined,
    excludeFromContext: boolean | undefined
  ) {
    const chunks = [
      `${ESC}2m$ ${command}${ESC}22m\n`,
      `${ESC}36mOn branch${ESC}39m main\n`,
      `Your branch is up to date with ${ESC}32m'origin/main'${ESC}39m.\n\n`,
      `Changes not staged for commit:\n  ${ESC}31mmodified:   src/session/store.ts${ESC}39m\n`,
      `\nUntracked files:\n  ${ESC}31msrc/session/store.test.ts${ESC}39m\n`
    ]
    for (const delta of chunks) {
      await sleep(90, this.timers)
      this.emit({ type: 'bash_execution_update', id, delta })
    }
    const result = { output: chunks.join(''), exitCode: 0, cancelled: false, truncated: false }
    this.record({
      role: 'bashExecution',
      command,
      ...result,
      excludeFromContext,
      timestamp: Date.now()
    })
    return result
  }

  // ─── Session model ─────────────────────────────────────────────────────────

  /** Track what the client would see so state queries stay consistent with the event stream. */
  private observe(event: EngineEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.streaming = true
        break
      case 'agent_settled':
        this.streaming = false
        break
      case 'message_start':
        if (event.message.role === 'assistant') this.openAssistant = structuredClone(event.message)
        break
      case 'message_update': {
        const open = this.openAssistant
        const update = event.assistantMessageEvent
        if (!open || !('contentIndex' in update)) break
        const i = update.contentIndex
        if (update.type === 'text_start') open.content[i] = { type: 'text', text: '' }
        else if (update.type === 'text_delta') {
          const block = open.content[i]
          if (block?.type === 'text') block.text += update.delta
        } else if (update.type === 'thinking_start')
          open.content[i] = { type: 'thinking', thinking: '' }
        else if (update.type === 'thinking_delta') {
          const block = open.content[i]
          if (block?.type === 'thinking') block.thinking += update.delta
        } else if (update.type === 'toolcall_end') open.content[i] = update.toolCall
        break
      }
      case 'message_end':
        if (event.message.role === 'assistant') this.openAssistant = null
        this.record(event.message)
        break
      case 'tool_execution_start':
        this.openTools.set(event.toolCallId, event.toolName)
        break
      case 'tool_execution_end':
        this.openTools.delete(event.toolCallId)
        break
      case 'compaction_end':
        if (event.result) {
          this.append({
            type: 'compaction',
            id: hex8(),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            summary: event.result.summary,
            firstKeptEntryId: event.result.firstKeptEntryId,
            tokensBefore: event.result.tokensBefore
          })
          this.messages.push({
            role: 'compactionSummary',
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            timestamp: Date.now()
          })
        }
        break
      default:
        break
    }
  }

  private record(message: AgentMessage): void {
    this.messages.push(message)
    const base = { id: hex8(), parentId: this.leafId, timestamp: new Date().toISOString() }
    // Like pi's SessionManager: extension messages are `custom_message` entries.
    if (message.role === 'custom') {
      const { customType, content, details, display } = message
      this.append({ type: 'custom_message', ...base, customType, content, details, display })
    } else this.append({ type: 'message', ...base, message })
  }

  private append(entry: SessionEntry): void {
    this.entries.push(entry)
    this.leafId = entry.id
  }

  private resetEntries(): void {
    this.entries = []
    this.leafId = null
    const now = new Date().toISOString()
    this.append({
      type: 'model_change',
      id: hex8(),
      parentId: null,
      timestamp: now,
      provider: this.model.provider,
      modelId: this.model.id
    })
    this.append({
      type: 'thinking_level_change',
      id: hex8(),
      parentId: this.leafId,
      timestamp: now,
      thinkingLevel: this.thinkingLevel
    })
  }

  private resetSession(): void {
    this.messages = []
    this.sessionId = randomUUID()
    this.resumedFile = undefined
    this.sessionName = undefined
    this.runsPlayed = 0
    this.resetEntries()
    this.speed.sessionChanged()
    this.publishSpeed()
  }

  /** A resumed/forked listed mock session starts with its persisted history (one exchange, or a long session). */
  private seedHistory(sessionPath: string): void {
    const history = mockSessionHistory(sessionPath)
    if (!history) return
    if (history.name && !this.args.forkFrom) this.sessionName = history.name
    // Later prompts in a resumed session play the short script.
    this.runsPlayed = 1
    if (history.turns) {
      this.seedLongHistory(mockLongSessionEntries(history, history.turns, this.leafId))
      return
    }
    const user: UserMessage = {
      role: 'user',
      content: history.firstMessage,
      timestamp: history.at - 90_000
    }
    const reply: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: history.reply }],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: {
        input: 12_400,
        output: 380,
        cacheRead: 9_600,
        cacheWrite: 0,
        totalTokens: 22_380,
        cost: { input: 0.0372, output: 0.0057, cacheRead: 0.00288, cacheWrite: 0, total: 0.04578 }
      },
      stopReason: 'stop',
      timestamp: history.at
    }
    this.record(user)
    this.record(reply)
  }

  private seedLongHistory({
    entries,
    leafId
  }: {
    entries: SessionEntry[]
    leafId: string | null
  }): void {
    this.entries.push(...entries)
    this.leafId = leafId
    this.messages = this.branchMessages()
  }

  /** An earlier, abandoned branch so get_tree has real structure. */
  private seedAbandonedBranch(): void {
    const root = this.leafId
    const at = Date.now() - 6 * 60_000
    const user: UserMessage = {
      role: 'user',
      content: 'How is the session store persisted?',
      timestamp: at
    }
    const userEntry: SessionEntry = {
      type: 'message',
      id: hex8(),
      parentId: root,
      timestamp: new Date(at).toISOString(),
      message: user
    }
    const reply: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Sessions are written by `SessionStore.persist`, a 250 ms debounced call to `writeSessionFile`.'
        }
      ],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: {
        input: 8_200,
        output: 64,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8_264,
        cost: { input: 0.0246, output: 0.00096, cacheRead: 0, cacheWrite: 0, total: 0.02556 }
      },
      stopReason: 'stop',
      timestamp: at + 4_000
    }
    this.entries.push(userEntry, {
      type: 'message',
      id: hex8(),
      parentId: userEntry.id,
      timestamp: new Date(at + 4_000).toISOString(),
      message: reply
    })
    // The active branch continues from the root, not from the abandoned reply.
    this.leafId = root
  }

  private tree(): FlatTreeNode[] {
    const labels = new Map<string, { label: string; at: string }>()
    for (const entry of this.entries) {
      if (entry.type !== 'label') continue
      if (entry.label) labels.set(entry.targetId, { label: entry.label, at: entry.timestamp })
      else labels.delete(entry.targetId)
    }
    const nodes = new Map<string, SessionTreeNode>()
    for (const entry of this.entries) {
      const label = labels.get(entry.id)
      nodes.set(
        entry.id,
        label
          ? { entry, children: [], label: label.label, labelTimestamp: label.at }
          : { entry, children: [] }
      )
    }
    const roots: SessionTreeNode[] = []
    for (const entry of this.entries) {
      const node = nodes.get(entry.id)!
      const parent = entry.parentId ? nodes.get(entry.parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    return flattenSessionTree(roots)
  }

  private state(): RpcSessionState {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.streaming,
      isCompacting: false,
      steeringMode: this.steeringMode,
      followUpMode: this.followUpMode,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      autoCompactionEnabled: this.autoCompaction,
      messageCount: this.messages.length,
      pendingMessageCount: this.steering.length + this.followUp.length
    }
  }

  private contextTokens(): number {
    const last = [...this.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === 'assistant')
    return last
      ? last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite
      : 0
  }

  private stats(): SessionStats {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    let cost = 0
    let toolCalls = 0
    for (const m of this.messages) {
      if (m.role !== 'assistant') continue
      tokens.input += m.usage.input
      tokens.output += m.usage.output
      tokens.cacheRead += m.usage.cacheRead
      tokens.cacheWrite += m.usage.cacheWrite
      cost += m.usage.cost.total
      toolCalls += m.content.filter((c) => c.type === 'toolCall').length
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    const contextTokens = this.contextTokens()
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages: this.messages.filter((m) => m.role === 'user').length,
      assistantMessages: this.messages.filter((m) => m.role === 'assistant').length,
      toolCalls,
      toolResults: this.messages.filter((m) => m.role === 'toolResult').length,
      totalMessages: this.messages.length,
      tokens,
      cost,
      contextUsage: {
        tokens: contextTokens,
        contextWindow: this.model.contextWindow,
        percent: Math.round((contextTokens / this.model.contextWindow) * 1000) / 10
      }
    }
  }

  private clampThinking(): void {
    const levels = thinkingLevelsFor(this.model)
    if (!levels.includes(this.thinkingLevel))
      this.thinkingLevel = levels[levels.length - 1] ?? 'off'
  }

  private emit(event: EngineEvent): void {
    const out = this.subagents.rewrite(event)
    this.observe(out)
    this.emitter.emit('event', out)
    if (
      out.type === 'message_end' &&
      out.message.role === 'assistant' &&
      out.message.stopReason !== 'error' &&
      out.message.stopReason !== 'aborted'
    ) {
      const refused = this.speed.responded(this.model, this.branchPath())
      if (refused) this.appendSpeedEntry(refused)
      this.publishSpeed()
    }
  }

  private appendSpeedEntry(entry: { customType: string; data: { mode: SpeedMode } }): void {
    this.append({
      type: 'custom',
      id: hex8(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      ...entry
    })
  }

  private speedState(): SpeedState {
    return this.speed.state(this.model, this.branchPath())
  }

  /** Like the bridge: the session's speed on its hidden status key, whenever it may have changed. */
  protected publishSpeed(): void {
    this.emit({
      type: 'extension_ui_request',
      id: randomUUID(),
      method: 'setStatus',
      statusKey: SPEED_STATUS_KEY,
      statusText: JSON.stringify(this.speedState())
    })
  }

  private wakeAll(): void {
    for (const wake of [...this.timers]) wake()
  }

  private setStatus(status: EngineStatus): void {
    this._status = status
    this.emitter.emit('status', status)
  }
}
