import { create } from 'zustand'
import type { AgentInfo, CreateAgentArgs } from '@shared/api/engine'
import type {
  EngineEvent,
  ImageContent,
  RpcExtensionUIResponse,
  RpcSessionState,
  RpcSlashCommand,
  ThinkingLevel
} from '@shared/engine-types'
import { clientCommandId, rpc } from '../lib/engine'
import { invoke, on } from '../lib/ipc'
import { samePath } from '../lib/paths'
import { hydrateMessages, landBashRuns, pruneBashRuns, reduceAgentEvent } from './agent-reducer'
import {
  capabilityStatePatch,
  createAgentState,
  hasReadyHistory,
  restartedRuntime,
  sessionStatePatch,
  type AgentState
} from './agent-state'
import { indexSubagentHistory } from './subagent-index'

export interface PromptOptions {
  images?: ImageContent[]
  /** While running: `steer` (default) or `followUp`. Ignored when idle. */
  whileRunning?: 'steer' | 'followUp'
}

export interface AgentsStore {
  agents: Record<string, AgentState>
  /** Creation order (sidebar order). */
  order: string[]
  activeAgentId: string | null
  activationRevision: number

  /** Claim selection before asynchronous navigation starts. */
  requestActivation(): number
  /** Spawn an engine and select it unless a newer navigation request has taken priority. */
  createAgent(args: CreateAgentArgs, activationRevision?: number): Promise<string>
  disposeAgent(agentId: string): Promise<void>
  /** Restart the engine in place (same agent id); `patch` replaces stored CreateAgentArgs keys (see engine:restart). */
  restartAgent(agentId: string, patch?: Partial<CreateAgentArgs>): Promise<void>
  switchEngine(agentId: string, args: CreateAgentArgs): Promise<void>
  setActive(agentId: string | null, activationRevision?: number): void

  /** Send user input: starts a run when idle, steers/follows up while running. */
  prompt(agentId: string, text: string, options?: PromptOptions): Promise<void>
  abort(agentId: string): Promise<void>
  /** Remove queued steering/follow-up messages; returns their text (to restore into the composer). */
  clearQueue(agentId: string): Promise<{ steering: string[]; followUp: string[] }>
  /** Run `!command` through the engine's `bash` command; streamed output lands in `agent.bash[id]`. */
  runBash(agentId: string, command: string, excludeFromContext?: boolean): Promise<void>
  respondUi(agentId: string, response: RpcExtensionUIResponse): Promise<void>
  setModel(
    agentId: string,
    provider: string,
    modelId: string,
    thinking?: ThinkingLevel
  ): Promise<void>
  setThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void>

  /**
   * Reload everything from the engine (state, messages, levels, stats, commands). While the agent is
   * running only capabilities are refreshed, so the live stream and tool cards are kept.
   */
  refresh(agentId: string): Promise<void>
  /** Reload state, thinking levels and commands without touching the transcript (safe while running). */
  refreshCapabilities(agentId: string): Promise<void>
  refreshStats(agentId: string): Promise<void>
  /** Apply a batch of engine events (used by the rAF event pump). */
  applyEvents(batch: Map<string, EngineEvent[]>): void
  patchAgent(agentId: string, patch: Partial<AgentState>): void
}

/** Events for agents being created (engine:create in flight), by renderer-chosen agent id. */
const earlyEvents = new Map<string, EngineEvent[]>()
const MAX_EARLY_EVENTS = 2000
const restartRequests = new Set<string>()
const switchRequests = new Set<string>()
const historyRequests = new Map<string, Promise<void>>()

