import { setTimeout as delay } from 'node:timers/promises'
import type {
  BridgeRequest,
  BridgeResult,
  BridgeToolsState,
  CreateAgentArgs,
  EngineRuntimeInfo,
  EngineStatus
} from '@shared/api/engine'
import type {
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcResponseDataMap,
  RpcSessionState
} from '@shared/engine-types'
import {
  Emitter,
  defaultTimeout,
  type EngineHandle,
  type EngineHandleEvents,
  type SendOptions
} from '../handle'
import {
  attachPrimeResident,
  connectPrimeDaemon,
  connectPrimeResident,
  preparePrimeSessionDirectory,
  type PrimeDaemonClient
} from './daemon'
import { PrimeEventAdapter } from './events'
import { PrimeBashRunner } from './bash'
import {
  normalizeMessage,
  normalizeResponse,
  normalizeState,
  normalizeTree,
  resolveStateModel,
  sanitizeNativeModels,
  thinkingLevel
} from './normalize'
import { asRecord, asRecords, PrimeCommandError, stringValue, type PrimeRecord } from './transport'
import { forkPrimeSession, primeCreatePayload } from './sessions'
import { primeRestartSelection, restartPrimeSession } from './restart'
import { PrimeSpeedControl } from './speed'
import { samePath } from '../../paths'
import { locatePrimeEngine } from './locate'
import { guardPrimeHandoff } from './daemon-activity'
import { PrimeSessionLineage } from './session-lineage'
import { callPrimeBridge } from './bridge'

export interface PrimeEngineProcessOptions {
  args: CreateAgentArgs
  executablePath?: string | null
  agentDir?: string
}

const ATTACH_CAPABILITIES = ['attach_snapshot', 'event_sequence', 'slim_attach']
const RESIDENT_COMMANDS = new Set([
  'list',
  'list_saved_sessions',
  'rename_saved_session',
  'delete_saved_session',
  'send_message',
  'roster_subscribe',
  'roster_unsubscribe',
  'heartbeats_list'
])
const SESSION_REPLACEMENTS = new Set(['new_session', 'switch_session', 'fork', 'import_jsonl'])

export class PrimeEngineProcess extends Emitter<EngineHandleEvents> implements EngineHandle {
  private client: PrimeDaemonClient | undefined
  private activeSessionId: string | undefined
  private currentStatus: EngineStatus = 'starting'
  private lastError: string | undefined
  private state: PrimeRecord = {}
  private initialState: RpcSessionState | null = null
  private selectedVersion: string | undefined
  private cursor: PrimeRecord | undefined
  private unsubscribers: Array<() => void> = []
  private stopping = false
  private reconnecting: Promise<void> | undefined
  private settleCheck: Promise<void> | undefined
  private attachment: Promise<void> | undefined
  private deferredFrames: PrimeRecord[] = []
  private startup: Promise<void> | undefined
  private stopTask: Promise<void> | undefined
  private restartTask: Promise<CreateAgentArgs | void> | undefined
  private restarting = false
  private retired = false
  private ownsSession = false
  private args: CreateAgentArgs
  private readonly sessionLineage = new PrimeSessionLineage()
  private readonly eventAdapter = new PrimeEventAdapter((event) => this.emit('event', event))
  private readonly bashRunner = new PrimeBashRunner((event) => this.emit('event', event))
  private readonly speedControl = new PrimeSpeedControl((type, payload) =>
    this.nativeCommand(type, payload)
  )

  constructor(private readonly options: PrimeEngineProcessOptions) {
    super()
    this.args = { ...options.args }
  }

  get pid(): number | undefined {
    const candidate = this.state.workerPid ?? this.client?.hello.supervisorPid
    return typeof candidate === 'number' ? candidate : undefined
  }

  get nativeAgentId(): string | undefined {
    return this.activeSessionId
  }

  get runtime(): EngineRuntimeInfo | undefined {
    if (!this.client) return undefined
    return {
      version: stringValue(this.client.hello.appVersion) ?? this.client.location.version,
      selectedVersion: this.selectedVersion
    }
  }

  get status(): EngineStatus {
    return this.currentStatus
  }

