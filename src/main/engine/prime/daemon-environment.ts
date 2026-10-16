import { createHash } from 'node:crypto'
import { safeStorage } from 'electron'
import type { PrimeRecord } from './transport'

export interface PrimeDaemonEnvironment {
  values: Record<string, string>
  known: boolean
}

const MANAGED_ENVIRONMENT = new Set([
  'PRIME_AGENT_CODING_AGENT_DIR',
  'PRIME_AGENT_DAEMON_SOCKET',
  'PRIME_AGENT_UPDATE_ROSTER',
  'PI_PACKAGE_DIR'
])

export function validatePrimeDaemonEnvironment(environment: Record<string, string>): void {
  const managed = Object.keys(environment).find((name) =>
    MANAGED_ENVIRONMENT.has(name.toUpperCase())
  )
  if (managed) {
    throw new Error(`Engine 2 manages ${managed}; remove it from the launch environment`)
  }
}

export function primeEnvironmentHash(environment: Record<string, string>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
      )
    )
    .digest('hex')
}

export function sealPrimeDaemonEnvironment(
  environment: Record<string, string>
): string | undefined {
  if (!Object.keys(environment).length || !safeStorage?.isEncryptionAvailable()) return undefined
  return safeStorage.encryptString(JSON.stringify(environment)).toString('base64')
}

export function restorePrimeDaemonEnvironment(
  record: PrimeRecord | undefined,
  supplied: Record<string, string> = {}
): PrimeDaemonEnvironment {
  if (record?.environmentHash === primeEnvironmentHash(supplied)) {
    return { values: supplied, known: true }
  }
  if (typeof record?.sealedEnvironment !== 'string' || !safeStorage?.isEncryptionAvailable()) {
    return { values: {}, known: false }
  }
  try {
    const decrypted: unknown = JSON.parse(
      safeStorage.decryptString(Buffer.from(record.sealedEnvironment, 'base64'))
    )
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
      return { values: {}, known: false }
    }
    const entries = Object.entries(decrypted)
    if (entries.some(([, value]) => typeof value !== 'string')) {
      return { values: {}, known: false }
    }
    const values = Object.fromEntries(entries) as Record<string, string>
    return record.environmentHash === primeEnvironmentHash(values)
      ? { values, known: true }
      : { values: {}, known: false }
  } catch {
    return { values: {}, known: false }
  }
}
