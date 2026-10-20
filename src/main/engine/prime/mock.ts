import { randomUUID } from 'node:crypto'
import type { BridgeRequest, BridgeResult } from '@shared/api/engine'
import type { AgentMessage, RpcCommand, RpcResponse } from '@shared/engine-types'
import { bridgeTimeout, callBridge } from '../bridge'
import { mockAssembledPrompt } from '../conversation-prompt'
import { Emitter, type EngineHandleEvents } from '../handle'
import { MockEngineProcess } from '../mock'
import { MOCK_MODELS, MOCK_TOOLS } from '../mock-data'
import { primeMcp } from './bridge'
import { PrimeMcpTimeouts } from './mcp-live'
import { FACTORY_SPEC_ID, factorySnapshot } from './mock-data'
import { primeSpeed } from './speed'
import { speedOffer, speedRoute } from '../../../../resources/bridge/speed-mode-core'

type NativeRecord = Record<string, unknown>
type ScheduleStatus = 'active' | 'paused' | 'cancelled'

const DEFAULT_RLM_MAX_DEPTH = 3
const AUTONOMOUS_LIMITS = {
  maxContinuations: 3,
  maxTurns: 12,
  maxTokens: 80_000,
  timeoutMs: 30 * 60 * 1_000
}
const AUTONOMOUS_GATES = { commands: [] as string[], maxRetries: 3, timeoutMs: 5 * 60 * 1_000 }
const AUTONOMOUS_KEEP_ALIVE_MS = 25 * 60 * 1_000
function commandArguments(text: string): string[] {
  const result: string[] = []
  let token = ''
  let quote = ''
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = ''
      else token += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) {
      if (token) result.push(token)
      token = ''
    } else token += character
  }
  if (token) result.push(token)
  return result
}

interface ScheduledJob {
  id: string
  activeSessionId: string
  source: 'heartbeat' | 'cron'
  status: ScheduleStatus
  runtimeKind: 'top-level'
  prompt: string
  schedule: { kind: 'once' | 'interval' | 'cron'; expression: string }
  deliveryMode?: 'steer' | 'follow_up'
  runCount: number
}

function record(value: unknown): NativeRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as NativeRecord) : {}
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function scheduleKind(expression: string): ScheduledJob['schedule']['kind'] {
  if (expression.startsWith('in ') || expression.startsWith('at ')) return 'once'
  return expression.startsWith('every ') ? 'interval' : 'cron'
}

/** In-memory Engine 2 fixture for native controls and the common session protocol. */
export class PrimeMockEngineProcess extends MockEngineProcess {
  readonly nativeAgentId = `mock-prime-${randomUUID()}`
  private readonly nativeEmitter = new Emitter<EngineHandleEvents>()
  private readonly nativeMessages: AgentMessage[] = []
  /** The session's requested service tier; the active tier is this clamped to the model. */
  private serviceTier = 'default'
  private scopedModels: unknown[] = []
  private maxDepth = DEFAULT_RLM_MAX_DEPTH
  private goal: NativeRecord = {
    active: false,
    status: 'idle',
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationsUsed: 0
  }
  private autonomous: NativeRecord = {
    enabled: false,
    continuationsUsed: 0,
    turnsUsed: 0,
    tokensUsed: 0,
    limits: { ...AUTONOMOUS_LIMITS },
    gates: structuredClone(AUTONOMOUS_GATES),
    gateAttempts: {},
    subagentKeepAliveMs: AUTONOMOUS_KEEP_ALIVE_MS
  }
  private readonly children = new Map<string, NativeRecord>([
    [
      'mock-reviewer',
      {
        id: 'mock-reviewer',
        activeSessionId: 'mock-child-reviewer',
        label: 'Review implementation',
        sessionName: 'Implementation review',
        status: 'running',
        model: `${MOCK_MODELS[0]!.provider}/${MOCK_MODELS[0]!.id}`,
        answerPreview: 'Checking the settings migration and error paths.',
        toolUseCount: 6
      }
    ],
    [
      'mock-verifier',
      {
        id: 'mock-verifier',
        activeSessionId: 'mock-child-verifier',
        label: 'Verify release checks',
        sessionName: 'Release verification',
        status: 'completed',
        model: `${MOCK_MODELS[0]!.provider}/${MOCK_MODELS[0]!.id}`,
        answerPreview: 'Type checks and targeted tests pass. The release checklist is ready.',
        toolUseCount: 9,
        durationMs: 42_000
      }
    ]
  ])
  private readonly factoryRuns = new Map<string, NativeRecord>([
    ['mock-factory-release', factorySnapshot('mock-factory-release', 'paused')]
  ])
  private heartbeat: ScheduledJob | null = null
  private readonly schedules = new Map<string, ScheduledJob>()
  private readonly mcpTimeouts = new PrimeMcpTimeouts()
  private nextJobId = 1
  private lastRefinement: NativeRecord | null = null