  get error(): string | undefined {
    return this.lastError
  }

  consumeInitialState(): RpcSessionState | null {
    const state = this.initialState
    this.initialState = null
    return state
  }

  start(): Promise<void> {
    this.startup ??= this.initialize()
    return this.startup
  }

  guardHandoff(): { assertIdle(): void; release(): void } {
    const client = this.requireClient()
    const guard = guardPrimeHandoff(client.socketPath)
    return {
      assertIdle: () => {
        if (this.client !== client || !client.connected) {
          throw new Error('The source engine reconnected during the switch. Try again.')
        }
        guard.assertIdle()
      },
      release: guard.release
    }
  }

  private async initialize(): Promise<void> {
    try {
      const requested = this.args
      const args = requested.forkFrom
        ? {
            ...requested,
            sessionPath: await forkPrimeSession(
              requested.forkFrom,
              requested.cwd,
              requested.sessionDir
            ),
            forkFrom: undefined,
            nativeAgentId: undefined
          }
        : { ...requested }
      if (!args.noSession) {
        args.sessionDir = await preparePrimeSessionDirectory(
          args.cwd,
          { ...this.options, env: args.launch?.env },
          args.sessionDir,
          args.sessionPath
        )
      }
      this.args = args
      if (this.stopping) return
      await this.openConnection()
      if (this.stopping) return
      const client = this.requireClient()
      let recoveringResident: PrimeCommandError | undefined
      this.activeSessionId ??= args.nativeAgentId
      if (!this.activeSessionId && args.sessionPath) {
        const resident = await client.request('list', { all: false, includeClientOwned: true })
        const sessions = asRecords(resident.sessions ?? resident.agents)
        const matching = sessions.find(
          (session) =>
            typeof session.sessionFile === 'string' &&
            samePath(session.sessionFile, args.sessionPath!)
        )
        this.activeSessionId = stringValue(matching?.activeSessionId) ?? stringValue(matching?.id)
      }
      if (this.stopping) return
      if (!this.activeSessionId) {
        try {
          const created = await client.request('create', primeCreatePayload(args), 0)
          this.activeSessionId = stringValue(created.activeSessionId) ?? stringValue(created.id)
          this.state = created
          this.ownsSession = args.noSession === true
        } catch (error) {
          if (
            !(error instanceof PrimeCommandError) ||
            error.details.code !== 'session_already_active'
          ) {
            throw error
          }
          this.activeSessionId = stringValue(error.details.activeSessionId)
          recoveringResident = error
        }
      }
      if (this.stopping) return
      if (!this.activeSessionId) throw new Error('Engine 2 did not return a session identity')
      await this.attach(recoveringResident).catch((error: unknown) => {
        if (!this.reconnecting) throw error
      })
      await this.reconnecting
      if (this.stopping || this.currentStatus === 'ready') return
      if (this.currentStatus === 'crashed') throw new Error(this.lastError)
      this.setStatus('ready')
    } catch (error) {
      if (this.stopping) return
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setStatus('crashed')
      this.client?.close()
      throw error
    }
  }