function upsertInfo(state: AgentsStore, info: AgentInfo): Pick<AgentsStore, 'agents' | 'order'> {
  const existing = state.agents[info.agentId]
  const sessionId = existing?.info.sessionId ?? existing?.session?.sessionId
  const replaced = !!info.sessionId && !!sessionId && info.sessionId !== sessionId
  const starting = info.status === 'starting' && existing?.status !== 'starting'
  const reset = existing && starting && restartRequests.has(info.agentId)
  if (existing && existing.info.engine !== info.engine) {
    clearAgentWork(info.agentId)
    const fresh = createAgentState(info)
    return {
      agents: {
        ...state.agents,
        [info.agentId]: {
          ...fresh,
          engineGeneration: existing.engineGeneration + 1,
          snapshotRevision: existing.snapshotRevision + 1,
          entries: existing.entries,
          tools: existing.tools,
          ext: { ...fresh.ext, editorText: existing.ext.editorText }
        }
      },
      order: state.order
    }
  }
  if (reset) clearAgentWork(info.agentId)
  const agent = existing
    ? {
        ...existing,
        ...(reset ? restartedRuntime(existing) : {}),
        engineGeneration: existing.engineGeneration + (starting ? 1 : 0),
        snapshotRevision: existing.snapshotRevision + (replaced ? 1 : 0),
        historyLoaded: existing.historyLoaded && !starting && !replaced,
        commandsStatus: starting || replaced ? 'loading' : existing.commandsStatus,
        info,
        status: info.status,
        error: info.error,
        sessionName: info.sessionName ?? existing.sessionName
      }
    : createAgentState(info)
  return {
    agents: { ...state.agents, [info.agentId]: agent },
    order: state.order.includes(info.agentId) ? state.order : [...state.order, info.agentId]
  }
}

