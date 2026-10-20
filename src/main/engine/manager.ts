import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  hasBridgeCommands,
  isEngineId,
  normalizeEngineId,
  type AgentInfo,
  type BridgeCallOptions,
  type BridgeRequest,
  type BridgeResult,
  type ConversationPrompt,
  type CreateAgentArgs,
  type EngineExitInfo,
  type EngineId,
  type EngineStatus,
  type MockPlayArgs
} from '@shared/api/engine'
import { launchOptionsToArgs } from '@shared/api/launch'
import type {
  EngineEvent,
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  RpcSuccessResponse
} from '@shared/engine-types'
import { samePath } from '../paths'
import type { SubagentInspectReply, SubagentInspectRequest } from '@shared/subagents'
import { bridgeLoadFailed, bridgeTimeout, callBridge } from './bridge'
import { withPiConversationPrompt, type PiPromptSources } from './conversation-prompt'
import type { EngineHandle } from './handle'
import { locateEngine, type EngineLocation } from './locate'
import { EngineProcess } from './rpc-process'
import { asRecord, stringValue } from './prime/transport'
import { requestSessionTree } from './session-tree'
import {
  absoluteSessionFile,
  prepareEngineAttachment,
  withAbsoluteSessionFile
} from './session-attachment'
import {
  assertRestartIdle,
  locateRestartEngine,
  observeRestartDialog,
  prepareRestartArgs,
  type RestartDialog
} from './restart'
import { inspectSubagent } from './subagents-inspect'
import {
  assertPrimeHandoffIdle,
  assertSwitchTarget,
  captureHandoffSnapshot,
  hasHandoffHistory,
  pausePrimeHandoff,
  sameHandoffSnapshot
} from './switch'

export interface EngineManagerHooks {
  onEvent(agentId: string, event: EngineEvent): void
  onStatus(agentId: string, status: EngineStatus, info: AgentInfo): void
  onExit(exit: EngineExitInfo): void
}

export interface EngineManagerOptions {
  mock: boolean
  engineOverridePath: (engine?: EngineId) => string | null
  /** Absolute path of the bridge extension file, or null to start engines without it. */
  bridgeExtensionPath: () => string | null
  /** Environment the bridge reads (e.g. `VENGEANCE_NATIVE_COMPACTION`), under the workspace's launch env. */
  bridgeEnv?: () => Record<string, string>
  /** Models the user's accounts offer (`account-models.ts`); hidden ones leave the model list and the model cycle. */
  offeredModel?: () => ((model: { provider: string; id: string }) => boolean) | null
  /** Where the Engine reads a conversation's own instructions from, discovered fresh for each spawn. */
  piPromptSources?: (args: CreateAgentArgs) => Promise<PiPromptSources | undefined>
}

/** Most hidden models a forward cycle steps over before it gives up and keeps where it landed. */
const MAX_CYCLE_SKIPS = 64

interface ManagedAgent {
  info: AgentInfo
  /** Null when no engine could be created (e.g. not installed); the agent stays listed as `crashed`. */
  handle: EngineHandle | null
  unsubscribe: Array<() => void>
  started?: boolean
  restarting?: boolean
  switching?: boolean
  hidden?: boolean
  bufferedEvents?: EngineEvent[]
  operations: number
  dialogs: Map<string, RestartDialog>
  terminated?: boolean
}

const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/

export { withAbsoluteSessionFile } from './session-attachment'

/**
 * The conversation instructions for a spawn that continues a running conversation, once the session file
 * its process runs now is known (undefined for a temporary chat).
 */
export type InstructionsFor = (
  sessionFile: string | undefined
) => ConversationPrompt | null | undefined

/**
 * Told that a restart's configuration took effect, with the successor's args and the session file its
 * engine reported once known. It must not throw: the old engine may already have released its connection.
 */
export type RestartApplied = (successor: Pick<AgentInfo, 'args' | 'sessionFile'>) => Promise<void>