  async send(command: RpcCommand, options: SendOptions = {}): Promise<RpcResponse> {
    try {
      const data = await this.execute(command, options.timeoutMs ?? defaultTimeout(command.type))
      // The command-indexed data union is normalized at this native protocol boundary.
      return {
        id: command.id,
        type: 'response',
        command: command.type,
        success: true,
        data
      } as RpcResponse
    } catch (error) {
      return {
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  respondUi(_response: RpcExtensionUIResponse): void {
    throw new Error('Engine 2 does not use extension dialogs')
  }

  stop(): Promise<void> {
    this.stopTask ??= this.finishStopping()
    return this.stopTask
  }

  prepareRestart(
    nextArgs: CreateAgentArgs,
    executablePath?: string | null,
    patch?: Partial<CreateAgentArgs>
  ): Promise<CreateAgentArgs | void> {
    this.restartTask ??= this.restartSession(nextArgs, executablePath, patch)
    return this.restartTask
  }

  private async restartSession(
    nextArgs: CreateAgentArgs,
    executablePath?: string | null,
    patch?: Partial<CreateAgentArgs>
  ): Promise<CreateAgentArgs | void> {
    if (this.stopping) throw new Error('This Engine 2 session is closing')
    if (this.reconnecting)
      throw new Error('Engine 2 is reconnecting. Try restarting again shortly.')
    this.restarting = true
    let recoveredConnection = false
    try {
      await this.startup
      let client = this.requireClient()
      if (this.currentStatus === 'crashed' || this.currentStatus === 'exited') {
        const sessionPath = nextArgs.sessionPath ?? this.args.sessionPath
        if (!sessionPath || this.args.noSession) {
          throw new Error('Temporary sessions cannot be restarted; start a new session instead.')
        }
        if (!client.launchEnvironmentKnown) {
          throw new Error('Engine 2 cannot recover this resident’s launch environment.')
        }
        // This lookup honors recovery quarantine before any saved-history worker can be created.
        const resident = await connectPrimeResident(
          { sessionPath },
          { ...this.options, env: client.launchEnv }
        )
        this.unwire()
        client.close()
        if (!resident) {
          this.retired = true
          this.client = undefined
          return {
            ...nextArgs,
            nativeAgentId: undefined,
            sessionPath,
            launch: {
              ...nextArgs.launch,
              env: { ...client.launchEnv, ...nextArgs.launch?.env }
            }
          }
        }
        client = resident.client
        this.client = client
        this.activeSessionId = resident.nativeAgentId
        recoveredConnection = true
      }
      if (!this.activeSessionId) throw new Error('Engine 2 has no active session to restart')
      const state = await this.nativeCommand('get_state')
      const previousArgs = primeRestartSelection(this.args, this.args, state)
      nextArgs = primeRestartSelection(this.args, nextArgs, state, patch)
      await restartPrimeSession(
        client,
        this.activeSessionId,
        previousArgs,
        nextArgs,
        executablePath,
        patch
      )
      this.retired = true
      this.unwire()
      client.close()
      this.client = undefined
      return nextArgs
    } catch (error) {
      if (!this.stopping && (recoveredConnection || !this.client?.connected)) {
        this.unwire()
        this.client?.close()
        try {
          await this.openConnection(true)
          await this.attach()
          this.setStatus('ready')
        } catch (restoreError) {
          this.crash(restoreError)
        }
      }
      throw error
    } finally {
      this.restarting = false
      this.restartTask = undefined
    }
  }

  private async finishStopping(): Promise<void> {
    this.stopping = true
    this.setStatus('stopping')
    await this.startup?.catch(() => undefined)
    await this.restartTask?.catch(() => undefined)
    const client = this.client
    try {
      if (client?.connected && this.activeSessionId && !this.retired) {
        if (this.ownsSession) {
          await client.request('abort', { activeSessionId: this.activeSessionId })
          await client.request('complete_owned_session', { activeSessionId: this.activeSessionId })
        } else {
          await client.request('detach', { activeSessionId: this.activeSessionId })
        }
      }
    } finally {
      this.unwire()
      client?.close()
      this.client = undefined
      this.setStatus('exited')
      this.emit('exit', { code: 0, signal: null, expected: true })
    }
  }

  stderr(): string {
    return this.client?.stderr() ?? this.lastError ?? ''
  }

  async nativeCommand(type: string, payload: PrimeRecord = {}): Promise<PrimeRecord> {
    const command = type === 'get_state' ? 'get_connection_state' : type
    const client = this.requireClient()
    const sessionId = this.activeSessionId
    const result = sanitizeNativeModels(await this.request(command, payload))
    if (
      command === 'promote_owned_session' ||
      (command === 'heartbeat_set' && payload.promoteOwnedSession === true)
    ) {
      this.ownsSession = false
      this.args.noSession = false
    }
    if (command === 'get_connection_state') {
      const state = await resolveStateModel(result, () =>
        client.request('get_model_catalog', { activeSessionId: sessionId })
      )
      if (!client.connected || this.client !== client || this.activeSessionId !== sessionId) {
        throw new Error('The Engine 2 session changed while reading its state. Try again.')
      }
      this.state = { ...this.state, ...state }
      return state
    }
    if (SESSION_REPLACEMENTS.has(command)) await this.attach()
    return result
  }

  async bridge(request: BridgeRequest): Promise<BridgeResult> {
    return callPrimeBridge(
      request,
      this.nativeCommand.bind(this),
      this.toolState.bind(this),
      this.speedControl.read.bind(this.speedControl)
    )
  }

  private async execute(
    command: RpcCommand,
    timeoutMs: number
  ): Promise<RpcResponseDataMap[RpcCommand['type']]> {
    const { id: _id, type, ...payload } = command
    if (type !== 'get_commands') this.initialState = null
    if (type === 'get_state') {
      const state = await this.nativeCommand('get_state')
      return this.sessionLineage.apply(normalizeState(this.state, state))
    }
    if (type === 'get_available_thinking_levels') {
      const state = await this.nativeCommand('get_state')
      const levels = Array.isArray(state.availableThinkingLevels)
        ? state.availableThinkingLevels
        : ['off']
      return { levels: levels.map(thinkingLevel) }
    }
    if (type === 'get_tree' || type === 'get_entries' || type === 'clone') {
      const tree = normalizeTree(await this.request('get_session_tree'))
      if (type === 'get_tree') return tree
      if (type === 'get_entries') {
        const entries = tree.nodes.map((node) => node.entry)
        const since = command.since ? entries.findIndex((entry) => entry.id === command.since) : -1
        return { entries: entries.slice(since + 1), leafId: tree.leafId }
      }
      if (!tree.leafId) throw new Error('This session has no entry to clone')
      const result = await this.nativeCommand('fork', { entryId: tree.leafId, position: 'at' })
      return { cancelled: result.cancelled === true }
    }
    if (type === 'abort') return this.abort(timeoutMs)
    if (command.type === 'bash') {
      return this.bashRunner.run(command, this.request.bind(this), timeoutMs)
    }
    const nativeType = type === 'get_fork_messages' ? 'get_user_messages_for_forking' : type
    const result = await this.request(nativeType, payload, timeoutMs)
    if (SESSION_REPLACEMENTS.has(nativeType)) await this.attach()
    return normalizeResponse(
      type,
      result,
      stringValue(this.state.sessionFile),
      stringValue(this.state.sessionId)
    )
  }

  private async abort(timeoutMs: number): Promise<RpcResponseDataMap['abort']> {
    const client = this.requireClient()
    const session = { activeSessionId: this.activeSessionId }
    this.eventAdapter.markAborted()
    await client.request('abort', session, timeoutMs)
    const settleTimeoutMs = timeoutMs > 0 ? timeoutMs : 30_000
    const pollIntervalMs = 25
    const deadline = Date.now() + settleTimeoutMs
    // Native abort parks the queue immediately but acknowledges before its current turn settles.
    while (true) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) throw new Error('Engine 2 is still stopping its current turn')
      const state = await client.request('get_connection_state', session, remainingMs)
      if (state.isStreaming === false && state.isCompacting === false) {
        this.eventAdapter.settle()
        return undefined
      }
      await delay(pollIntervalMs)
    }
  }

  private request(type: string, payload: PrimeRecord = {}, timeoutMs = 0): Promise<PrimeRecord> {
    const session = RESIDENT_COMMANDS.has(type)
      ? {}
      : {
          activeSessionId:
            type === 'heartbeat_manage'
              ? (payload.activeSessionId ?? this.activeSessionId)
              : this.activeSessionId
        }
    const admission =
      type === 'prompt' || type === 'prompt_and_wait'
        ? { streamingBehavior: payload.streamingBehavior ?? 'followUp' }
        : {}
    return this.requireClient().request(type, { ...payload, ...session, ...admission }, timeoutMs)
  }

  private attach(recoveringResident?: PrimeCommandError): Promise<void> {
    if (this.attachment) return this.attachment
    const client = this.requireClient()
    const sessionId = this.activeSessionId
    const pending = attachPrimeResident(
      client,
      {
        activeSessionId: sessionId,
        capabilities: ATTACH_CAPABILITIES,
        resumeCursor: this.cursor
      },
      recoveringResident,
      () => this.stopping
    ).then(async (attached) => {
      if (!client.connected || this.client !== client || this.activeSessionId !== sessionId) return
      await this.applySnapshot(asRecord(attached.snapshot), attached.lastEventCursor)
    })
    return this.holdFrames(pending)
  }

  private holdFrames(pending: Promise<void>): Promise<void> {
    const held = pending.finally(() => {
      if (this.attachment !== held) return
      this.attachment = undefined
      const frames = this.deferredFrames
      this.deferredFrames = []
      for (const frame of frames) {
        if (frame.type === 'session_event') {
          const cursor = asRecord(asRecord(frame.meta).cursor)
          if (
            cursor.generation === this.cursor?.generation &&
            typeof cursor.sequence === 'number' &&
            typeof this.cursor?.sequence === 'number' &&
            cursor.sequence <= this.cursor.sequence
          )
            continue
        }
        this.onFrame(frame)
      }
    })
    this.attachment = held
    return held
  }

  private async applySnapshot(snapshot: PrimeRecord, cursor?: unknown): Promise<boolean> {
    const client = this.requireClient()
    const sessionId = this.activeSessionId
    const incoming = { ...asRecord(snapshot.summary), ...asRecord(snapshot.state) }
    const state = await resolveStateModel({ ...this.state, ...incoming }, () =>
      client.request('get_model_catalog', { activeSessionId: sessionId })
    )
    await this.sessionLineage.load(stringValue(state.sessionFile), incoming.rlmDepth)
    if (
      this.stopping ||
      !client.connected ||
      this.client !== client ||
      this.activeSessionId !== sessionId
    )
      return false
    this.speedControl.reset()
    this.state = state
    this.args = {
      ...this.args,
      nativeAgentId: this.activeSessionId,
      sessionPath: stringValue(this.state.sessionFile)
    }
    const normalizedState = this.sessionLineage.apply(normalizeState(this.state, {}))
    if (this.currentStatus !== 'ready') {
      this.initialState = normalizedState
    }
    const incomingCursor = cursor ?? snapshot.lastEventCursor
    if (incomingCursor) this.cursor = asRecord(incomingCursor)
    if (!Array.isArray(snapshot.messages)) return true
    const messages = snapshot.messages.map(normalizeMessage)
    this.eventAdapter.restore(this.state, messages)
    const actions = asRecord(this.state.sessionActions)
    this.emit('event', {
      type: 'engine_native_event',
      engine: 'prime',
      name: 'session_snapshot',
      data: {
        messages,
        state: normalizedState,
        cursor: this.cursor,
        steering: Array.isArray(actions.steering) ? actions.steering : [],
        followUp: Array.isArray(actions.followUps) ? actions.followUps : [],
        isBashRunning: this.state.isBashRunning === true
      }
    })
    return true
  }

  private async openConnection(existingOnly = false): Promise<void> {
    const options = {
      ...this.options,
      env: this.args.launch?.env
    }
    const resident = await connectPrimeResident(
      {
        nativeAgentId: this.activeSessionId ?? this.args.nativeAgentId,
        sessionPath: this.args.sessionPath
      },
      options
    )
    if (resident) {
      this.client = resident.client
      this.activeSessionId = resident.nativeAgentId
    } else {
      if (existingOnly) throw new Error('Engine 2 could not reconnect to a running resident')
      this.client = await connectPrimeDaemon(options)
    }
    const selected = await locatePrimeEngine(this.options.executablePath).catch(() => undefined)
    this.selectedVersion = selected?.version
    this.unsubscribers.push(
      this.client.on('event', (frame) => this.onFrame(frame)),
      this.client.on('close', (event) => {
        if (!this.stopping && !this.restarting && !event.expected) void this.reconnect(event.error)
      })
    )
  }

  private onFrame(frame: PrimeRecord): void {
    if (this.attachment) {
      this.deferredFrames.push(frame)
      return
    }
    if (
      frame.type === 'session_binding' &&
      frame.previousActiveSessionId === this.activeSessionId
    ) {
      this.activeSessionId = stringValue(frame.activeSessionId)
      this.args = { ...this.args, nativeAgentId: this.activeSessionId, sessionPath: undefined }
      this.cursor = undefined
      void this.attach().catch((error: unknown) => this.crash(error))
      return
    }
    if (frame.activeSessionId && frame.activeSessionId !== this.activeSessionId) return
    if (frame.type === 'session_event') {
      const metadata = asRecord(frame.meta)
      if (metadata.cursor) this.cursor = asRecord(metadata.cursor)
      const event = asRecord(frame.event)
      this.speedControl.accept(event)
      this.bashRunner.accept(event)
      this.eventAdapter.accept(event)
      if (event.type === 'agent_end' && !this.settleCheck) {
        this.settleCheck = this.request('wait_for_idle')
          .then(() => this.eventAdapter.settle())
          .catch((error: unknown) => {
            if (!this.stopping) this.crash(error)
          })
          .finally(() => {
            this.settleCheck = undefined
          })
      }
      return
    }
    if (frame.type === 'session_replaced' || frame.type === 'session_resynced') {
      const snapshot = asRecord(frame.snapshot)
      const pending = this.applySnapshot(
        Object.keys(snapshot).length ? snapshot : frame,
        asRecord(frame.meta).cursor
      ).then((applied) => {
        if (applied) this.emitNativeFrame(frame)
      })
      void this.holdFrames(pending).catch((error: unknown) => this.crash(error))
      return
    }
    if (frame.type === 'session_closed') {
      if (this.restarting) return
      this.eventAdapter.settle()
      this.setStatus('exited')
      this.unwire()
      this.client?.closeWhenIdle()
      this.emit('exit', { code: 0, signal: null, expected: true })
    }
    this.emitNativeFrame(frame)
  }

  private emitNativeFrame(frame: PrimeRecord): void {
    this.emit('event', {
      type: 'engine_native_event',
      engine: 'prime',
      name: String(frame.type),
      data: sanitizeNativeModels(frame)
    })
  }

  private reconnect(error?: string): Promise<void> {
    if (this.stopping || this.restarting) return Promise.resolve()
    this.reconnecting ??= this.reconnectSession(error).finally(() => {
      this.reconnecting = undefined
    })
    return this.reconnecting
  }

  private async reconnectSession(error?: string): Promise<void> {
    this.unwire()
    this.setStatus('starting')
    try {
      await this.openConnection()
      if (this.stopping) {
        this.unwire()
        this.client?.close()
        return
      }
      await this.attach()
      if (!this.client?.connected) throw new Error('Engine 2 disconnected while reattaching')
      this.lastError = undefined
      this.setStatus('ready')
    } catch (failure) {
      this.crash(failure ?? error)
    }
  }

  private async toolState(): Promise<BridgeToolsState> {
    const state = await this.nativeCommand('get_state')
    const active = Array.isArray(state.activeToolNames)
      ? state.activeToolNames.filter((name): name is string => typeof name === 'string')
      : []
    if (active.length === 0) {
      await this.nativeCommand('get_system_prompt')
      // The native desktop runtime exposes Python; shell, editing, and connections run through it.
      active.push('ipython')
    }
    const tools = await Promise.all(
      active.map(async (name) => {
        const response = await this.nativeCommand('get_tool_definition', { name })
        const definition = asRecord(response.toolDefinition)
        if (typeof definition.name !== 'string') return null
        return {
          name,
          description: stringValue(definition.description) ?? '',
          exposure: 'direct' as const,
          sourceInfo: {
            path: '',
            source: 'Engine 2',
            scope: 'user' as const,
            origin: 'top-level' as const
          }
        }
      })
    )
    const available = tools.filter((tool): tool is NonNullable<typeof tool> => tool !== null)
    return { active: available.map((tool) => tool.name), tools: available }
  }

  private requireClient(): PrimeDaemonClient {
    if (!this.client) throw new Error('Engine 2 is not connected')
    return this.client
  }

  private setStatus(status: EngineStatus): void {
    this.currentStatus = status
    this.emit('status', status)
  }

  private crash(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error)
    this.setStatus('crashed')
    this.emit('exit', { code: null, signal: null, expected: false })
  }

  private unwire(): void {
    this.attachment = undefined
    this.deferredFrames = []
    this.bashRunner.disconnect()
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
  }
}
