import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrimeEngineLocation } from './locate'
import { primeEnvironmentHash, sealPrimeDaemonEnvironment } from './daemon-environment'
import { asRecords, stringValue, type PrimeRecord, type PrimeTransport } from './transport'

const REGISTRY_FILE = 'vengeance-daemons.json'
const STALE_REGISTRY_MS = 24 * 60 * 60 * 1000
const PRUNE_BATCH_SIZE = 16
let registryWrite = Promise.resolve()

export async function rememberedDaemons(agentDir: string): Promise<PrimeRecord[]> {
  try {
    return asRecords(JSON.parse(await readFile(join(agentDir, REGISTRY_FILE), 'utf8'))).filter(
      (entry) => typeof entry.socketPath === 'string' && ownedDaemonSocket(entry.socketPath)
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export function rememberDaemon(
  agentDir: string,
  socketPath: string,
  location: PrimeEngineLocation,
  environment: Record<string, string>,
  probe: (socketPath: string) => Promise<PrimeTransport | null>
): Promise<void> {
  const pending = registryWrite
    .catch(() => undefined)
    .then(async () => {
      const remembered = await rememberedDaemons(agentDir)
      const current = remembered.find((entry) => entry.socketPath === socketPath)
      const previous = remembered.filter((entry) => entry.socketPath !== socketPath)
      let inspected = 0
      const entries = []
      for (const entry of previous) {
        const endpoint = stringValue(entry.socketPath)
        const lastSeen = typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : 0
        if (
          endpoint &&
          !entry.restartFailure &&
          lastSeen < Date.now() - STALE_REGISTRY_MS &&
          inspected < PRUNE_BATCH_SIZE
        ) {
          inspected++
          const connected = await probe(endpoint)
          if (!connected) continue
          connected.close()
          entry.lastSeenAt = Date.now()
        }
        entries.push(entry)
      }
      const environmentHash = primeEnvironmentHash(environment)
      entries.push({
        socketPath,
        ...location,
        environmentHash,
        sealedEnvironment:
          sealPrimeDaemonEnvironment(environment) ??
          (current?.environmentHash === environmentHash ? current.sealedEnvironment : undefined),
        restartFailure: current?.restartFailure,
        restartSessions: current?.restartSessions,
        lastSeenAt: Date.now()
      })
      await writeDaemonRegistry(agentDir, entries)
    })
  registryWrite = pending
  return pending
}

export function rememberRestartFailure(
  agentDir: string,
  socketPath: string,
  failure?: Error,
  sessions?: PrimeRecord[]
): Promise<void> {
  const pending = registryWrite
    .catch(() => undefined)
    .then(async () => {
      const entries = await rememberedDaemons(agentDir)
      const target = entries.find((entry) => entry.socketPath === socketPath)
      if (!target) return
      if (failure) {
        target.restartFailure = failure.message
        target.restartSessions = sessions
      } else {
        delete target.restartFailure
        delete target.restartSessions
      }
      await writeDaemonRegistry(agentDir, entries)
    })
  registryWrite = pending
  return pending
}

async function writeDaemonRegistry(agentDir: string, entries: PrimeRecord[]): Promise<void> {
  const target = join(agentDir, REGISTRY_FILE)
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function ownedDaemonSocket(socketPath: string): boolean {
  const prefix =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\vengeance-engine2-'
      : join(tmpdir(), 'vengeance-engine2-')
  const suffix = process.platform === 'win32' ? '' : '.sock'
  if (!socketPath.startsWith(prefix) || !socketPath.endsWith(suffix)) return false
  const identity = socketPath.slice(prefix.length, suffix ? -suffix.length : undefined)
  return /^[a-f0-9]{20}$/.test(identity)
}