  override on<K extends keyof EngineHandleEvents>(
    event: K,
    listener: (payload: EngineHandleEvents[K]) => void
  ): () => void {
    const common = super.on(event, listener)
    const native = this.nativeEmitter.on(event, listener)
    return () => {
      common()
      native()
    }
  }

  override async send(command: RpcCommand): Promise<RpcResponse> {
    if (command.type === 'prompt') {
      const goal = /^\/goal(?:\s+(.*))?$/s.exec(command.message)
      if (goal) {
        return this.nativePrompt(command, () => this.updateGoal(goal[1]?.trim() ?? ''))
      }
      const autonomous = /^\/autonomous(?:\s+(.*))?$/s.exec(command.message)
      if (autonomous) {
        return this.nativePrompt(command, () => this.updateAutonomous(autonomous[1] ?? ''))
      }
      const refine = /^\/refine(?:\s+(.*))?$/s.exec(command.message)
      if (refine) {
        await this.refine({ instructions: refine[1]?.trim() })
        return this.handled(command)
      }
    }
    if (command.type === 'get_messages') {
      return {
        id: command.id,
        type: 'response',
        command: 'get_messages',
        success: true,
        data: await this.allMessages()
      }
    }
    return super.send(command)
  }

  async nativeCommand(type: string, payload: NativeRecord = {}): Promise<NativeRecord> {
    switch (type) {
      case 'prompt_and_wait': {
        const response = await this.send({
          type: 'prompt',
          message: requiredText(payload.message, 'message')
        })
        if (!response.success) throw new Error(response.error)
        return record(response.data)
      }
      case 'get_state':
      case 'get_connection_state':
        return this.nativeState()
      case 'get_messages':
        return this.allMessages()
      case 'get_session_tree': {
        const tree = await this.rpcData({ type: 'get_tree' })
        const nodes = Array.isArray(tree.nodes) ? tree.nodes.map(record) : []
        return { flatNodes: nodes, leafId: tree.leafId }
      }
      case 'get_commands': {
        const data = await this.rpcData({ type: 'get_commands' })
        const commands = Array.isArray(data.commands) ? data.commands.map(record) : []
        return { commands: commands.filter((command) => command.source !== 'extension') }
      }
      case 'get_available_models':
        return { models: MOCK_MODELS }
      case 'get_model_catalog':
        return {
          models: MOCK_MODELS,
          configuredProviders: [...new Set(MOCK_MODELS.map((model) => model.provider))]
        }
      case 'get_queue':
        return { steering: [], followUp: [] }
      case 'get_session_context': {
        const state = await this.nativeState()
        const messages = await this.rpcData({ type: 'get_messages' })
        const model = record(state.model)
        return {
          context: {
            messages: messages.messages,
            thinkingLevel: state.thinkingLevel,
            serviceTier: this.serviceTier,
            model: { provider: model.provider, modelId: model.id }
          }
        }
      }
      case 'get_context_tree': {
        const state = await this.nativeState()
        const model = record(state.model)
        return {
          id: 'root',
          label: 'Release preparation',
          status: 'active',
          ownUsage: { input: 8_420, output: 1_130, totalTokens: 9_550 },
          totalUsage: { input: 19_460, output: 3_510, cacheRead: 8_192, totalTokens: 31_162 },
          children: [...this.children.values()].map((child) => ({
            id: child.id,
            label: child.label,
            status: child.status,
            model: { provider: model.provider, id: model.id },
            ownUsage: { input: 5_520, output: 1_190, totalTokens: 6_710 },
            totalUsage: { input: 5_520, output: 1_190, totalTokens: 6_710 },
            contextUsage: { tokens: 6_710, contextWindow: 200_000 },
            children: []
          })),
          model: { provider: model.provider, id: model.id },
          contextUsage: state.contextUsage
        }
      }
      case 'get_system_prompt':
        return {
          systemPrompt: mockAssembledPrompt(
            [
              '# Workspace assistant',
              'Work toward the session goal, verify changes, and report concrete results.',
              'Delegate independent reviews to subagents and keep their context focused.'
            ].join('\n\n'),
            'Use the persistent Python kernel for tools, background work, and factory runs.',
            this.args.conversationPrompt
          )
        }
      case 'get_rlm_children':
        return { children: [...this.children.values()], eventSequence: 1 }
      case 'get_rlm_max_depth_status':
        return { maxDepth: this.maxDepth, source: 'session' }
      case 'set_rlm_max_depth':
        return this.setMaxDepth(payload)
      case 'get_mcp_connections':
        return this.mcp.primeConnections()
      case 'get_mcp_status':
        return this.mcp.primeStatus()
      case 'reconnect_mcp_server': {
        const server = requiredText(payload.server, 'server')
        this.mcp.act(server, 'reconnect', { settled: true })
        const status = this.mcp.primeStatus()
        const servers = Array.isArray(status.servers) ? status.servers : []
        return { ...status, servers: servers.filter((entry) => record(entry).server === server) }
      }
      case 'remove_mcp_connection': {
        const server = requiredText(payload.server, 'server')
        this.mcp.act(server, 'logout')
        return { server, removed: true }
      }
      case 'get_resource_snapshot':
        return {
          contextFiles: [],
          skills: [],
          prompts: [],
          themes: [],
          diagnostics: { skills: [], prompts: [], themes: [] }
        }
      case 'get_tool_definition': {
        const name = requiredText(payload.name, 'name')
        const tool = MOCK_TOOLS.find((candidate) => candidate.name === name)
        if (!tool) throw new Error(`Tool not found: ${name}`)
        return { name: tool.name, description: tool.description }
      }
      case 'set_service_tier': {
        this.serviceTier = requiredText(payload.serviceTier, 'serviceTier')
        const serviceTier = await this.activeServiceTier()
        this.publishNative('service_tier_changed', { serviceTier })
        return { serviceTier }
      }
      case 'set_scoped_models':
        if (!Array.isArray(payload.scopedModels)) {
          throw new Error('set_scoped_models requires a scopedModels array')
        }
        this.scopedModels = structuredClone(payload.scopedModels)
        return { scopedModels: this.scopedModels }
      case 'heartbeat_get':
        return { heartbeat: this.activeHeartbeat() }
      case 'heartbeats_list':
        return {
          heartbeats: this.activeHeartbeat()
            ? [{ job: this.heartbeat, sessionName: 'Release preparation' }]
            : []
        }
      case 'heartbeat_set':
        return this.setHeartbeat(payload)
      case 'heartbeat_update':
        return this.manageHeartbeat(this.heartbeat, payload.action)
      case 'heartbeat_manage':
        if (payload.activeSessionId !== this.nativeAgentId)
          throw new Error('Heartbeat owner mismatch')
        if (payload.action === 'clear') throw new Error('heartbeat_manage does not support clear')
        return this.manageHeartbeat(this.findHeartbeat(payload.jobId), payload.action)
      case 'cron_list':
        return {
          jobs: [...this.schedules.values()].filter(
            (scheduledJob) =>
              payload.includeInactive === true || scheduledJob.status !== 'cancelled'
          )
        }
      case 'cron_add':
        return this.addCron(payload)
      case 'cron_cancel':
        return this.cancelCron(payload)
      case 'refine':
        return this.refine(payload)
      case 'get_refinement_history':
        return { refinements: this.lastRefinement ? [this.lastRefinement] : [] }
      case 'start_side_question': {
        const sideQuestionId = requiredText(payload.sideQuestionId, 'sideQuestionId')
        const question = requiredText(payload.question, 'question')
        this.publishNative('side_question_event', {
          event: {
            id: sideQuestionId,
            question,
            status: 'complete',
            answer: 'The session keeps its main task. This answer uses a separate conversation.'
          }
        })
        return { sideQuestionId, status: 'started', question }
      }
      case 'abort_side_question':
        return {
          sideQuestionId: requiredText(payload.sideQuestionId, 'sideQuestionId'),
          aborted: true
        }
      case 'cancel_rlm_child':
      case 'delete_rlm_subagent':
        return this.changeChild(type, payload)
      case 'send_message': {
        const target = requiredText(payload.targetActiveSessionId, 'targetActiveSessionId')
        const child = [...this.children.values()].find((entry) => entry.activeSessionId === target)
        if (!child) throw new Error(`No Engine 2 session found: ${target}`)
        child.answerPreview = `Received: ${requiredText(payload.message, 'message')}`
        this.publishNative('rlm_child_update', { child })
        return { delivered: true, targetActiveSessionId: target }
      }
      case 'factory_activity':
        return this.factoryActivity(payload)
      case 'kill':
        await this.stop()
        return { killed: true }
      default:
        throw new Error(`Unsupported Engine 2 mock command: ${type}`)
    }
  }

