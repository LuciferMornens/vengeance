import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { CreateAgentArgs } from '@shared/api/engine'
import {
  beginPrimeDaemonRestart,
  connectPrimeResident,
  isPrimeServiceSession,
  launchPrimeDaemonReplacement,
  PrimeDaemonStartupError,
  type PrimeDaemonClient
} from './daemon'
import { assertPrimeSideQuestionsIdle } from './daemon-activity'
import { validatePrimeDaemonEnvironment } from './daemon-environment'
import { locatePrimeEngine } from './locate'
import { thinkingLevel } from './normalize'
import {
  checkPrimeRestartHelper,
  nativePrimeRestartCommand,
  type PrimeRestartCheckpoint
} from './restart-native'
import {
  asRecord,
  asRecords,
  PrimeCommandError,
  PrimeTransport,
  stringValue,
  type PrimeRecord
} from './transport'

const PREPARE_TIMEOUT_MS = 90_000
const COMMIT_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 30_000
const RESTORE_TIMEOUT_MS = 120_000
const SERVICE_DRAIN_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 100
const RESTORE_POLL_INTERVAL_MS = 500
const PREPARED_EXPIRY_MS = 45_000
const EXPIRY_MARGIN_MS = 500
const MAX_ROSTER_BYTES = 64 * 1024 * 1024
const CONFIG_KEYS = [
  'provider',
  'model',
  'thinking',
  'systemPrompt',
  'appendSystemPrompt',
  'skills',
  'promptTemplates',
  'models',
  'autonomous'
] as const

interface PreparedRestart {
  updateId: string
  rosterPath: string
  expiresAt: number
}

interface InputPause {
  activeSessionId: string
  pauseId: string
}

interface PendingRestart {
  nativeAgentId: string
  executablePath: string | null
  environment: Record<string, string>
  configPatch: PrimeRecord
  task: Promise<void>
}

const pendingRestarts = new Map<string, PendingRestart>()

export function primeRestartSelection(
  previous: CreateAgentArgs,
  next: CreateAgentArgs,
  state: PrimeRecord
): CreateAgentArgs {
  const model = asRecord(state.model)
  const keepModel = previous.provider === next.provider && previous.model === next.model
  return {
    ...next,
    provider: keepModel ? (stringValue(model.provider) ?? next.provider) : next.provider,
    model: keepModel ? (stringValue(model.id) ?? next.model) : next.model,
    thinking:
      previous.thinking === next.thinking ? thinkingLevel(state.thinkingLevel) : next.thinking
  }
}

export function restartPrimeSession(
  source: PrimeDaemonClient,
  nativeAgentId: string,
  previousArgs: CreateAgentArgs,
  nextArgs: CreateAgentArgs,
  executablePath?: string | null
): Promise<void> {
  const pending = pendingRestarts.get(source.socketPath)
  const environment = restartEnvironment(source, previousArgs, nextArgs)
  const configPatch = changedConfiguration(previousArgs, nextArgs)
  if (pending) {
    const sameRuntime =
      pending.executablePath === (executablePath ?? null) &&
      isDeepStrictEqual(pending.environment, environment)
    const sharedChange =
      Object.keys(configPatch).length === 0 ||
      (pending.nativeAgentId === nativeAgentId &&
        isDeepStrictEqual(pending.configPatch, configPatch))
    if (sameRuntime && sharedChange) return pending.task
    return pending.task.then(async () => {
      const resident = await connectPrimeResident(
        { nativeAgentId, sessionPath: nextArgs.sessionPath },
        { executablePath, agentDir: source.agentDir, env: source.launchEnv }
      )
      if (!resident)
        throw new Error('The Engine 2 resident is not available for its queued restart')
      try {
        await restartPrimeSession(
          resident.client,
          resident.nativeAgentId,
          previousArgs,
          nextArgs,
          executablePath
        )
      } finally {
        resident.client.close()
      }
    })
  }
  const task = performPrimeRestart(
    source,
    nativeAgentId,
    previousArgs,
    nextArgs,
    executablePath
  ).finally(() => {
    if (pendingRestarts.get(source.socketPath)?.task === task) {
      pendingRestarts.delete(source.socketPath)
    }
  })
  pendingRestarts.set(source.socketPath, {
    nativeAgentId,
    executablePath: executablePath ?? null,
    environment,
    configPatch,
    task
  })
  return task
}