export const useAgents = create<AgentsStore>()((set, get) => ({
  agents: {},
  order: [],
  activeAgentId: null,
  activationRevision: 0,

  requestActivation() {
    const activationRevision = get().activationRevision + 1
    set({ activationRevision })
    return activationRevision
  },

  async createAgent(args, activationRevision = get().requestActivation()) {
    const agentId = crypto.randomUUID()
    // Extensions may set statuses, widgets or open dialogs while the engine starts, before
    // engine:create resolves; hold those events and apply them to the new agent.
    earlyEvents.set(agentId, [])
    let info: AgentInfo
    try {
      info = await invoke('engine:create', args, agentId)
    } catch (error) {
      earlyEvents.delete(agentId)
      throw error
    }
    flush()
    const early = earlyEvents.get(agentId) ?? []
    earlyEvents.delete(agentId)
    set((state) => {
      const next = upsertInfo(state, info)
      next.agents[agentId] = early.reduce(reduceAgentEvent, next.agents[agentId]!)
      return {
        ...next,
        activeAgentId:
          state.activationRevision === activationRevision ? agentId : state.activeAgentId
      }
    })
    if (info.status === 'ready') {
      if (info.engine === 'prime' && get().agents[agentId]!.snapshotRevision > 0) {
        await Promise.all([get().refreshCapabilities(agentId), get().refreshStats(agentId)])
      } else {
        await get().refresh(agentId)
      }
    }
    return agentId
  },

  async disposeAgent(agentId) {
    await invoke('engine:dispose', agentId)
    clearAgentWork(agentId)
    set((state) => {
      const agents = { ...state.agents }
      delete agents[agentId]
      const order = state.order.filter((id) => id !== agentId)
      // The closed session's workspace keeps the front: its latest other session, else none (never another folder's).
      const cwd = state.agents[agentId]?.info.cwd
      const activeAgentId =
        state.activeAgentId === agentId
          ? (order.findLast((id) => samePath(agents[id]?.info.cwd, cwd)) ?? null)
          : state.activeAgentId
      return { agents, order, activeAgentId }
    })
  },

  async restartAgent(agentId, patch) {
    if (!get().agents[agentId]) return
    if (restartRequests.has(agentId) || switchRequests.has(agentId)) {
      throw new Error('This engine is already changing')
    }
    flush()
    restartRequests.add(agentId)
    try {
      const info = await invoke('engine:restart', agentId, patch)
      if (!get().agents[agentId]) return
      flush()
      set((state) => upsertInfo(state, info))
      if (info.status !== 'ready') throw new Error(info.error ?? 'The engine could not restart')
      await get().refresh(agentId)
    } catch (error) {
      // A refused restart leaves its live stream, queued messages and dialogs intact.
      const current = (await invoke('engine:list').catch(() => [] as AgentInfo[])).find(
        (candidate) => candidate.agentId === agentId
      )
      flush()
      if (current && get().agents[agentId]) set((state) => upsertInfo(state, current))
      throw error
    } finally {
      restartRequests.delete(agentId)
    }
  },

  async switchEngine(agentId, args) {
    flush()
    const agent = get().agents[agentId]
    if (!agent) throw new Error('This session is closed')
    if (switchRequests.has(agentId) || restartRequests.has(agentId)) {
      throw new Error('This engine is already changing')
    }
    switchRequests.add(agentId)
    get().patchAgent(agentId, {
      status: 'starting',
      historyLoaded: false,
      commandsStatus: 'loading',
      engineGeneration: agent.engineGeneration + 1,
      snapshotRevision: agent.snapshotRevision + 1
    })
    try {
      const info = await invoke('engine:switch', agentId, args)
      if (!get().agents[agentId]) return
      flush()
      set((state) => upsertInfo(state, info))
      await get().refresh(agentId)
    } catch (error) {
      const current = (await invoke('engine:list').catch(() => [] as AgentInfo[])).find(
        (candidate) => candidate.agentId === agentId
      )
      if (current && get().agents[agentId]) set((state) => upsertInfo(state, current))
      throw error
    } finally {
      switchRequests.delete(agentId)
    }
  },

  setActive(agentId, activationRevision = get().requestActivation()) {
    if (get().activationRevision === activationRevision) set({ activeAgentId: agentId })
  },

  async prompt(agentId, text, options = {}) {
    const agent = get().agents[agentId]
    if (!agent) return
    const selection = modelChanges.get(agentId)
    if (selection) {
      await selection
      if (!isCurrentGeneration(agentId, agent.engineGeneration, agent.snapshotRevision)) {
        throw new Error('The session changed before the message could be sent. Send it again.')
      }
    }
    const sentAt = Date.now()
    // Always state how to queue: the local phase lags the engine by a frame + IPC hop, and pi
    // ignores streamingBehavior when idle.
    const { disposition } = await rpc(agentId, {
      type: 'prompt',
      message: text,
      images: options.images,
      streamingBehavior: options.whileRunning ?? 'steer'
    })
    // An extension command answers only once its handler returned, so the dialogs it awaited are settled: the
    // Engine resolved any still open here itself (AbortSignal) without telling the client.
    if (disposition === 'handled') dropIdleDialogsSince(agentId, sentAt)
  },

  async abort(agentId) {
    await rpc(agentId, { type: 'abort' })
  },

  async clearQueue(agentId) {
    const cleared = await rpc(agentId, { type: 'clear_queue' })
    // The Engine's queue_update precedes the answer: apply it now, so the chips and the caller agree.
    flush()
    return cleared
  },

  async runBash(agentId, command, excludeFromContext) {
    const id = clientCommandId()
    const startedAt = Date.now()
    set((state) => {
      const agent = state.agents[agentId]
      if (!agent) return state
      const run = { id, command, output: '', running: true, startedAt, excludeFromContext }
      return {
        agents: { ...state.agents, [agentId]: { ...agent, bash: { ...agent.bash, [id]: run } } }
      }
    })
    try {
      const result = await rpc(agentId, { type: 'bash', id, command, excludeFromContext })
      flush()
      set((state) => {
        const agent = state.agents[agentId]
        const run = agent?.bash[id]
        if (!agent || !run) return state
        const finished = {
          ...agent,
          bash: { ...agent.bash, [id]: { ...run, running: false, result } }
        }
        // While a run is active the Engine records the command when that run ends (landed on agent_settled).
        return {
          agents: {
            ...state.agents,
            [agentId]: finished.phase === 'idle' ? landBashRuns(finished) : finished
          }
        }
      })
    } finally {
      const agent = get().agents[agentId]
      const run = agent?.bash[id]
      if (agent && run) {
        const bash = run.running ? { ...agent.bash, [id]: { ...run, running: false } } : agent.bash
        get().patchAgent(agentId, { bash: pruneBashRuns(bash, agent.entries) })
      }
    }
  },

  async respondUi(agentId, response) {
    const agent = get().agents[agentId]
    if (agent) {
      get().patchAgent(agentId, {
        ext: {
          ...agent.ext,
          dialogs: agent.ext.dialogs.filter((d) => d.request.id !== response.id)
        }
      })
    }
    await invoke('engine:ui-response', agentId, response)
  },

  async setModel(agentId, provider, modelId, thinking) {
    await withModelChange(agentId, async (assertCurrent) => {
      await rpc(agentId, { type: 'set_model', provider, modelId })
      if (thinking) {
        assertCurrent()
        await rpc(agentId, { type: 'set_thinking_level', level: thinking })
      }
    })
    scheduleStats(agentId)
  },

  async setThinkingLevel(agentId, level) {
    await withModelChange(agentId, () => rpc(agentId, { type: 'set_thinking_level', level }))
  },

  async refresh(agentId) {
    const agent = get().agents[agentId]
    if (!agent) return
    const key = `${agentId}:${agent.engineGeneration}:${agent.snapshotRevision}`
    const request = refreshAgent(agentId).finally(() => {
      if (historyRequests.get(key) === request) historyRequests.delete(key)
    })
    if (!agent.historyLoaded) historyRequests.set(key, request)
    return request
  },

  async refreshCapabilities(agentId) {
    const generation = get().agents[agentId]?.engineGeneration
    const revision = get().agents[agentId]?.snapshotRevision
    const modelRevision = get().agents[agentId]?.modelRevision
    if (generation === undefined) return
    const [state, levels, commands] = await Promise.all([
      rpc(agentId, { type: 'get_state' }),
      rpc(agentId, { type: 'get_available_thinking_levels' }),
      rpc(agentId, { type: 'get_commands' })
    ]).catch((error) => {
      if (isCurrentGeneration(agentId, generation, revision)) {
        get().patchAgent(agentId, { commandsStatus: 'error' })
      }
      throw error
    })
    if (!isCurrentGeneration(agentId, generation, revision)) return
    applyCapabilities(agentId, state, levels.levels, commands.commands, modelRevision)
  },

  async refreshStats(agentId) {
    const generation = get().agents[agentId]?.engineGeneration
    const revision = get().agents[agentId]?.snapshotRevision
    if (generation === undefined) return
    const stats = await rpc(agentId, { type: 'get_session_stats' })
    if (!isCurrentGeneration(agentId, generation, revision)) return
    get().patchAgent(agentId, { stats })
  },

  applyEvents(batch) {
    set((state) => {
      let agents: Record<string, AgentState> | null = null
      for (const [agentId, events] of batch) {
        let agent = (agents ?? state.agents)[agentId]
        if (!agent) {
          const early = earlyEvents.get(agentId)
          early?.push(...events.slice(0, Math.max(0, MAX_EARLY_EVENTS - early.length)))
          continue
        }
        for (const event of events) agent = reduceAgentEvent(agent, event)
        agents ??= { ...state.agents }
        agents[agentId] = agent
      }
      return agents ? { agents } : state
    })
  },

  patchAgent(agentId, patch) {
    set((state) => {
      const agent = state.agents[agentId]
      if (!agent) return state
      return { agents: { ...state.agents, [agentId]: { ...agent, ...patch } } }
    })
  }
}))