  async bridge(request: BridgeRequest): Promise<BridgeResult> {
    if (request.op === 'speed') {
      return primeSpeed((type, payload) => this.nativeCommand(type, payload), request.mode)
    }
    if (request.op === 'mcp') {
      return primeMcp(
        request,
        (type, payload) => this.nativeCommand(type, payload),
        this.mcpTimeouts
      )
    }
    // Engine 2 assembles its whole prompt when the resident starts, so its view is never partial.
    if (request.op === 'system-prompt') {
      return { text: String((await this.nativeCommand('get_system_prompt')).systemPrompt) }
    }
    return callBridge(this, request, bridgeTimeout(request))
  }

  /** Engine 2 has no bridge status; its native `service_tier_changed` event reports the tier. */
  protected override publishSpeed(): void {}

  /** Engine 2 has no bridge status; the app asks for its MCP status. */
  protected override publishMcp(): void {}

  /** Like Engine 2: the requested tier clamped to the current model. */
  private async activeServiceTier(): Promise<string> {
    if (this.serviceTier === 'default' || this.serviceTier === 'auto') return this.serviceTier
    const { tiers } = await this.speedCapabilities()
    if (tiers.some((option) => option.tier === this.serviceTier)) return this.serviceTier
    return tiers.some((option) => option.tier === 'priority') ? 'priority' : 'default'
  }