async function performPrimeRestart(
  source: PrimeDaemonClient,
  nativeAgentId: string,
  previousArgs: CreateAgentArgs,
  nextArgs: CreateAgentArgs,
  executablePath?: string | null
): Promise<void> {
  const releaseBarrier = beginPrimeDaemonRestart(source.socketPath)
  const control = new PrimeTransport(source.socketPath)
  const oldEnvironment = source.launchEnv
  let prepared: PreparedRestart | undefined
  let temporaryDirectory: string | undefined
  let checkpoint: PrimeRestartCheckpoint | undefined
  let replacement: PrimeDaemonClient | undefined
  let commitAttempted = false
  let committed = false
  let patchAttempted = false
  let recovered = false
  let retainedFailure: Error | undefined
  let residents: PrimeRecord[] = []
  const pauses: InputPause[] = []
  try {
    if (!source.launchEnvironmentKnown) {
      throw new Error(
        'Engine 2 cannot recover this resident’s launch environment. ' +
          'Reopen it with its saved launch options before restarting.'
      )
    }
    const environment = restartEnvironment(source, previousArgs, nextArgs)
    validatePrimeDaemonEnvironment(environment)
    const location = await locatePrimeEngine(executablePath)
    await checkPrimeRestartHelper()
    await control.connect()
    residents = await drainServiceSessions(control)
    const target = residents.find((session) => sessionIdentity(session) === nativeAgentId)
    const sessionPath = stringValue(target?.sessionFile)
    if (!target) {
      throw new Error('The Engine 2 resident is not available for its restart')
    }
    if (!sessionPath || previousArgs.noSession) {
      throw new Error(
        'Temporary sessions cannot be restarted; start a new session to use updated settings.'
      )
    }
    if (residents.some((session) => !stringValue(session.sessionFile))) {
      throw new Error(
        'Temporary Engine 2 sessions share this runtime. Close them before restarting.'
      )
    }
    assertPrimeSideQuestionsIdle(source.socketPath)
    assertIdle(residents)
    if (!isDeepStrictEqual(oldEnvironment, environment) && residents.length > 1) {
      throw new Error(
        'Engine 2 shares its environment with other resident sessions. ' +
          'Stop those residents in Background agents before applying environment changes.'
      )
    }
    await pauseSessionInputs(control, residents, pauses)
    assertIdle(await residentSessions(control))
    prepared = await prepareRestart(control, source.agentDir, location.version)
    assertPrimeSideQuestionsIdle(source.socketPath)
    const roster = await readPreparedRoster(prepared)
    assertPreparedIdle(roster)
    const restartRoot = join(source.agentDir, 'vengeance-restarts')
    await mkdir(restartRoot, { recursive: true, mode: 0o700 })
    temporaryDirectory = await mkdtemp(join(restartRoot, 'restart-'))
    const rosterPath = join(temporaryDirectory, 'roster.json')
    // The successor sweeps native preparation artifacts before restoring its residents.
    await copyFile(prepared.rosterPath, rosterPath)
    checkpoint = {
      agentDir: source.agentDir,
      socketPath: source.socketPath,
      nativeAgentId,
      sessionPath,
      rosterPath,
      backupDir: join(temporaryDirectory, 'backup'),
      configPatch: changedConfiguration(previousArgs, nextArgs)
    }
    const captured = await nativePrimeRestartCommand('capture', checkpoint)
    const capturedWorkers = captured.workerPids
    if (
      !Array.isArray(capturedWorkers) ||
      !capturedWorkers.length ||
      capturedWorkers.some((pid: unknown) => typeof pid !== 'number' || pid <= 0)
    ) {
      throw new Error('Engine 2 did not identify the workers in its native recovery snapshot')
    }
    assertMarkerFresh(prepared.expiresAt)
    residents = await residentSessions(control)
    assertIdle(residents)
    commitAttempted = true
    await commitRestart(control, prepared.updateId, [
      ...capturedWorkers,
      ...workerProcessIds(residents)
    ])
    committed = true
    patchAttempted = true
    await nativePrimeRestartCommand('patch', checkpoint)
    replacement = await launchPrimeDaemonReplacement(source, location, environment, rosterPath)
    await verifyRestore(replacement, prepared.updateId)
    await verifyResidentReplaced(replacement, nativeAgentId, target.workerPid)
    recovered = true
  } catch (error) {
    if (
      error instanceof PrimeDaemonStartupError &&
      !(checkpoint && (await replacementProcessesStopped(error, checkpoint)))
    ) {
      retainedFailure = new Error(
        'The replacement Engine 2 runtime is still starting. Its recovery snapshot remains at ' +
          `${temporaryDirectory}; another runtime was not started over it.`
      )
      throw retainedFailure
    }
    if (commitAttempted && !committed && !(error instanceof PrimeCommandError)) {
      retainedFailure = new Error(
        'Engine 2 could not confirm that its runtime and resident workers stopped. ' +
          `The recovery snapshot remains at ${temporaryDirectory}. ` +
          'No launch configuration was changed.'
      )
      throw retainedFailure
    }
    if (committed && checkpoint) {
      try {
        if (replacement) {
          await stopFailedReplacement(replacement)
          replacement.close()
          replacement = undefined
        }
        if (patchAttempted && (await hasRestartBackup(checkpoint.backupDir))) {
          await nativePrimeRestartCommand('rollback', checkpoint)
        }
        replacement = await launchPrimeDaemonReplacement(
          source,
          source.location,
          oldEnvironment,
          checkpoint.rosterPath
        )
        await verifyRestore(replacement, prepared!.updateId)
        recovered = true
      } catch (rollbackError) {
        retainedFailure = new Error(
          `Engine 2 could not finish restarting: ${errorMessage(error)}. ` +
            `Recovery also failed: ${errorMessage(rollbackError)}. ` +
            `Its native recovery snapshot is saved in ${temporaryDirectory}.`
        )
        throw retainedFailure
      }
      throw new Error(
        `Engine 2 could not apply the restart: ${errorMessage(error)}. ` +
          'The previous engine and launch configuration were restored.'
      )
    }
    if (prepared) await waitForPreparationExpiry(prepared.expiresAt)
    throw error
  } finally {
    if (!committed) await releaseSessionInputs(control, pauses)
    control.close()
    replacement?.close()
    if (temporaryDirectory && !retainedFailure && (!committed || recovered)) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    await releaseBarrier(retainedFailure, residents, recovered)
  }
}