async function refreshAgent(agentId: string): Promise<void> {
  const get = useAgents.getState
  const generation = get().agents[agentId]?.engineGeneration
  const revision = get().agents[agentId]?.snapshotRevision
  const modelRevision = get().agents[agentId]?.modelRevision
  if (generation === undefined) return
  if (get().agents[agentId]?.phase === 'running') {
    await get().refreshCapabilities(agentId)
    return
  }
  const stateRequest = rpc(agentId, { type: 'get_state' })
  const history = Promise.all([stateRequest, rpc(agentId, { type: 'get_messages' })]).then(
    async ([state, messages]) => {
      if (!isCurrentGeneration(agentId, generation, revision)) return
      const current = get().agents[agentId]
      if (!current) return
      get().patchAgent(agentId, sessionStatePatch(current, state, modelRevision))
      // A run that started meanwhile owns the transcript; replacing it would drop the live stream.
      if (state.isStreaming || get().agents[agentId]?.phase === 'running') return
      const { entries, tools } = hydrateMessages(messages.messages)
      const bash = pruneBashRuns(current?.bash ?? {}, entries)
      const subagents = current
        ? indexSubagentHistory(current.subagents, messages.messages, tools)
        : undefined
      get().patchAgent(agentId, {
        phase: 'idle',
        historyLoaded: true,
        entries,
        tools,
        streaming: null,
        bash,
        ...(subagents ? { subagents } : {})
      })
      await get().refreshStats(agentId)
    }
  )
  // Extension discovery can be slow; committed history does not depend on the command catalog.
  const capabilities = Promise.all([
    stateRequest,
    rpc(agentId, { type: 'get_available_thinking_levels' }),
    rpc(agentId, { type: 'get_commands' })
  ])
    .then(([state, levels, commands]) => {
      if (isCurrentGeneration(agentId, generation, revision)) {
        applyCapabilities(agentId, state, levels.levels, commands.commands, modelRevision)
      }
    })
    .catch((error) => {
      if (isCurrentGeneration(agentId, generation, revision)) {
        get().patchAgent(agentId, { commandsStatus: 'error' })
      }
      throw error
    })
  await Promise.all([history, capabilities])
}