/** The saved session file a spawn of `args` resumes, if any (a fork writes a new one). */
export function resumedSessionFile(args: CreateAgentArgs): string | undefined {
  return args.noSession || args.forkFrom
    ? undefined
    : absoluteSessionFile(args.sessionPath, args.cwd)
}

/**
 * Build pi CLI args (after `--mode rpc`) from session options, loading the bridge extension when given.
 * The conversation's instructions apply through `promptSources`, which the caller discovered for this spawn.
 */
export function buildEngineArgs(
  args: CreateAgentArgs,
  bridgeExtensionPath: string | null = null,
  promptSources?: PiPromptSources
): string[] {
  const out: string[] = []
  if (args.forkFrom) out.push('--fork', args.forkFrom)
  else if (args.sessionPath) out.push('--session', args.sessionPath)
  else if (args.noSession) out.push('--no-session')
  if (args.sessionDir) out.push('--session-dir', args.sessionDir)
  if (args.provider) out.push('--provider', args.provider)
  if (args.model) out.push('--model', args.model)
  if (args.thinking) out.push('--thinking', args.thinking)
  if (args.name) out.push('--name', args.name)
  if (args.approve === true) out.push('--approve')
  else if (args.approve === false) out.push('--no-approve')
  // Explicit extension paths load even with --no-extensions.
  if (bridgeExtensionPath) out.push('--extension', bridgeExtensionPath)
  out.push(
    ...launchOptionsToArgs(
      args.conversationPrompt && promptSources
        ? withPiConversationPrompt(args.launch, args.conversationPrompt, promptSources)
        : args.launch
    )
  )
  if (args.extraArgs) out.push(...args.extraArgs)
  return out
}

/** Owns each open session's engine connection, with many sessions running in parallel. */
export class EngineManager {
  private readonly agents = new Map<string, ManagedAgent>()
  /** Engine versions that refused to load the bridge; later spawns of that version skip it. */
  private readonly bridgeRejectedBy = new Set<string>()

  constructor(
    private readonly hooks: EngineManagerHooks,
    private readonly options: EngineManagerOptions
  ) {}

  list(): AgentInfo[] {
    return [...this.agents.values()].filter((agent) => !agent.hidden).map((a) => ({ ...a.info }))
  }

  get(agentId: string): AgentInfo | undefined {
    const agent = this.agents.get(agentId)
    return agent ? { ...agent.info } : undefined
  }

  /** True when any agent is between agent_start and agent_settled. */
  anyBusy(engine?: EngineId): boolean {
    return [...this.agents.values()].some(
      (agent) => agent.info.busy && (engine === undefined || agent.info.engine === engine)
    )
  }

