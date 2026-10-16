import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { BackgroundAgentInfo } from '@shared/api/engine'
import { getPrimeAgentDir, locatePrimeEngine, type PrimeEngineLocation } from './locate'
import { expandPrimePath } from './configuration-store'
import { resolvePrimeSessionRoot } from './session-paths'
import {
  primeEnvironmentHash,
  restorePrimeDaemonEnvironment,
  validatePrimeDaemonEnvironment
} from './daemon-environment'
import { rememberedDaemons, rememberDaemon, rememberRestartFailure } from './daemon-registry'
import { PrimeDaemonActivity } from './daemon-activity'
import {
  asRecords,
  stringValue,
  PrimeCommandError,
  PrimeTransport,
  type PrimeRecord
} from './transport'

interface ManagedDaemon {
  location: PrimeEngineLocation
  agentDir: string
  env: Record<string, string>
  environmentKnown: boolean
  child?: ChildProcess
  stderr: string
  started: Promise<void>
}

export interface PrimeDaemonOptions {
  executablePath?: string | null
  agentDir?: string
  env?: Record<string, string>
}

export interface PrimeServiceOptions extends PrimeDaemonOptions {
  noSession?: boolean
  sessionDir?: string
  persistSession?: boolean
  requireOwnedSession?: boolean
}

export class PrimeDaemonStartupError extends Error {
  readonly replacementMayBeRunning = true