  private async speedCapabilities() {
    const model = record((await this.rpcData({ type: 'get_state' })).model)
    const reference = {
      provider: String(model.provider),
      api: String(model.api),
      id: String(model.id)
    }
    const options =
      reference.provider === 'openrouter'
        ? [{ mode: 'fast' }]
        : reference.provider === 'anthropic'
          ? []
          : speedOffer(speedRoute(reference, false), reference.id).options
    return {
      model: reference,
      tiers: options.map((option) => ({ tier: option.mode === 'fast' ? 'priority' : 'ultrafast' }))
    }
  }

  private nativePrompt(
    command: Extract<RpcCommand, { type: 'prompt' }>,
    operation: () => void
  ): RpcResponse {
    try {
      operation()
      return this.handled(command)
    } catch (error) {
      return {
        id: command.id,
        type: 'response',
        command: 'prompt',
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async allMessages(): Promise<{ messages: AgentMessage[] }> {
    const data = await this.rpcData({ type: 'get_messages' })
    const messages = Array.isArray(data.messages) ? (data.messages as AgentMessage[]) : []
    return { messages: [...messages, ...this.nativeMessages] }
  }

  private publishNative(name: string, data: NativeRecord): void {
    this.nativeEmitter.emit('event', { type: 'engine_native_event', engine: 'prime', name, data })
  }

  private publishCustom(customType: string, content: string, details: NativeRecord): void {
    const message: AgentMessage = {
      role: 'custom',
      customType,
      content,
      display: true,
      details: structuredClone(details),
      timestamp: Date.now()
    }
    this.nativeMessages.push(message)
    this.nativeEmitter.emit('event', { type: 'message_start', message })
    this.nativeEmitter.emit('event', { type: 'message_end', message })
  }

  private updateGoal(argumentsText: string): void {
    const operation = argumentsText.toLowerCase()
    if (operation === 'clear' || operation === 'stop') {
      this.goal = {
        active: false,
        status: 'idle',
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0
      }
    } else if (operation === 'pause' || operation === 'resume') {
      if (!this.goal.objective) throw new Error('There is no goal to update.')
      this.goal = {
        ...this.goal,
        active: operation === 'resume',
        status: operation === 'resume' ? 'active' : 'paused',
        updatedAt: Date.now()
      }
    } else if (argumentsText && operation !== 'status') {
      if (this.goal.status === 'active' || this.goal.status === 'paused') {
        throw new Error('Clear or complete the current goal before starting another.')
      }
      const budgeted = /^(?:--budget|--token-budget)(?:=|\s+)([1-9]\d*)\s+([\s\S]+)$/.exec(
        argumentsText
      )
      if (argumentsText.startsWith('--') && !budgeted)
        throw new Error('Enter a positive goal budget and objective.')
      this.goal = {
        active: true,
        status: 'active',
        goalId: randomUUID(),
        objective: budgeted?.[2] ?? argumentsText,
        ...(budgeted ? { tokenBudget: Number(budgeted[1]) } : {}),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    }
    this.publishNative('goal_update', { goal: this.goal })
  }

  private updateAutonomous(argumentsText: string): void {
    const tokens = commandArguments(argumentsText)
    const operation = tokens.shift()?.toLowerCase() ?? 'status'
    if (['off', 'disable', 'disabled'].includes(operation)) {
      if (tokens.length > 0) throw new Error('Unexpected autonomous argument.')
      this.autonomous.enabled = false
    } else if (['on', 'enable', 'enabled'].includes(operation)) {
      const budgetFields: Record<string, keyof typeof AUTONOMOUS_LIMITS> = {
        'max-continuations': 'maxContinuations',
        'max-turns': 'maxTurns',
        'max-tokens': 'maxTokens',
        'timeout-ms': 'timeoutMs'
      }
      const limits = { ...AUTONOMOUS_LIMITS }
      const gates = structuredClone(AUTONOMOUS_GATES)
      let keepAlive = AUTONOMOUS_KEEP_ALIVE_MS
      let customBudget = false
      for (let index = 0; index < tokens.length; index += 1) {
        const option = tokens[index]!
        const separator = option.indexOf('=')
        const flag = (separator < 0 ? option : option.slice(0, separator)).replace(
          /^--(?:autonomous-)?/,
          ''
        )
        const value = separator < 0 ? tokens[++index] : option.slice(separator + 1)
        if (!value) throw new Error(`Missing value for ${option}`)
        if (flag === 'gate') {
          gates.commands.push(value)
          continue
        }
        const numeric =
          value === 'unlimited' && budgetFields[flag] ? Number.MAX_SAFE_INTEGER : Number(value)
        if (
          !Number.isSafeInteger(numeric) ||
          numeric < (flag === 'subagent-keep-alive-ms' ? 0 : 1)
        ) {
          throw new Error(`Invalid value for ${option}`)
        }
        const budgetField = budgetFields[flag]
        if (budgetField) {
          if (!customBudget) {
            for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
              limits[key] = Number.MAX_SAFE_INTEGER
            }
          }
          customBudget = true
          limits[budgetField] = numeric
        } else if (flag === 'gate-retries') gates.maxRetries = numeric
        else if (flag === 'gate-timeout-ms') gates.timeoutMs = numeric
        else if (flag === 'subagent-keep-alive-ms') keepAlive = numeric
        else throw new Error(`Unknown autonomous option: ${option}`)
      }
      this.autonomous = {
        enabled: true,
        continuationsUsed: 0,
        turnsUsed: 0,
        tokensUsed: 0,
        startedAt: Date.now(),
        limits,
        gates,
        gateAttempts: {},
        subagentKeepAliveMs: keepAlive
      }
    } else if (operation !== 'status') throw new Error('Use /autonomous on, off, or status.')
    if (operation === 'status' && tokens.length > 0)
      throw new Error('Unexpected autonomous argument.')
    this.publishCustom(
      'autonomous_status',
      `[autonomous-status: ${this.autonomous.enabled ? 'enabled' : 'disabled'}]`,
      this.autonomous
    )
  }

  private changeChild(operation: string, payload: NativeRecord): NativeRecord {
    const childId = requiredText(payload.childId, 'childId')
    const child = this.children.get(childId)
    if (!child)
      return operation === 'cancel_rlm_child'
        ? { childId, cancelled: false }
        : { childId, deleted: false, reason: 'not_found' }
    if (operation === 'cancel_rlm_child') {
      const cancelled = child.status === 'running'
      if (cancelled) child.status = 'cancelled'
      this.publishNative('rlm_child_update', { child })
      return { childId, cancelled }
    }
    if (child.status === 'running') return { childId, deleted: false, reason: 'running' }
    this.children.delete(childId)
    this.publishNative('rlm_child_update', { child })
    return { childId, deleted: true }
  }

  private factoryActivity(payload: NativeRecord): NativeRecord {
    const action = requiredText(payload.action, 'action')
    if (action === 'graph' && !payload.runId) {
      if (!payload.specId) return { runs: [...this.factoryRuns.values()] }
      if (payload.specId !== FACTORY_SPEC_ID) throw new Error('Unknown factory specification.')
      return factorySnapshot(null)
    }
    if (action === 'run') {
      if (payload.specId !== FACTORY_SPEC_ID) throw new Error('Unknown factory specification.')
      const runId = `mock-factory-${randomUUID()}`
      const snapshot = factorySnapshot(runId)
      this.factoryRuns.set(runId, snapshot)
      return {
        runId,
        specId: FACTORY_SPEC_ID,
        name: snapshot.name,
        nodes: 3,
        maxParallel: 2,
        started: ['inspect'],
        pending: ['verify', 'package']
      }
    }
    const runId = requiredText(payload.runId, 'runId')
    const snapshot = this.factoryRuns.get(runId)
    if (!snapshot) throw new Error(`Unknown factory run: ${runId}`)
    if (action === 'stop') {
      snapshot.state = 'stopped'
      snapshot.activeNodes = []
      snapshot.pauseReason = null
      snapshot.usage = { ...record(snapshot.usage), running: 0 }
      snapshot.nodes = (snapshot.nodes as NativeRecord[]).map((node) => ({
        ...node,
        status: ['done', 'error'].includes(String(node.status)) ? node.status : 'cancelled',
        running: 0,
        queued: 0
      }))
      return { runId, state: 'stopped', cancelled: ['verify', 'package'] }
    } else if (action === 'resume') {
      if (snapshot.state !== 'paused') throw new Error('Only paused factory runs can resume.')
      const resumed = factorySnapshot(runId)
      this.factoryRuns.set(runId, resumed)
      return { runId, state: 'running', started: ['verify'], pending: ['package'] }
    } else if (!['graph', 'status', 'watch'].includes(action)) {
      throw new Error(`Unsupported factory action: ${action}`)
    }
    if (action === 'status') {
      return structuredClone({
        runId,
        specId: snapshot.specId,
        name: snapshot.name,
        state: snapshot.state,
        nodes: snapshot.nodes,
        events: snapshot.events,
        elapsedMs: snapshot.elapsedMs,
        usage: snapshot.usage,
        ...(snapshot.state === 'paused' ? { pauseReason: snapshot.pauseReason } : {})
      })
    }
    return structuredClone(snapshot)
  }

  private handled(command: Extract<RpcCommand, { type: 'prompt' }>): RpcResponse {
    return {
      id: command.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'handled' }
    }
  }

  private async rpcData(command: RpcCommand): Promise<NativeRecord> {
    const response = await super.send(command)
    if (!response.success) throw new Error(response.error)
    return record(response.data)
  }

  private async nativeState(): Promise<NativeRecord> {
    const state = await this.rpcData({ type: 'get_state' })
    const stats = await this.rpcData({ type: 'get_session_stats' })
    return {
      ...state,
      serviceTier: await this.activeServiceTier(),
      serviceTierOptions: await this.speedCapabilities(),
      availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      goal: this.goal,
      scopedModels: this.scopedModels,
      activeToolNames: MOCK_TOOLS.filter((tool) => tool.exposure === 'direct').map(
        (tool) => tool.name
      ),
      contextUsage: stats.contextUsage,
      sessionActions: { queuedCount: state.pendingMessageCount ?? 0, steering: [], followUps: [] }
    }
  }

  private setMaxDepth(payload: NativeRecord): NativeRecord {
    const depth = payload.maxDepth
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) {
      throw new Error('maxDepth must be a nonnegative integer')
    }
    this.maxDepth = depth
    return {
      maxDepth: depth,
      source: payload.global === true ? 'global' : 'session',
      globalSaved: payload.global === true
    }
  }

  private createJob(source: ScheduledJob['source'], payload: NativeRecord): ScheduledJob {
    const expression = requiredText(payload.schedule, 'schedule')
    const prompt = requiredText(payload.prompt, 'prompt')
    return {
      id: `mock-${source}-${this.nextJobId++}`,
      activeSessionId: this.nativeAgentId,
      source,
      status: 'active',
      runtimeKind: 'top-level',
      prompt,
      schedule: { kind: scheduleKind(expression), expression },
      deliveryMode:
        source === 'heartbeat' && payload.deliveryMode === 'steer' ? 'steer' : 'follow_up',
      runCount: 0
    }
  }

  private activeHeartbeat(): ScheduledJob | null {
    return this.heartbeat?.status === 'cancelled' ? null : this.heartbeat
  }

  private setHeartbeat(payload: NativeRecord): NativeRecord {
    this.heartbeat = this.createJob('heartbeat', payload)
    this.publishNative('heartbeats_changed', {})
    return { heartbeat: this.heartbeat }
  }

  private findHeartbeat(jobId: unknown): ScheduledJob | null {
    return this.heartbeat?.id === jobId ? this.heartbeat : null
  }

  private manageHeartbeat(scheduledJob: ScheduledJob | null, action: unknown): NativeRecord {
    if (!scheduledJob) throw new Error('No active heartbeat found')
    if (action === 'pause') scheduledJob.status = 'paused'
    else if (action === 'resume') scheduledJob.status = 'active'
    else if (action === 'stop' || action === 'clear') scheduledJob.status = 'cancelled'
    else throw new Error(`Unsupported heartbeat action: ${String(action)}`)
    if (action === 'clear') this.heartbeat = null
    this.publishNative('heartbeats_changed', {})
    return { heartbeat: action === 'clear' ? null : scheduledJob }
  }

  private addCron(payload: NativeRecord): NativeRecord {
    const scheduledJob = this.createJob('cron', payload)
    this.schedules.set(scheduledJob.id, scheduledJob)
    this.publishNative('heartbeats_changed', {})
    return { job: scheduledJob }
  }

  private cancelCron(payload: NativeRecord): NativeRecord {
    const jobId = requiredText(payload.jobId, 'jobId')
    const scheduledJob = this.schedules.get(jobId)
    if (!scheduledJob) throw new Error(`No cron job found: ${jobId}`)
    scheduledJob.status = 'cancelled'
    this.publishNative('heartbeats_changed', {})
    return { job: scheduledJob }
  }

  private refine(payload: NativeRecord): NativeRecord {
    this.lastRefinement = {
      id: 'mock-refinement',
      summary: 'Reviewed the current session without changing persistent state.',
      rationale: typeof payload.instructions === 'string' ? payload.instructions : '',
      expectedOutcome: 'Continue from the reviewed session.',
      appliedEdits: [
        {
          id: 'verification-policy',
          title: 'Record workspace verification',
          applied: true,
          reason: 'Keep the release checks available to future turns.'
        }
      ],
      scope: payload.global === true ? 'global' : 'local'
    }
    this.publishCustom('refinement_outcome', String(this.lastRefinement.summary), {
      refinementId: this.lastRefinement.id,
      summary: this.lastRefinement.summary,
      scope: this.lastRefinement.scope,
      edits: this.lastRefinement.appliedEdits
    })
    return this.lastRefinement
  }
}