  /**
   * Spawn an engine for an agent. Never throws for engine problems: a missing engine or a failed
   * startup leaves the agent listed with status `crashed` and an error, so the UI can offer a restart.
   */
  async create(
    args: CreateAgentArgs,
    agentId: string = randomUUID(),
    location?: EngineLocation,
    hidden = false
  ): Promise<AgentInfo> {
    if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id ${agentId}`)
    if (this.agents.has(agentId)) throw new Error(`Agent ${agentId} already exists`)
    const engine = normalizeEngineId(args.engine)
    args = prepareEngineAttachment(args, this.agents.values(), hidden)
    const info: AgentInfo = {
      agentId,
      engine,
      cwd: args.cwd,
      status: 'starting',
      mock: this.options.mock,
      busy: false,
      bridge: false,
      createdAt: Date.now(),
      args: { ...args, engine }
    }
    const agent: ManagedAgent = {
      info,
      handle: null,
      unsubscribe: [],
      operations: 1,
      dialogs: new Map(),
      hidden,
      bufferedEvents: hidden ? [] : undefined
    }
    this.agents.set(agentId, agent)
    try {
      const resolved =
        this.options.mock || engine === 'prime' ? undefined : (location ?? (await this.locate()))
      await this.startHandle(agent, resolved, true)
    } catch (error) {
      info.status = 'crashed'
      info.busy = false
      info.error = agent.handle?.error ?? (error as Error).message
      // A disposed (or already replaced) agent must not report over its successor with the same id.
      if (this.agents.get(agentId) === agent && !agent.hidden) {
        this.hooks.onStatus(agentId, info.status, { ...info })
      }
    }
    agent.operations--
    return { ...info }
  }

  async command(agentId: string, command: RpcCommand): Promise<RpcResponse> {
    return this.operation(agentId, (agent) => this.sendCommand(agent, command))
  }

  private async sendCommand(agent: ManagedAgent, command: RpcCommand): Promise<RpcResponse> {
    const handle = this.requireHandle(agent)
    const reply =
      command.type === 'get_tree' && agent.info.engine === 'pi'
        ? await requestSessionTree(handle, command)
        : await handle.send(command)
    const response = withAbsoluteSessionFile(reply, agent.info.cwd)
    if (response.success) {
      if (
        command.type === 'new_session' ||
        command.type === 'switch_session' ||
        command.type === 'fork' ||
        command.type === 'clone'
      ) {
        await this.refreshSession(agent)
      } else if (response.command === 'get_commands') {
        agent.info.bridge =
          agent.info.engine === 'prime'
            ? !!handle.bridge
            : hasBridgeCommands(response.data.commands)
      } else if (response.command === 'get_available_models' && agent.info.engine === 'pi') {
        const offered = this.options.offeredModel?.()
        if (offered)
          return {
            ...response,
            data: { ...response.data, models: response.data.models.filter(offered) }
          }
      } else if (response.command === 'cycle_model' && agent.info.engine === 'pi') {
        return this.cycleToOffered(handle, response)
      }
    }
    return response
  }

  /** `cycle_model` landed on a model the account does not offer: cycle on until one it does (or back to the start). */
  private async cycleToOffered(
    handle: EngineHandle,
    first: RpcSuccessResponse<'cycle_model'>
  ): Promise<RpcResponse> {
    const offered = this.options.offeredModel?.()
    const start = first.data?.model
    if (!offered || !start) return first
    let current = first
    for (
      let skips = 0;
      skips < MAX_CYCLE_SKIPS && current.data && !offered(current.data.model);
      skips++
    ) {
      const next = await handle.send({ type: 'cycle_model' })
      if (!next.success || next.command !== 'cycle_model' || !next.data) break
      current = next
      if (next.data.model.provider === start.provider && next.data.model.id === start.id) break
    }
    return current
  }

  /** Run a Vengeance bridge operation (in-place tree navigation, reload, tools, labels). */
  async bridge(
    agentId: string,
    request: BridgeRequest,
    options: BridgeCallOptions = {}
  ): Promise<BridgeResult> {
    // Engine 2 can take many seconds to list MCP servers, and the read changes nothing: restarts
    // and engine switches do not wait for it (they close its connection, which fails the read).
    const engine = this.agents.get(agentId)?.info.engine
    if (request.op === 'mcp' && !request.action && engine === 'prime') {
      return this.sendBridge(this.admit(agentId), request, options)
    }
    return this.operation(agentId, (agent) => this.sendBridge(agent, request, options))
  }

  private async sendBridge(
    agent: ManagedAgent,
    request: BridgeRequest,
    options: BridgeCallOptions
  ): Promise<BridgeResult> {
    const handle = this.requireHandle(agent)
    if (agent.info.engine === 'prime') {
      if (!handle.bridge) throw new Error('This engine does not provide this session operation')
      return handle.bridge(request)
    }
    if (!agent.info.bridge) throw new Error('The Vengeance bridge is not loaded in this engine')
    const result = await callBridge(handle, request, options.timeoutMs ?? bridgeTimeout(request))
    // A reload re-registers every extension command; re-check that the bridge survived it.
    if (request.op === 'reload') await this.refreshSession(agent)
    return result
  }

  /** Live transcript of an async subagent child (pi-subagents' inspect host command). */
  inspectSubagent(agentId: string, request: SubagentInspectRequest): Promise<SubagentInspectReply> {
    return this.operation(agentId, async (agent) => {
      if (agent.info.engine !== 'pi') {
        throw new Error('Use this engine’s native agent controls to inspect a child session')
      }
      return inspectSubagent(this.requireHandle(agent), request)
    })
  }

  async nativeCommand(
    agentId: string,
    type: string,
    payload?: Record<string, unknown>
  ): Promise<unknown> {
    return this.operation(agentId, (agent) => this.sendNative(agent, type, payload))
  }

  private async sendNative(
    agent: ManagedAgent,
    type: string,
    payload?: Record<string, unknown>
  ): Promise<unknown> {
    const handle = this.requireHandle(agent)
    if (agent.info.engine !== 'prime' || !handle.nativeCommand) {
      throw new Error('Native operations are not available for this engine')
    }
    const response = await handle.nativeCommand(type, payload)
    if (
      ['new_session', 'switch_session', 'fork', 'import_jsonl', 'set_session_name'].includes(type)
    ) {
      await this.refreshSession(agent)
    }
    return response
  }

  respondUi(agentId: string, response: RpcExtensionUIResponse): void {
    const agent = this.require(agentId)
    if (agent.switching) throw new Error('Wait for the engine switch to finish')
    if (agent.restarting) throw new Error('Wait for the engine restart to finish')
    agent.handle?.respondUi(response)
    agent.dialogs.delete(response.id)
  }

  stderr(agentId: string): string {
    return this.require(agentId).handle?.stderr() ?? ''
  }

  /**
   * Restart with the same args (resuming the session file); `patch` keys, even undefined ones, replace stored
   * args. `instructionsFor` picks the conversation instructions for the session file the restart resumes.
   * `onApplied` hears when the successor's configuration took effect: once its spawn did not crash, or as
   * soon as the old backend applied it natively (an Engine 2 resident keeps it whatever happens next).
   */
  async restart(
    agentId: string,
    patch?: Partial<CreateAgentArgs>,
    instructionsFor?: InstructionsFor,
    onApplied?: RestartApplied
  ): Promise<AgentInfo> {
    const agent = this.require(agentId)
    if (agent.switching) throw new Error('Wait for the engine switch to finish')
    if (agent.restarting) throw new Error('This engine is already restarting')
    assertRestartIdle(agent.info, agent.operations, agent.dialogs)
    agent.restarting = true
    const assertOpen = (): void => {
      if (this.agents.get(agentId) !== agent) throw new Error('This session is no longer open')
    }
    try {
      // Locate first: when the engine cannot be found, keep the current process instead of killing it.
      if (patch?.engine !== undefined && patch.engine !== agent.info.engine) {
        throw new Error('Choose a different engine when creating a new session')
      }
      const location = await locateRestartEngine(
        agent.info.engine,
        this.options.mock,
        this.options.engineOverridePath(agent.info.engine)
      )
      assertOpen()
      assertRestartIdle(agent.info, agent.operations, agent.dialogs)
      let args = await prepareRestartArgs(agent.info, agent.handle, patch)
      if (instructionsFor) {
        args = { ...args, conversationPrompt: instructionsFor(resumedSessionFile(args)) }
      }
      assertOpen()
      assertRestartIdle(agent.info, agent.operations, agent.dialogs)
      let applied = false
      // A failed startup already released its client; retry creation and native resident lookup.
      if (agent.started) {
        const prepared = await agent.handle?.prepareRestart?.(
          args,
          this.options.engineOverridePath(agent.info.engine),
          patch
        )
        if (prepared) args = prepared.args
        if (prepared?.applied) {
          // The backend committed the configuration natively: the session keeps it even when the
          // re-attach below fails.
          applied = true
          await onApplied?.({ args })
        }
      }
      assertOpen()
      if (agent.info.engine === 'pi') {
        assertRestartIdle(agent.info, agent.operations, agent.dialogs)
      }
      await this.stopAgent(agent)
      assertOpen()
      this.agents.delete(agentId)
      const restarted = await this.create(args, agentId, location)
      if (!applied && restarted.status !== 'crashed') await onApplied?.(restarted)
      return restarted
    } finally {
      agent.restarting = false
    }
  }

  /** `instructionsFor` picks the conversation instructions the switched conversation keeps. */
  async switchEngine(
    agentId: string,
    args: CreateAgentArgs,
    instructionsFor?: InstructionsFor
  ): Promise<AgentInfo> {
    const source = this.require(agentId)
    if (!isEngineId(args.engine) || args.engine === source.info.engine) {
      throw new Error('Choose a different engine for this session')
    }
    if (!isAbsolute(args.cwd) || !samePath(args.cwd, source.info.cwd)) {
      throw new Error('Engine switching must keep the current workspace')
    }
    assertSwitchTarget(source.info, args)
    if (source.switching || source.restarting || source.operations) {
      throw new Error('Wait for the current session operation to finish before switching engines')
    }
    source.switching = true
    const candidateId = randomUUID()
    let generatedPath: string | undefined
    let releasePause: (() => Promise<void>) | undefined
    let guard: ReturnType<NonNullable<EngineHandle['guardHandoff']>> | undefined
    let committed = false
    const assertOpen = (): void => {
      if (this.agents.get(agentId) !== source) throw new Error('This session is no longer open')
    }
    try {
      const handle = this.requireHandle(source)
      if (source.info.engine === 'prime' && !this.options.mock) {
        guard = handle.guardHandoff?.()
        if (!guard) throw new Error('The source engine cannot guard a session handoff')
        releasePause = await pausePrimeHandoff(handle)
      }
      const snapshot = await captureHandoffSnapshot(handle)
      assertOpen()
      const noSession =
        args.noSession || (source.info.args.noSession && !snapshot.state.sessionFile)
      if (noSession && snapshot.messages.length) {
        throw new Error(
          'Temporary sessions with messages cannot switch engines without saving history'
        )
      }
      const target: CreateAgentArgs = {
        ...args,
        cwd: source.info.cwd,
        name: snapshot.state.sessionName ?? args.name,
        noSession
      }
      if (instructionsFor) {
        target.conversationPrompt = instructionsFor(
          absoluteSessionFile(snapshot.state.sessionFile, source.info.cwd)
        )
      }
      await this.resolveSwitchSelection(target, candidateId)
      assertOpen()
      const hasHistory = hasHandoffHistory(snapshot)
      if (!noSession && hasHistory) {
        const { createEngineHandoff } = this.options.mock
          ? await import('./mock-handoff')
          : await import('../features/sessions/handoff')
        const sessionEnv =
          args.engine === 'pi' ? 'PI_CODING_AGENT_SESSION_DIR' : 'PRIME_AGENT_SESSION_DIR'
        const result = await createEngineHandoff(
          {
            sourceEngine: source.info.engine,
            targetEngine: args.engine,
            cwd: target.cwd,
            name: target.name,
            messages: snapshot.messages,
            entries: snapshot.entries,
            leafId: snapshot.leafId,
            sourceSessionPath: source.info.sessionFile,
            sessionDir: target.sessionDir ?? target.launch?.env?.[sessionEnv],
            launchEnv: target.launch?.env
          },
          this.options.engineOverridePath(args.engine)
        )
        generatedPath = result.path
        target.sessionPath = result.path
      }
      assertOpen()
      await this.create(target, candidateId, undefined, true)
      const candidate = this.require(candidateId)
      if (candidate.info.status !== 'ready') {
        throw new Error(candidate.info.error ?? 'The destination engine did not become ready')
      }
      const destination = await captureHandoffSnapshot(this.requireHandle(candidate))
      if (generatedPath && !samePath(destination.state.sessionFile ?? '', generatedPath)) {
        throw new Error('The destination engine did not open the transferred session')
      }
      const current = await captureHandoffSnapshot(handle)
      assertOpen()
      if (source.info.engine === 'prime' && !this.options.mock) {
        await assertPrimeHandoffIdle(handle)
        assertOpen()
      }
      guard?.assertIdle()
      if (candidate.info.status !== 'ready') {
        throw new Error('The destination engine stopped before the switch could finish')
      }
      if (source.info.busy || !sameHandoffSnapshot(snapshot, current)) {
        throw new Error(
          'The source session changed while switching engines. Try again when it is idle.'
        )
      }
      source.hidden = true
      await this.terminateAgent(source)
      assertOpen()
      this.agents.delete(candidateId)
      candidate.info.agentId = agentId
      candidate.info.createdAt = source.info.createdAt
      candidate.hidden = false
      this.agents.set(agentId, candidate)
      committed = true
      this.hooks.onStatus(agentId, candidate.info.status, { ...candidate.info })
      const startupEvents = candidate.bufferedEvents ?? []
      candidate.bufferedEvents = undefined
      for (const event of startupEvents) {
        // The renderer carries the user's unsent draft across the handoff.
        if (event.type === 'extension_ui_request' && event.method === 'set_editor_text') continue
        this.hooks.onEvent(agentId, event)
      }
      return { ...candidate.info }
    } finally {
      source.switching = false
      source.hidden = false
      let pauseError: unknown
      try {
        await releasePause?.()
      } catch (error) {
        if (!committed && this.agents.get(agentId) === source) pauseError = error
      }
      guard?.release()
      if (!committed) {
        const candidate = this.agents.get(candidateId)
        if (candidate) {
          await this.terminateAgent(candidate)
          this.agents.delete(candidateId)
        }
        if (generatedPath) await rm(generatedPath, { force: true })
      }
      if (pauseError) {
        throw new Error(
          'The source engine could not resume incoming work after the failed switch',
          {
            cause: pauseError
          }
        )
      }
    }
  }

  async dispose(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return
    this.agents.delete(agentId)
    if (agent.hidden) await this.terminateAgent(agent)
    else await this.stopAgent(agent)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.agents.keys()].map((id) => this.dispose(id)))
  }

  async mockPlay(agentId: string, args: MockPlayArgs): Promise<void> {
    if (!this.options.mock) throw new Error('mock:play is only available in mock mode')
    await this.operation(agentId, async (agent) => {
      const handle = agent.handle
      const { MockEngineProcess } = await import('./mock')
      if (!(handle instanceof MockEngineProcess))
        throw new Error('mock:play is only available in mock mode')
      await handle.play(args)
    })
  }

  private locate(): Promise<EngineLocation> {
    return locateEngine(this.options.engineOverridePath())
  }

  /**
   * Start the agent's engine. pi exits at startup when an extension fails to load; if that extension
   * was the bridge, start once more without it so the session still works (bridge features fall back).
   */
  private async startHandle(
    agent: ManagedAgent,
    location: EngineLocation | undefined,
    withBridge: boolean
  ): Promise<void> {
    const { info } = agent
    // N5: disposed while the engine was being located (renderer reload, closed tab): never spawn an orphan.
    if (this.agents.get(info.agentId) !== agent) return
    const bridgePath =
      location && withBridge && !this.bridgeRejectedBy.has(location.version)
        ? this.options.bridgeExtensionPath()
        : null
    let handle: EngineHandle
    if (info.engine === 'prime' && !this.options.mock) {
      const { PrimeEngineProcess } = await import('./prime/process')
      if (this.agents.get(info.agentId) !== agent) return
      handle = new PrimeEngineProcess({
        args: info.args,
        executablePath: this.options.engineOverridePath('prime')
      })
    } else if (location) {
      const promptSources = info.args.conversationPrompt
        ? await this.options.piPromptSources?.(info.args)
        : undefined
      if (this.agents.get(info.agentId) !== agent) return
      handle = new EngineProcess({
        location,
        cwd: info.args.cwd,
        args: buildEngineArgs(info.args, bridgePath, promptSources),
        env: {
          ...(bridgePath ? this.options.bridgeEnv?.() : undefined),
          ...info.args.launch?.env
        }
      })
    } else {
      const { readMockHandoff } = await import('./mock-handoff')
      const history = await readMockHandoff(info.args.sessionPath, info.engine)
      if (info.engine === 'prime') {
        const { PrimeMockEngineProcess } = await import('./prime/mock')
        if (this.agents.get(info.agentId) !== agent) return
        handle = new PrimeMockEngineProcess(info.args, undefined, history)
      } else {
        const { MockEngineProcess } = await import('./mock')
        if (this.agents.get(info.agentId) !== agent) return
        handle = new MockEngineProcess(
          info.args,
          {
            ...this.options.bridgeEnv?.(),
            ...info.args.launch?.env
          },
          history
        )
      }
    }
    agent.handle = handle
    info.status = 'starting'
    info.error = undefined
    this.wire(agent, handle)
    try {
      await handle.start()
      agent.started = true
    } catch (error) {
      if (location && bridgePath && bridgeLoadFailed(handle.stderr())) {
        this.bridgeRejectedBy.add(location.version)
        this.unwire(agent)
        return this.startHandle(agent, location, false)
      }
      // The process may still be running (e.g. get_state answered success:false); never leave it orphaned.
      if (agent.hidden) await this.terminateAgent(agent)
      else await handle.stop(0)
      throw error
    }
    // Disposed during startup: dispose() stopped the handle it saw, but make sure nothing outlives the agent.
    if (this.agents.get(info.agentId) !== agent) {
      this.unwire(agent)
      await handle.stop(0)
      return
    }
    info.pid = handle.pid
    info.nativeAgentId = handle.nativeAgentId
    try {
      await this.refreshSession(agent)
    } catch {
      // The engine is up; session details arrive with the renderer's own refresh.
    }
  }

  private wire(agent: ManagedAgent, handle: EngineHandle): void {
    const { info } = agent
    // Ignore a replaced handle (bridge fallback) and a disposed agent.
    const current = () => this.agents.get(info.agentId) === agent && agent.handle === handle
    agent.unsubscribe.push(
      handle.on('event', (event) => {
        if (!current()) return
        observeRestartDialog(agent.dialogs, event, info.busy)
        if (event.type === 'agent_start') info.busy = true
        else if (event.type === 'agent_settled') info.busy = false
        else if (event.type === 'session_info_changed') info.sessionName = event.name
        else if (event.type === 'engine_native_event' && event.name === 'session_snapshot') {
          const state = asRecord(event.data.state)
          info.busy =
            state.isStreaming === true ||
            state.isCompacting === true ||
            event.data.isBashRunning === true
          info.pid = handle.pid
          info.nativeAgentId = handle.nativeAgentId
          info.sessionFile = absoluteSessionFile(stringValue(state.sessionFile), info.cwd)
          info.sessionId = stringValue(state.sessionId)
          info.sessionName = stringValue(state.sessionName)
          info.lineage = state.lineage as RpcSessionState['lineage']
        }
        if (agent.hidden) agent.bufferedEvents?.push(event)
        else this.hooks.onEvent(info.agentId, event)
      }),
      handle.on('status', (status) => {
        if (!current()) return
        info.status = status
        if (status === 'ready') {
          info.pid = handle.pid
          info.runtime = handle.runtime
        }
        if (status === 'crashed') {
          info.busy = false
          agent.dialogs.clear()
          info.error = handle.error
        }
        if (!agent.hidden) this.hooks.onStatus(info.agentId, status, { ...info })
      }),
      handle.on('exit', (exit) => {
        if (!current()) return
        agent.dialogs.clear()
        if (agent.hidden) return
        this.hooks.onExit({
          agentId: info.agentId,
          ...exit,
          stderrTail: handle.stderr().slice(-4000)
        })
      })
    )
  }

  private unwire(agent: ManagedAgent): void {
    for (const off of agent.unsubscribe) off()
    agent.unsubscribe = []
    agent.dialogs.clear()
  }

  private async stopAgent(agent: ManagedAgent): Promise<void> {
    try {
      await agent.handle?.stop()
    } finally {
      this.unwire(agent)
    }
  }

  private async terminateAgent(agent: ManagedAgent): Promise<void> {
    const handle = agent.handle
    if (
      !agent.terminated &&
      agent.info.engine === 'prime' &&
      handle?.nativeCommand &&
      (agent.started || handle.nativeAgentId)
    ) {
      await handle.nativeCommand('kill')
      agent.terminated = true
      // A successful native kill may remove the session before its client can detach.
      await this.stopAgent(agent).catch(() => undefined)
    } else {
      await this.stopAgent(agent)
    }
  }

  private async resolveSwitchSelection(args: CreateAgentArgs, candidateId: string): Promise<void> {
    if (args.provider && args.model && args.thinking !== undefined) return
    await this.create({ ...args, noSession: true }, candidateId, undefined, true)
    const candidate = this.require(candidateId)
    if (candidate.info.status !== 'ready') {
      throw new Error(candidate.info.error ?? 'The destination engine could not select a model')
    }
    const { state } = await captureHandoffSnapshot(this.requireHandle(candidate))
    if (!state.model) throw new Error('Choose a model for the destination engine before switching')
    args.provider = state.model.provider
    args.model = state.model.id
    args.thinking = state.thinkingLevel
    await this.terminateAgent(candidate)
    this.agents.delete(candidateId)
  }

  private async refreshSession(agent: ManagedAgent): Promise<void> {
    const handle = this.requireHandle(agent)
    agent.info.nativeAgentId = handle.nativeAgentId
    agent.info.runtime = handle.runtime
    const initialState = handle.consumeInitialState?.() ?? null
    // Each answer applies on its own: a command list that times out under load must not discard the
    // session file the state reported.
    const replies = await Promise.allSettled([
      initialState
        ? Promise.resolve<RpcResponse>({
            type: 'response',
            command: 'get_state',
            success: true,
            data: initialState
          })
        : handle.send({ type: 'get_state' }),
      handle.send({ type: 'get_commands' })
    ])
    const [state, commands] = replies.map((reply) =>
      reply.status === 'fulfilled' ? reply.value : undefined
    )
    if (state?.success && state.command === 'get_state') {
      agent.info.sessionFile = absoluteSessionFile(state.data.sessionFile, agent.info.cwd)
      agent.info.sessionId = state.data.sessionId
      agent.info.sessionName = state.data.sessionName
      agent.info.lineage = state.data.lineage
    }
    if (commands?.success && commands.command === 'get_commands') {
      agent.info.bridge =
        agent.info.engine === 'prime' ? !!handle.bridge : hasBridgeCommands(commands.data.commands)
    }
    for (const reply of replies) if (reply.status === 'rejected') throw reply.reason
  }

  private require(agentId: string): ManagedAgent {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    return agent
  }

  /** The agent, unless a restart or engine switch is replacing its engine. */
  private admit(agentId: string): ManagedAgent {
    const agent = this.require(agentId)
    if (agent.switching) throw new Error('Wait for the engine switch to finish')
    if (agent.restarting) throw new Error('Wait for the engine restart to finish')
    return agent
  }

  private async operation<Result>(
    agentId: string,
    run: (agent: ManagedAgent) => Promise<Result>
  ): Promise<Result> {
    const agent = this.admit(agentId)
    agent.operations++
    try {
      return await run(agent)
    } finally {
      agent.operations--
    }
  }

  private requireHandle(agent: ManagedAgent): EngineHandle {
    if (!agent.handle) throw new Error(agent.info.error ?? 'Engine is not running')
    return agent.handle
  }
}