  constructor(
    message: string,
    readonly supervisorPid: number,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

const daemons = new Map<string, ManagedDaemon>()
const serviceSessions = new Set<string>()
const restartBarriers = new Map<string, Promise<void>>()
const restartFailures = new Map<string, { error: Error; sessions?: PrimeRecord[] }>()
const DAEMON_START_TIMEOUT_MS = 30_000
const DAEMON_RETRY_MS = 100
const STDERR_LIMIT = 64 * 1024

export async function preparePrimeSessionDirectory(
  cwd: string,
  options: PrimeDaemonOptions,
  sessionDir?: string,
  sessionPath?: string
): Promise<string> {
  const directory = sessionDir
    ? expandPrimePath(sessionDir, cwd)
    : await resolvePrimeSessionRoot(cwd, options)
  // Native Windows leases canonicalize the parent before the first session file exists.
  await mkdir(sessionPath ? dirname(resolve(cwd, sessionPath)) : directory, { recursive: true })
  return directory
}

export function primeDaemonSocketPath(
  agentDir: string,
  location: PrimeEngineLocation,
  env: Record<string, string> = {}
): string {
  const identity = createHash('sha256')
    .update(resolve(agentDir))
    .update(location.executablePath)
    .update(
      JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)))
    )
    .digest('hex')
    .slice(0, 20)
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vengeance-engine2-${identity}`
    : join(tmpdir(), `vengeance-engine2-${identity}.sock`)
}

export function isPrimeServiceSession(nativeAgentId: string): boolean {
  return serviceSessions.has(nativeAgentId)
}

async function probe(socketPath: string): Promise<PrimeTransport | null> {
  const transport = new PrimeTransport(socketPath)
  try {
    await transport.connect(2_000)
    return transport
  } catch {
    transport.close()
    return null
  }
}

async function startDaemon(
  location: PrimeEngineLocation,
  agentDir: string,
  socketPath: string,
  managed: ManagedDaemon,
  env: Record<string, string>,
  rosterPath?: string
): Promise<void> {
  await mkdir(agentDir, { recursive: true })
  const child = spawn(
    location.executablePath,
    ['--mode', 'daemon', '--daemon-socket', socketPath],
    {
      cwd: location.packageDir,
      env: {
        ...process.env,
        ...env,
        PRIME_AGENT_UPDATE_ROSTER: rosterPath,
        PRIME_AGENT_CODING_AGENT_DIR: agentDir,
        PRIME_AGENT_DAEMON_SOCKET: socketPath,
        PI_PACKAGE_DIR: location.packageDir
      },
      windowsHide: true,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )
  managed.child = child
  let spawnError: Error | undefined
  child.once('error', (error) => {
    spawnError = error
  })
  child.once('exit', () => {
    if (daemons.get(socketPath) === managed) daemons.delete(socketPath)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    managed.stderr = (managed.stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT)
  })
  child.unref()
  // The daemon owns resident sessions and must survive closing the desktop client.
  const stderrPipe = child.stderr as (typeof child.stderr & { unref?: () => void }) | null
  stderrPipe?.unref?.()

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(managed.stderr.trim() || 'Engine 2 stopped during startup')
    }
    const connection = await probe(socketPath)
    if (connection) {
      connection.close()
      await rememberDaemon(agentDir, socketPath, location, env, probe)
      return
    }
    await delay(DAEMON_RETRY_MS)
  }
  throw new Error('Engine 2 did not become ready within 30 seconds')
}

function failedStartup(managed: ManagedDaemon, error: unknown): never {
  // Native workers can survive their supervisor, including a failed adoption attempt.
  if (managed.child?.pid) {
    throw new PrimeDaemonStartupError(
      'Engine 2 startup could not be verified; its native workers may still be running',
      managed.child.pid,
      { cause: error }
    )
  }
  throw error
}

export class PrimeDaemonClient extends PrimeTransport {
  private readonly activity: PrimeDaemonActivity

  constructor(
    readonly location: PrimeEngineLocation,
    readonly agentDir: string = getPrimeAgentDir(),
    private readonly env: Record<string, string> = {},
    socketPath?: string,
    private readonly environmentKnown = true
  ) {
    super(socketPath ?? primeDaemonSocketPath(agentDir, location, env))
    this.activity = new PrimeDaemonActivity(this, () => restartBarriers.has(this.socketPath))
  }

  override request(
    type: string,
    payload: PrimeRecord = {},
    timeoutMs?: number
  ): Promise<PrimeRecord> {
    return this.activity.request(type, payload, () => super.request(type, payload, timeoutMs))
  }

  get launchEnv(): Record<string, string> {
    return { ...(daemons.get(this.socketPath)?.env ?? this.env) }
  }

  get launchEnvironmentKnown(): boolean {
    return daemons.get(this.socketPath)?.environmentKnown ?? this.environmentKnown
  }

  connectExisting(): Promise<void> {
    return super.connect().then(() => {
      const managed = daemons.get(this.socketPath)
      if (!managed) {
        daemons.set(this.socketPath, {
          location: this.location,
          agentDir: this.agentDir,
          env: this.env,
          environmentKnown: this.environmentKnown,
          stderr: '',
          started: Promise.resolve()
        })
      } else if (!managed.environmentKnown && this.environmentKnown) {
        managed.env = this.env
        managed.environmentKnown = true
      }
    })
  }

  stderr(): string {
    return daemons.get(this.socketPath)?.stderr ?? ''
  }

  override async connect(): Promise<void> {
    await restartBarriers.get(this.socketPath)?.catch(() => undefined)
    const record = (await rememberedDaemons(this.agentDir)).find(
      (entry) => entry.socketPath === this.socketPath
    )
    const failure =
      restartFailures.get(this.socketPath)?.error ??
      (typeof record?.restartFailure === 'string' ? new Error(record.restartFailure) : undefined)
    if (failure) {
      const connected = await probe(this.socketPath)
      if (!connected) throw failure
      connected.close()
      await this.connectExisting()
      return
    }
    let managed = daemons.get(this.socketPath)
    if (!managed) {
      managed = {
        location: this.location,
        agentDir: this.agentDir,
        env: this.env,
        environmentKnown: this.environmentKnown,
        stderr: '',
        started: Promise.resolve()
      }
      daemons.set(this.socketPath, managed)
      const pending = managed
      managed.started = (async () => {
        const connected = await probe(this.socketPath)
        if (connected) {
          connected.close()
          await rememberDaemon(this.agentDir, this.socketPath, this.location, this.env, probe)
        } else {
          try {
            await startDaemon(this.location, this.agentDir, this.socketPath, pending, this.env)
          } catch (error) {
            failedStartup(pending, error)
          }
        }
      })()
      void managed.started.catch((error) => {
        if (error instanceof PrimeDaemonStartupError) {
          restartFailures.set(this.socketPath, { error })
        } else if (daemons.get(this.socketPath) === pending) daemons.delete(this.socketPath)
      })
    }
    await managed.started
    try {
      await super.connect()
    } catch (error) {
      if (daemons.get(this.socketPath) === managed) daemons.delete(this.socketPath)
      throw error
    }
  }
}

export async function connectPrimeDaemon(
  options: PrimeDaemonOptions = {}
): Promise<PrimeDaemonClient> {
  const location = await locatePrimeEngine(options.executablePath)
  const agentDir = options.agentDir ?? getPrimeAgentDir()
  const environment = options.env ?? {}
  validatePrimeDaemonEnvironment(environment)
  const existing = (await rememberedDaemons(agentDir)).find(
    (entry) =>
      entry.executablePath === location.executablePath &&
      entry.environmentHash === primeEnvironmentHash(environment)
  )
  const client = new PrimeDaemonClient(
    location,
    agentDir,
    environment,
    stringValue(existing?.socketPath)
  )
  await client.connect()
  return client
}

export function beginPrimeDaemonRestart(
  socketPath: string
): (failure?: Error, residents?: PrimeRecord[], recovered?: boolean) => Promise<void> {
  if (restartBarriers.has(socketPath)) throw new Error('Engine 2 is already restarting')
  const agentDir = daemons.get(socketPath)?.agentDir
  let complete!: () => void
  let reject!: (error: Error) => void
  const pending = new Promise<void>((resolve, fail) => {
    complete = resolve
    reject = fail
  })
  void pending.catch(() => undefined)
  restartBarriers.set(socketPath, pending)
  return async (failure, residents, recovered = false) => {
    const sessions = residents?.map((session) => ({
      nativeAgentId: stringValue(session.activeSessionId) ?? stringValue(session.id),
      sessionPath: stringValue(session.sessionFile)
    }))
    if (failure) restartFailures.set(socketPath, { error: failure, sessions })
    else if (recovered) restartFailures.delete(socketPath)
    try {
      if (agentDir && (failure || recovered)) {
        await rememberRestartFailure(agentDir, socketPath, failure, sessions)
      }
    } finally {
      if (restartBarriers.get(socketPath) === pending) restartBarriers.delete(socketPath)
      if (failure) reject(failure)
      else complete()
    }
  }
}

export async function launchPrimeDaemonReplacement(
  source: PrimeDaemonClient,
  location: PrimeEngineLocation,
  env: Record<string, string>,
  rosterPath: string
): Promise<PrimeDaemonClient> {
  const managed: ManagedDaemon = {
    location,
    agentDir: source.agentDir,
    env,
    environmentKnown: true,
    stderr: '',
    started: Promise.resolve()
  }
  daemons.set(source.socketPath, managed)
  managed.started = startDaemon(
    location,
    source.agentDir,
    source.socketPath,
    managed,
    env,
    rosterPath
  )
  try {
    await managed.started
    const replacement = new PrimeDaemonClient(location, source.agentDir, env, source.socketPath)
    await replacement.connectExisting()
    return replacement
  } catch (error) {
    if (!managed.child?.pid && daemons.get(source.socketPath) === managed) {
      daemons.delete(source.socketPath)
    }
    failedStartup(managed, error)
  }
}

export async function shutdownPrimeDaemons(): Promise<void> {
  const active = [...daemons.entries()]
  await Promise.all(
    active.map(async ([socketPath]) => {
      const client = await probe(socketPath)
      if (!client) return
      try {
        await client.request('shutdown', { force: false }, DAEMON_START_TIMEOUT_MS)
      } finally {
        client.close()
      }
    })
  )
}

export async function primeDaemonCommand(
  type: string,
  payload: PrimeRecord = {},
  options: PrimeDaemonOptions = {}
): Promise<PrimeRecord> {
  const client = await connectPrimeDaemon(options)
  try {
    return await client.request(type, payload)
  } finally {
    client.close()
  }
}

export async function probePrimeDaemon(
  options: PrimeDaemonOptions = {}
): Promise<PrimeTransport | null> {
  try {
    const location = await locatePrimeEngine(options.executablePath)
    return probe(
      primeDaemonSocketPath(options.agentDir ?? getPrimeAgentDir(), location, options.env)
    )
  } catch {
    return null
  }
}

const RESIDENT_ADOPTION_TIMEOUT_MS = 30_000
const RESIDENT_ADOPTION_POLL_MS = 200

export async function attachPrimeResident(
  client: PrimeTransport,
  payload: PrimeRecord,
  recoveringResident?: PrimeCommandError,
  stopping: () => boolean = () => false
): Promise<PrimeRecord> {
  const deadline = Date.now() + RESIDENT_ADOPTION_TIMEOUT_MS
  while (true) {
    try {
      return await client.request('attach', payload)
    } catch (error) {
      if (
        !recoveringResident ||
        !(error instanceof PrimeCommandError) ||
        error.message !== `Unknown active session: ${payload.activeSessionId}` ||
        stopping() ||
        !client.connected
      ) {
        throw error
      }
      // A revived worker acquires its lease before the supervisor finishes adopting its identity.
      if (Date.now() >= deadline) throw recoveringResident
      await delay(RESIDENT_ADOPTION_POLL_MS)
    }
  }
}

export async function connectPrimeResident(
  selector: { nativeAgentId?: string; sessionPath?: string },
  options: PrimeDaemonOptions = {}
): Promise<{ client: PrimeDaemonClient; nativeAgentId: string } | null> {
  if (!selector.nativeAgentId && !selector.sessionPath) return null
  const agentDir = options.agentDir ?? getPrimeAgentDir()
  const records = await rememberedDaemons(agentDir)
  let restartFailure: Error | undefined
  for (const socketPath of await knownDaemonSockets(options)) {
    await restartBarriers.get(socketPath)?.catch(() => undefined)
    const saved =
      (await rememberedDaemons(agentDir)).find((record) => record.socketPath === socketPath) ??
      records.find((record) => record.socketPath === socketPath)
    const failed = restartFailures.get(socketPath)
    const sessions =
      failed?.sessions ??
      (Array.isArray(saved?.restartSessions) ? asRecords(saved.restartSessions) : undefined)
    if (!sessions || sessions.some((session) => matchesRestartSession(session, selector))) {
      restartFailure ??=
        failed?.error ??
        (typeof saved?.restartFailure === 'string' ? new Error(saved.restartFailure) : undefined)
    }
    const connection = await probe(socketPath)
    if (!connection) continue
    try {
      const roster = await connection.request('list', { all: false, includeClientOwned: true })
      const expected = selector.sessionPath ? resolve(selector.sessionPath) : undefined
      const resident = asRecords(roster.sessions ?? roster.agents).find((session) => {
        if (selector.nativeAgentId) {
          return (
            session.id === selector.nativeAgentId ||
            session.activeSessionId === selector.nativeAgentId
          )
        }
        const path = stringValue(session.sessionFile)
        if (!path || !expected) return false
        return process.platform === 'win32'
          ? resolve(path).toLowerCase() === expected.toLowerCase()
          : resolve(path) === expected
      })
      const nativeAgentId = stringValue(resident?.activeSessionId) ?? stringValue(resident?.id)
      if (!nativeAgentId) continue
      const managed = daemons.get(socketPath)
      const location: PrimeEngineLocation =
        managed?.location ??
        (saved &&
        typeof saved.executablePath === 'string' &&
        typeof saved.packageDir === 'string' &&
        typeof saved.version === 'string'
          ? {
              executablePath: saved.executablePath,
              packageDir: saved.packageDir,
              version: saved.version,
              source: 'managed'
            }
          : await locatePrimeEngine(options.executablePath))
      const environment = managed?.environmentKnown
        ? { values: managed.env, known: managed.environmentKnown }
        : restorePrimeDaemonEnvironment(saved, options.env)
      const client = new PrimeDaemonClient(
        location,
        agentDir,
        environment.values,
        socketPath,
        environment.known
      )
      await client.connectExisting()
      return { client, nativeAgentId }
    } finally {
      connection.close()
    }
  }
  if (restartFailure) throw restartFailure
  return null
}

function matchesRestartSession(
  session: PrimeRecord,
  selector: { nativeAgentId?: string; sessionPath?: string }
): boolean {
  if (selector.nativeAgentId) return session.nativeAgentId === selector.nativeAgentId
  if (!selector.sessionPath || typeof session.sessionPath !== 'string') return false
  const actual = resolve(session.sessionPath)
  const expected = resolve(selector.sessionPath)
  return process.platform === 'win32'
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected
}

async function knownDaemonSockets(options: PrimeDaemonOptions): Promise<string[]> {
  const agentDir = options.agentDir ?? getPrimeAgentDir()
  const recorded = await rememberedDaemons(agentDir)
  const sockets = recorded.flatMap((entry) => {
    const socketPath = stringValue(entry.socketPath)
    return socketPath ? [socketPath] : []
  })
  for (const [socketPath, daemon] of daemons) {
    if (resolve(daemon.agentDir) === resolve(agentDir)) sockets.push(socketPath)
  }
  return [...new Set(sockets)]
}

export async function listPrimeBackground(
  options: PrimeDaemonOptions = {}
): Promise<BackgroundAgentInfo[]> {
  const results = await Promise.all(
    (await knownDaemonSockets(options)).map(async (socketPath) => {
      if (restartBarriers.has(socketPath)) return []
      const client = await probe(socketPath)
      if (!client) return []
      try {
        const result = await client.request('list', { all: false, includeClientOwned: false })
        return asRecords(result.sessions ?? result.agents)
          .filter((session) => !serviceSessions.has(String(session.activeSessionId ?? session.id)))
          .map((session): BackgroundAgentInfo => ({
            engine: 'prime',
            id: stringValue(session.activeSessionId) ?? stringValue(session.id) ?? '',
            name: stringValue(session.name) ?? stringValue(session.sessionName),
            cwd: stringValue(session.cwd) ?? '',
            sessionPath: stringValue(session.sessionFile),
            status: stringValue(session.activity) ?? stringValue(session.lifecycle) ?? 'idle',
            busy:
              session.isStreaming === true ||
              session.isCompacting === true ||
              session.isBashRunning === true ||
              session.hasRunningSubagents === true
          }))
      } finally {
        client.close()
      }
    })
  )
  return results.flat()
}

export async function stopPrimeBackground(
  nativeAgentId: string,
  options: PrimeDaemonOptions = {}
): Promise<void> {
  for (const socketPath of await knownDaemonSockets(options)) {
    await restartBarriers.get(socketPath)
    const client = await probe(socketPath)
    if (!client) continue
    try {
      const result = await client.request('list', { all: false, includeClientOwned: false })
      const matched = asRecords(result.sessions ?? result.agents).some(
        (session) => session.activeSessionId === nativeAgentId || session.id === nativeAgentId
      )
      if (matched) {
        await client.request('kill', { activeSessionId: nativeAgentId }, 0)
        return
      }
    } finally {
      client.close()
    }
  }
  throw new Error('This background session is no longer running')
}

export async function withPrimeServiceSession<Result>(
  cwd: string,
  callback: (
    request: (type: string, payload?: PrimeRecord) => Promise<PrimeRecord>
  ) => Promise<Result>,
  sessionPath?: string,
  options: PrimeServiceOptions = {}
): Promise<Result> {
  const resident = sessionPath ? await connectPrimeResident({ sessionPath }, options) : null
  const client = resident?.client ?? (await connectPrimeDaemon(options))
  let activeSessionId = resident?.nativeAgentId
  let owned = false
  try {
    if (activeSessionId && options.requireOwnedSession) {
      throw new Error('Open this running session before changing its active branch')
    }
    if (sessionPath && !activeSessionId) {
      const roster = await client.request('list', { all: false, includeClientOwned: true })
      const expectedPath = resolve(sessionPath).toLowerCase()
      const existing = asRecords(roster.sessions ?? roster.agents).find((session) => {
        const path = stringValue(session.sessionFile)
        return path && resolve(path).toLowerCase() === expectedPath
      })
      activeSessionId = stringValue(existing?.activeSessionId) ?? stringValue(existing?.id)
      if (activeSessionId && options.requireOwnedSession) {
        throw new Error('Open this running session before changing its active branch')
      }
    }
    if (!activeSessionId) {
      const noSession = options.persistSession ? false : (options.noSession ?? !sessionPath)
      const sessionDir = noSession
        ? options.sessionDir
        : await preparePrimeSessionDirectory(cwd, options, options.sessionDir, sessionPath)
      let created: PrimeRecord
      try {
        created = await client.request(
          'create',
          {
            sessionPath,
            noSession,
            lifecycle: 'client_owned',
            config: { cwd, sessionDir }
          },
          0
        )
        activeSessionId = stringValue(created.activeSessionId) ?? stringValue(created.id)
        owned = true
        if (activeSessionId) serviceSessions.add(activeSessionId)
      } catch (error) {
        if (
          !(error instanceof PrimeCommandError) ||
          error.details.code !== 'session_already_active'
        )
          throw error
        if (options.requireOwnedSession)
          throw new Error('Open this running session before changing its active branch')
        activeSessionId = stringValue(error.details.activeSessionId)
      }
    }
    if (!activeSessionId) throw new Error('Engine 2 did not create the settings connection')
    return await callback((type, payload = {}) => {
      if (!owned && ['fork', 'new_session', 'switch_session', 'import_jsonl'].includes(type)) {
        throw new Error('Open this running session before changing its active branch')
      }
      return client.request(type, { activeSessionId, ...payload }, 0)
    })
  } finally {
    try {
      if (owned && activeSessionId) {
        await client.request('complete_owned_session', { activeSessionId })
      }
    } finally {
      if (owned && activeSessionId) serviceSessions.delete(activeSessionId)
      client.close()
    }
  }
}

export function primeServiceCommand(
  type: string,
  payload: PrimeRecord = {},
  cwd: string,
  options: PrimeServiceOptions = {}
): Promise<PrimeRecord> {
  return withPrimeServiceSession(cwd, (request) => request(type, payload), undefined, options)
}