/** Activation joins initial hydration; explicit refreshes after native mutations always read again. */
export function ensureAgentHistory(agentId: string): Promise<void> {
  const store = useAgents.getState()
  const agent = store.agents[agentId]
  if (!agent || hasReadyHistory(agent)) return Promise.resolve()
  const key = `${agentId}:${agent.engineGeneration}:${agent.snapshotRevision}`
  return historyRequests.get(key) ?? store.refresh(agentId)
}

function isCurrentGeneration(agentId: string, generation: number, revision?: number): boolean {
  const agent = useAgents.getState().agents[agentId]
  return (
    agent?.engineGeneration === generation &&
    (revision === undefined || agent.snapshotRevision === revision)
  )
}

const modelChanges = new Map<string, Promise<unknown>>()

/** Native switches may run concurrently; keep selection and its authoritative read in order. */
export function withModelChange<Result>(
  agentId: string,
  change: (assertCurrent: () => void) => Promise<Result>
): Promise<Result> {
  flush()
  const agent = useAgents.getState().agents[agentId]
  if (!agent || agent.status !== 'ready') {
    return Promise.reject(new Error('Wait for the session to connect before changing its model.'))
  }
  const { engineGeneration, snapshotRevision } = agent
  const assertCurrent = () => {
    flush()
    if (
      !isCurrentGeneration(agentId, engineGeneration, snapshotRevision) ||
      useAgents.getState().agents[agentId]?.status !== 'ready'
    ) {
      throw new Error('The session changed before the selection could finish. Choose it again.')
    }
  }
  useAgents.getState().patchAgent(agentId, {
    modelChangePending: true,
    modelRevision: agent.modelRevision + 1
  })
  const previous = modelChanges.get(agentId) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      assertCurrent()
      let result: Result
      try {
        result = await change(assertCurrent)
      } catch (error) {
        if (isCurrentGeneration(agentId, engineGeneration, snapshotRevision)) {
          await refreshModelState(agentId, true).catch(() => undefined)
        }
        throw error
      }
      assertCurrent()
      await refreshModelState(agentId, true)
      return result
    })
  const tracked = operation.finally(() => {
    if (modelChanges.get(agentId) !== tracked) return
    modelChanges.delete(agentId)
    const current = useAgents.getState().agents[agentId]
    if (current) {
      useAgents.getState().patchAgent(agentId, {
        modelChangePending: false,
        modelRevision: current.modelRevision + 1
      })
    }
  })
  modelChanges.set(agentId, tracked)
  return tracked
}