function changedConfiguration(previous: CreateAgentArgs, next: CreateAgentArgs): PrimeRecord {
  const before: PrimeRecord = {
    provider: previous.provider,
    model: previous.model,
    thinking: previous.thinking,
    ...previous.launch?.prime
  }
  const after: PrimeRecord = {
    provider: next.provider,
    model: next.model,
    thinking: next.thinking,
    ...next.launch?.prime
  }
  const patch: PrimeRecord = {}
  for (const key of CONFIG_KEYS) {
    if (!isDeepStrictEqual(before[key], after[key])) patch[key] = after[key] ?? null
  }
  return patch
}

function restartEnvironment(
  source: PrimeDaemonClient,
  previous: CreateAgentArgs,
  next: CreateAgentArgs
): Record<string, string> {
  return isDeepStrictEqual(previous.launch?.env, next.launch?.env)
    ? source.launchEnv
    : (next.launch?.env ?? {})
}

async function residentSessions(
  client: PrimeTransport,
  timeoutMs?: number
): Promise<PrimeRecord[]> {
  const roster = await client.request('list', { all: false, includeClientOwned: true }, timeoutMs)
  const residents = asRecords(roster.sessions ?? roster.agents)
  if (
    residents.some((session) => typeof session.workerPid !== 'number' || session.workerPid <= 0)
  ) {
    throw new Error('Wait until every Engine 2 resident reconnects before restarting its runtime')
  }
  return residents
}

