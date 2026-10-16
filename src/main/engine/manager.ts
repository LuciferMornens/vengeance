import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  hasBridgeCommands,
  normalizeEngineId,
  type AgentInfo,
  type BridgeCallOptions,
  type BridgeRequest,
  type BridgeResult,
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
  RpcSuccessResponse
} from '@shared/engine-types'
import type { SubagentInspectReply, SubagentInspectRequest } from '@shared/subagents'
import { bridgeLoadFailed, bridgeTimeout, callBridge } from './bridge'
import type { EngineHandle } from './handle'
import { locateEngine, type EngineLocation } from './locate'
import { MockEngineProcess } from './mock'
import { EngineProcess } from './rpc-process'
import { PrimeMockEngineProcess } from './prime/mock'
import { asRecord, stringValue } from './prime/transport'
import { requestSessionTree } from './session-tree'
import { inspectSubagent } from './subagents-inspect'

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
}

const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * The engine reports `sessionFile` as configured, so a relative `sessionDir` (project `.pi/settings.json`) gives a
 * path relative to the engine's working folder. Everything in the app keys sessions by absolute path.
 */
function absoluteSessionFile(sessionFile: string | undefined, cwd: string): string | undefined {
  return sessionFile && !isAbsolute(sessionFile) ? resolve(cwd, sessionFile) : sessionFile
}

/** A `get_state` / `get_session_stats` reply with its `sessionFile` made absolute (see `absoluteSessionFile`). */
export function withAbsoluteSessionFile(response: RpcResponse, cwd: string): RpcResponse {
  if (!response.success) return response
  if (response.command === 'get_state') {
    return {
      ...response,
      data: { ...response.data, sessionFile: absoluteSessionFile(response.data.sessionFile, cwd) }
    }
  }
  if (response.command === 'get_session_stats') {
    return {
      ...response,
      data: { ...response.data, sessionFile: absoluteSessionFile(response.data.sessionFile, cwd) }
    }
  }
  return response
}