async function refreshModelState(agentId: string, allowPending = false): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent || (agent.modelChangePending && !allowPending)) return
  const { engineGeneration, snapshotRevision, modelRevision } = agent
  const [state, { levels }] = await Promise.all([
    rpc(agentId, { type: 'get_state' }),
    rpc(agentId, { type: 'get_available_thinking_levels' })
  ])
  flush()
  const current = useAgents.getState().agents[agentId]
  if (
    !isCurrentGeneration(agentId, engineGeneration, snapshotRevision) ||
    current?.modelRevision !== modelRevision
  )
    return
  useAgents.getState().patchAgent(agentId, {
    session: state,
    historyLoaded: current.historyLoaded && current.session?.sessionId === state.sessionId,
    model: state.model,
    thinkingLevel: state.thinkingLevel,
    thinkingLevels: levels,
    sessionName: state.sessionName,
    info: { ...current.info, lineage: state.lineage }
  })
}

// ─── Event pump: IPC events are queued and applied once per animation frame ──────────────────

/**
 * Drop the dialogs that arrived outside a run since `since` (see `prompt`). Dialogs with a timeout stay: the
 * extension UI's expiry timer drops them at their deadline and says the request timed out.
 */
function dropIdleDialogsSince(agentId: string, since: number): void {
  flush()
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  const dialogs = agent.ext.dialogs.filter(
    (dialog) =>
      dialog.duringRun ||
      dialog.receivedAt < since ||
      (dialog.request.method !== 'editor' && !!dialog.request.timeout)
  )
  if (dialogs.length !== agent.ext.dialogs.length)
    useAgents.getState().patchAgent(agentId, { ext: { ...agent.ext, dialogs } })
}

/** Apply engine capabilities (state, levels, commands) without touching the transcript. */
function applyCapabilities(
  agentId: string,
  state: RpcSessionState,
  levels: ThinkingLevel[],
  commands: RpcSlashCommand[],
  modelRevision: number | undefined
): void {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  useAgents
    .getState()
    .patchAgent(agentId, capabilityStatePatch(agent, state, levels, commands, modelRevision))
}

const pending = new Map<string, EngineEvent[]>()
let frame: number | null = null
let fallback: ReturnType<typeof setTimeout> | null = null
const statsTimers = new Map<string, ReturnType<typeof setTimeout>>()
const stateTimers = new Map<string, ReturnType<typeof setTimeout>>()
const REFRESH_DEBOUNCE_MS = 250
const HIDDEN_WINDOW_FLUSH_MS = 120

function clearAgentWork(agentId: string): void {
  pending.delete(agentId)
  earlyEvents.delete(agentId)
  modelChanges.delete(agentId)
  for (const timers of [statsTimers, stateTimers]) {
    const timer = timers.get(agentId)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(agentId)
  }
}

function debounce(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  agentId: string,
  run: () => Promise<void>
): void {
  const existing = timers.get(agentId)
  if (existing) clearTimeout(existing)
  timers.set(
    agentId,
    setTimeout(() => {
      timers.delete(agentId)
      if (useAgents.getState().agents[agentId]) void run().catch(() => undefined)
    }, REFRESH_DEBOUNCE_MS)
  )
}

function scheduleStats(agentId: string): void {
  debounce(statsTimers, agentId, () => useAgents.getState().refreshStats(agentId))
}

/** Extensions can change model/thinking (pi.setModel) without an RPC event; re-read state once a run settles. */
function scheduleStateRefresh(agentId: string): void {
  debounce(stateTimers, agentId, () => refreshModelState(agentId))
}

function flush(): void {
  if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
  if (fallback !== null) clearTimeout(fallback)
  frame = null
  fallback = null
  if (pending.size === 0) return
  const batch = new Map(pending)
  pending.clear()
  useAgents.getState().applyEvents(batch)
  for (const [agentId, events] of batch) {
    if (
      events.some(
        (event) =>
          event.type === 'engine_native_event' &&
          event.engine === 'prime' &&
          event.name === 'session_snapshot'
      )
    ) {
      scheduleStats(agentId)
      debounce(stateTimers, agentId, () => useAgents.getState().refreshCapabilities(agentId))
      continue
    }
    if (
      events.some(
        (e) =>
          e.type === 'agent_settled' ||
          e.type === 'compaction_end' ||
          (e.type === 'message_end' && e.message.role === 'assistant')
      )
    ) {
      scheduleStats(agentId)
    }
    if (events.some((e) => e.type === 'agent_settled')) scheduleStateRefresh(agentId)
  }
}