async function drainServiceSessions(client: PrimeTransport): Promise<PrimeRecord[]> {
  const deadline = Date.now() + SERVICE_DRAIN_TIMEOUT_MS
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('Wait for Engine 2 background services to finish, then restart again.')
    }
    const residents = await residentSessions(client, remaining)
    if (!residents.some((session) => isPrimeServiceSession(sessionIdentity(session) ?? ''))) {
      return residents
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }
}

function sessionIdentity(session: PrimeRecord): string | undefined {
  return stringValue(session.activeSessionId) ?? stringValue(session.id)
}

function assertIdle(residents: PrimeRecord[]): void {
  const busy = residents.find(
    (session) =>
      session.isStreaming === true ||
      session.isCompacting === true ||
      session.isBashRunning === true ||
      session.hasRunningSubagents === true ||
      session.hasRunningRlmChildren === true ||
      session.isRunningTools === true ||
      session.isRetrying === true ||
      ['streaming', 'working', 'busy', 'compacting'].includes(String(session.activity))
  )
  if (busy) {
    const name = stringValue(busy.name) ?? stringValue(busy.sessionName) ?? 'another session'
    throw new Error(
      `Engine 2 restarts its shared runtime. Wait until ${name} finishes, then restart again.`
    )
  }
}

async function pauseSessionInputs(
  client: PrimeTransport,
  residents: PrimeRecord[],
  pauses: InputPause[]
): Promise<void> {
  for (const session of residents) {
    const activeSessionId = sessionIdentity(session)
    if (!activeSessionId) throw new Error('Engine 2 returned a resident without an identity')
    const result = await client.request('acquire_session_input_pause', {
      activeSessionId,
      leaseKey: `vengeance-restart-${randomUUID()}`
    })
    const pauseId = stringValue(result.pauseId)
    if (!pauseId) throw new Error('Engine 2 could not pause new inputs for its restart')
    pauses.push({ activeSessionId, pauseId })
  }
}

async function releaseSessionInputs(client: PrimeTransport, pauses: InputPause[]): Promise<void> {
  await Promise.allSettled(
    pauses.map((pause) => client.request('release_session_input_pause', { ...pause }))
  )
}

async function prepareRestart(
  client: PrimeTransport,
  agentDir: string,
  toVersion: string
): Promise<PreparedRestart> {
  const updateId = randomUUID()
  const prepared = await client.request(
    'prepare_update_restart',
    { updateId, toVersion },
    PREPARE_TIMEOUT_MS
  )
  if (prepared.state !== 'prepared' || prepared.updateId !== updateId) {
    throw new Error('Engine 2 did not prepare a complete native recovery snapshot')
  }
  const socketHash = createHash('sha256').update(client.socketPath).digest('hex')
  const rosterPath = join(
    agentDir,
    'update-restarts',
    socketHash,
    'prepared',
    updateId,
    'roster.json'
  )
  const reportedExpiry = Date.parse(String(prepared.expiresAt))
  return {
    updateId,
    rosterPath,
    expiresAt: Number.isFinite(reportedExpiry) ? reportedExpiry : Date.now() + PREPARED_EXPIRY_MS
  }
}

async function readPreparedRoster(prepared: PreparedRestart): Promise<PrimeRecord> {
  const metadata = await stat(prepared.rosterPath)
  if (metadata.size > MAX_ROSTER_BYTES) {
    throw new Error('Engine 2 returned an oversized native recovery snapshot')
  }
  const roster = asRecord(JSON.parse(await readFile(prepared.rosterPath, 'utf8')))
  if (roster.update_id !== prepared.updateId || !Array.isArray(roster.sessions)) {
    throw new Error('Engine 2 returned an incompatible native recovery snapshot')
  }
  return roster
}

function assertPreparedIdle(roster: PrimeRecord): void {
  const busy = asRecords(roster.sessions).some((session) => {
    const activity = asRecord(session.in_flight)
    // Native rlm_children records family membership, including idle or completed children.
    return ['streaming', 'compacting', 'bash_running', 'retrying', 'prompt_in_flight'].some(
      (field) => activity[field] === true
    )
  })
  if (busy) {
    throw new Error(
      'An Engine 2 resident started working while the restart was being prepared. ' +
        'Its work is continuing; restart again after it finishes.'
    )
  }
}