/** Build pi CLI args (after `--mode rpc`) from session options, loading the bridge extension when given. */
export function buildEngineArgs(
  args: CreateAgentArgs,
  bridgeExtensionPath: string | null = null
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
  out.push(...launchOptionsToArgs(args.launch))
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
    return [...this.agents.values()].map((a) => ({ ...a.info }))
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
    location?: EngineLocation
  ): Promise<AgentInfo> {
    if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id ${agentId}`)
    if (this.agents.has(agentId)) throw new Error(`Agent ${agentId} already exists`)
    const engine = normalizeEngineId(args.engine)
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
    const agent: ManagedAgent = { info, handle: null, unsubscribe: [] }
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
      if (this.agents.get(agentId) === agent) this.hooks.onStatus(agentId, info.status, { ...info })
    }
    return { ...info }
  }

  async command(agentId: string, command: RpcCommand): Promise<RpcResponse> {
    const agent = this.require(agentId)
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
    const agent = this.require(agentId)
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
    const agent = this.require(agentId)
    if (agent.info.engine !== 'pi') {
      throw new Error('Use this engine’s native agent controls to inspect a child session')
    }
    return inspectSubagent(this.requireHandle(agent), request)
  }

  async nativeCommand(
    agentId: string,
    type: string,
    payload?: Record<string, unknown>
  ): Promise<unknown> {
    const agent = this.require(agentId)
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
    this.require(agentId).handle?.respondUi(response)
  }

  stderr(agentId: string): string {
    return this.require(agentId).handle?.stderr() ?? ''
  }

  /** Restart with the same args (resuming the session file); `patch` keys, even undefined ones, replace stored args. */
  async restart(agentId: string, patch?: Partial<CreateAgentArgs>): Promise<AgentInfo> {
    const agent = this.require(agentId)
    if (agent.restarting) throw new Error('This engine is already restarting')
    agent.restarting = true
    const assertOpen = (): void => {
      if (this.agents.get(agentId) !== agent) throw new Error('This session is no longer open')
    }
    try {
      // Locate first: when the engine cannot be found, keep the current process instead of killing it.
      if (patch?.engine !== undefined && patch.engine !== agent.info.engine) {
        throw new Error('Choose a different engine when creating a new session')
      }
      const location =
        this.options.mock || agent.info.engine === 'prime' ? undefined : await this.locate()
      if (!this.options.mock && agent.info.engine === 'prime') {
        // Imported on use: prime/locate needs Electron's `app`, and the Node checks load this module (Vite's
        // "also statically imported" warning about it is expected).
        const { primeEngineInfo } = await import('./prime/locate')
        const details = await primeEngineInfo(this.options.engineOverridePath('prime'))
        if (!details.found) throw new Error(details.error ?? 'Engine 2 could not be found')
      }
      assertOpen()
      const resume = agent.info.sessionFile
      const stored: CreateAgentArgs = {
        ...agent.info.args,
        ...patch,
        cwd: agent.info.args.cwd,
        engine: agent.info.engine
      }
      let args: CreateAgentArgs = resume
        ? { ...stored, sessionPath: resume, forkFrom: undefined, noSession: undefined }
        : stored
      // A failed startup already released its client; retry creation and native resident lookup.
      if (agent.started) {
        const prepared = await agent.handle?.prepareRestart?.(
          args,
          this.options.engineOverridePath(agent.info.engine)
        )
        if (prepared) args = prepared
      }
      assertOpen()
      await this.stopAgent(agent)
      assertOpen()
      this.agents.delete(agentId)
      return await this.create(args, agentId, location)
    } finally {
      agent.restarting = false
    }
  }

  async dispose(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return
    this.agents.delete(agentId)
    await this.stopAgent(agent)
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled([...this.agents.keys()].map((id) => this.dispose(id)))
  }

  async mockPlay(agentId: string, args: MockPlayArgs): Promise<void> {
    const handle = this.require(agentId).handle
    if (!(handle instanceof MockEngineProcess))
      throw new Error('mock:play is only available in mock mode')
    await handle.play(args)
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
    } else {
      handle = location
        ? new EngineProcess({
            location,
            cwd: info.args.cwd,
            args: buildEngineArgs(info.args, bridgePath),
            env: {
              ...(bridgePath ? this.options.bridgeEnv?.() : undefined),
              ...info.args.launch?.env
            }
          })
        : info.engine === 'prime'
          ? new PrimeMockEngineProcess(info.args)
          : new MockEngineProcess(info.args, {
              ...this.options.bridgeEnv?.(),
              ...info.args.launch?.env
            })
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
      await handle.stop(0)
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
        }
        this.hooks.onEvent(info.agentId, event)
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
          info.error = handle.error
        }
        this.hooks.onStatus(info.agentId, status, { ...info })
      }),
      handle.on('exit', (exit) => {
        if (!current()) return
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
  }

  private async stopAgent(agent: ManagedAgent): Promise<void> {
    try {
      await agent.handle?.stop()
    } finally {
      this.unwire(agent)
    }
  }

  private async refreshSession(agent: ManagedAgent): Promise<void> {
    const handle = this.requireHandle(agent)
    agent.info.nativeAgentId = handle.nativeAgentId
    agent.info.runtime = handle.runtime
    const [state, commands] = await Promise.all([
      handle.send({ type: 'get_state' }),
      handle.send({ type: 'get_commands' })
    ])
    if (state.success && state.command === 'get_state') {
      agent.info.sessionFile = absoluteSessionFile(state.data.sessionFile, agent.info.cwd)
      agent.info.sessionId = state.data.sessionId
      agent.info.sessionName = state.data.sessionName
    }
    if (commands.success && commands.command === 'get_commands') {
      agent.info.bridge =
        agent.info.engine === 'prime' ? !!handle.bridge : hasBridgeCommands(commands.data.commands)
    }
  }

  private require(agentId: string): ManagedAgent {
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Unknown agent ${agentId}`)
    return agent
  }

  private requireHandle(agent: ManagedAgent): EngineHandle {
    if (!agent.handle) throw new Error(agent.info.error ?? 'Engine is not running')
    return agent.handle
  }
}