/**
 * Replace an earlier queued `tool_execution_update` for the same tool call in the current frame,
 * stopping at any lifecycle boundary for that call so ordering semantics stay intact.
 */
function coalesceToolUpdate(list: EngineEvent[], event: EngineEvent): boolean {
  if (event.type !== 'tool_execution_update') return false
  for (let i = list.length - 1; i >= 0; i--) {
    const candidate = list[i]!
    if (candidate.type === 'agent_settled' || candidate.type === 'engine_native_event') return false
    if (
      (candidate.type === 'tool_execution_start' || candidate.type === 'tool_execution_end') &&
      candidate.toolCallId === event.toolCallId
    ) {
      return false
    }
    if (
      candidate.type === 'message_end' &&
      candidate.message.role === 'toolResult' &&
      candidate.message.toolCallId === event.toolCallId
    ) {
      return false
    }
    if (candidate.type === 'tool_execution_update' && candidate.toolCallId === event.toolCallId) {
      list[i] = event
      return true
    }
  }
  return false
}

function enqueue(agentId: string, event: EngineEvent): void {
  if (!useAgents.getState().agents[agentId] && !earlyEvents.has(agentId)) return
  const list = pending.get(agentId)
  const previous = list?.[list.length - 1]
  const combined = previous ? combineDeltas(previous, event) : null
  if (list && combined) list[list.length - 1] = combined
  else if (list && coalesceToolUpdate(list, event)) {
    // Replaced the earlier update for this toolCallId in-place.
  } else if (list) list.push(event)
  else pending.set(agentId, [event])
  if (frame === null && typeof requestAnimationFrame === 'function')
    frame = requestAnimationFrame(flush)
  // rAF does not fire while the window is hidden/minimized; never let events stall.
  if (fallback === null) fallback = setTimeout(flush, HIDDEN_WINDOW_FLUSH_MS)
}

/** Only adjacent deltas combine: starts, ends, tool results and other events remain ordering barriers. */
export function combineDeltas(previous: EngineEvent, event: EngineEvent): EngineEvent | null {
  if (previous.type !== 'message_update' || event.type !== 'message_update') return null
  const before = previous.assistantMessageEvent
  const update = event.assistantMessageEvent
  if (
    (before.type !== 'text_delta' &&
      before.type !== 'thinking_delta' &&
      before.type !== 'toolcall_delta') ||
    (update.type !== 'text_delta' &&
      update.type !== 'thinking_delta' &&
      update.type !== 'toolcall_delta') ||
    before.type !== update.type ||
    before.contentIndex !== update.contentIndex
  )
    return null
  return { ...event, assistantMessageEvent: { ...update, delta: before.delta + update.delta } }
}

let started = false

/** Subscribe the agents store to engine IPC events. Call once at startup. */
export function startAgentEventPump(): void {
  if (started) return
  started = true
  on('engine:event', ({ agentId, event }) => enqueue(agentId, event))
  on('engine:status', ({ agentId, info }) => {
    flush()
    const store = useAgents.getState()
    if (!store.agents[agentId]) return
    if (
      switchRequests.has(agentId) &&
      store.agents[agentId]?.info.engine === info.engine &&
      info.status === 'ready'
    )
      return
    useAgents.setState((state) => upsertInfo(state, info))
    if (info.status === 'crashed') store.patchAgent(agentId, { phase: 'idle', streaming: null })
  })
  on('engine:exit', ({ agentId, expected }) => {
    flush()
    if (!expected) useAgents.getState().patchAgent(agentId, { phase: 'idle' })
  })
}

/** Selector helpers */
export const selectActiveAgent = (state: AgentsStore): AgentState | undefined =>
  state.activeAgentId ? state.agents[state.activeAgentId] : undefined