function assertMarkerFresh(expiresAt: number): void {
  if (Date.now() >= expiresAt) {
    throw new Error('The native restart snapshot expired; restart Engine 2 again')
  }
}

async function commitRestart(
  client: PrimeTransport,
  updateId: string,
  workerProcessIds: number[]
): Promise<void> {
  try {
    await client.request('commit_update_restart', { updateId }, COMMIT_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof PrimeCommandError) throw error
    // A daemon can exit after committing before its acknowledgement reaches the client.
  }
  await waitForNativeExit(client.hello.supervisorPid, workerProcessIds)
}

function workerProcessIds(residents: PrimeRecord[]): number[] {
  return residents.flatMap((session) =>
    typeof session.workerPid === 'number' ? [session.workerPid] : []
  )
}

async function waitForNativeExit(supervisorPid: unknown, workers: number[]): Promise<void> {
  if (typeof supervisorPid !== 'number' || supervisorPid <= 0) {
    throw new Error('Engine 2 did not identify the runtime being restarted')
  }
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  const processes = [...workers, supervisorPid]
  while (processes.some(processIsAlive)) {
    if (Date.now() >= deadline) {
      throw new Error('Engine 2 did not stop every resident after preparing its restart')
    }
    await delay(POLL_INTERVAL_MS)
  }
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function verifyRestore(client: PrimeTransport, updateId: string): Promise<void> {
  const deadline = Date.now() + RESTORE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await client.request('update_restore_status', { updateId })
    if (status.updateId !== updateId) {
      throw new Error('Engine 2 did not adopt the prepared native recovery snapshot')
    }
    if (status.complete === true) {
      const failures = asRecords(status.failures)
      if (failures.length || Number(asRecord(status.counts).failed) > 0) {
        const message = stringValue(failures[0]?.message) ?? 'a resident could not be restored'
        throw new Error(`Engine 2 could not restore every resident: ${message}`)
      }
      return
    }
    await delay(RESTORE_POLL_INTERVAL_MS)
  }
  throw new Error('Engine 2 did not finish restoring its resident sessions')
}

async function verifyResidentReplaced(
  client: PrimeTransport,
  nativeAgentId: string,
  workerPid: unknown
): Promise<void> {
  const residents = await residentSessions(client)
  const target = residents.find((session) => sessionIdentity(session) === nativeAgentId)
  if (!target || target.workerPid === workerPid) {
    throw new Error('Engine 2 did not replace the requested resident worker')
  }
}

async function stopFailedReplacement(client: PrimeDaemonClient): Promise<void> {
  const residents = await residentSessions(client)
  assertPrimeSideQuestionsIdle(client.socketPath)
  assertIdle(residents)
  const prepared = await prepareRestart(client, client.agentDir, client.location.version)
  try {
    assertPrimeSideQuestionsIdle(client.socketPath)
    assertPreparedIdle(await readPreparedRoster(prepared))
    const workers = await residentSessions(client)
    await commitRestart(client, prepared.updateId, workerProcessIds(workers))
  } catch (error) {
    await waitForPreparationExpiry(prepared.expiresAt)
    throw error
  }
}

async function hasRestartBackup(backupDirectory: string): Promise<boolean> {
  try {
    await stat(join(backupDirectory, 'manifest.json'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function replacementProcessesStopped(
  error: PrimeDaemonStartupError,
  checkpoint: PrimeRestartCheckpoint
): Promise<boolean> {
  try {
    if (processIsAlive(error.supervisorPid)) return false
    const inspected = await nativePrimeRestartCommand('workers', checkpoint)
    if (!Array.isArray(inspected.workerPids)) return false
    return inspected.workerPids.every(
      (processId: unknown) =>
        typeof processId === 'number' && processId > 0 && !processIsAlive(processId)
    )
  } catch {
    return false
  }
}

async function waitForPreparationExpiry(expiresAt: number): Promise<void> {
  const remaining = expiresAt - Date.now() + EXPIRY_MARGIN_MS
  if (remaining > 0) await delay(Math.min(remaining, PREPARED_EXPIRY_MS + EXPIRY_MARGIN_MS))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
