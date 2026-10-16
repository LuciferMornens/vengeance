import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import type { SessionLineage } from '@shared/api/sessions'
import { getPrimeAgentDir } from './locate'
import { asRecord, stringValue } from './transport'

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024
const SESSION_HELPER_TIMEOUT_MS = 120_000
const MAX_LINEAGE_OUTPUT_BYTES = 4 * 1024 * 1024

export interface PrimeSavedLineage {
  sessions: Array<{ path: string; name?: string; lineage: SessionLineage }>
  excludedPaths: string[]
  warning?: string
}

type SessionCommand =
  | { operation: 'fork'; path: string; cwd: string; sessionDir: string }
  | { operation: 'branch'; path: string; entryId: string; sessionDir: string }
  | { operation: 'handoff'; inputPath: string; sessionDir: string }

function sessionHelper(
  mode: '--session' | '--session-lineage' | '--session-delete',
  command: object,
  environment: Record<string, string>,
  maximumBytes: number
): Promise<Record<string, unknown>> {
  const name = process.platform === 'win32' ? 'vengeance-prime-auth.exe' : 'vengeance-prime-auth'
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'prime-auth', name)
    : join(app.getAppPath(), 'resources', 'prime-auth', 'bin', name)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [mode], {
      windowsHide: true,
      env: {
        ...process.env,
        ...environment,
        PRIME_AGENT_CODING_AGENT_DIR: environment.PRIME_AGENT_CODING_AGENT_DIR ?? getPrimeAgentDir()
      },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const chunks: Buffer[] = []
    let length = 0
    let failure: Error | undefined
    const timeout = setTimeout(() => {
      failure = new Error('Engine 2 session operation timed out')
      child.kill()
    }, SESSION_HELPER_TIMEOUT_MS)
    timeout.unref()
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdin.on('error', (error) => {
      failure ??= error
    })
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > maximumBytes) {
        failure = new Error('Engine 2 returned an oversized session response')
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error('Engine 2 could not complete the session action'))
      try {
        const response = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (response.ok !== true) {
          throw new Error(stringValue(response.error) ?? 'Engine 2 session operation failed')
        }
        resolve(response)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify(command))
  })
}

export async function nativePrimeSessionCommand(
  command: SessionCommand,
  environment: Record<string, string> = {}
): Promise<string> {
  const response = await sessionHelper('--session', command, environment, MAX_HELPER_OUTPUT_BYTES)
  const path = stringValue(response.path)
  if (!path) throw new Error('Engine 2 did not return a session path')
  return path
}

export async function nativePrimeSessionLineage(
  agentDir: string,
  sessionDirs: string[]
): Promise<PrimeSavedLineage> {
  const response = await sessionHelper(
    '--session-lineage',
    { agentDir, sessionDirs },
    { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    MAX_LINEAGE_OUTPUT_BYTES
  )
  const result = asRecord(response.result)
  if (
    !Array.isArray(result.sessions) ||
    !Array.isArray(result.excludedPaths) ||
    !result.excludedPaths.every((path) => typeof path === 'string')
  ) {
    throw new Error('Engine 2 returned invalid saved-session lineage')
  }
  const sessions = result.sessions.map((value) => {
    const row = asRecord(value)
    const lineage = asRecord(row.lineage)
    if (
      typeof row.path !== 'string' ||
      typeof lineage.childId !== 'string' ||
      lineage.childId.length === 0 ||
      typeof lineage.depth !== 'number' ||
      !Number.isSafeInteger(lineage.depth) ||
      lineage.depth < 1 ||
      lineage.runtimeKind !== 'subagent'
    ) {
      throw new Error('Engine 2 returned invalid child-session lineage')
    }
    return {
      path: row.path,
      name: stringValue(row.name),
      lineage: {
        parentSessionPath: stringValue(lineage.parentSessionPath),
        parentSessionId: stringValue(lineage.parentSessionId),
        depth: lineage.depth,
        childId: lineage.childId,
        runtimeKind: lineage.runtimeKind
      }
    }
  })
  return {
    sessions,
    excludedPaths: result.excludedPaths,
    warning: stringValue(result.warning)
  }
}

export async function nativePrimeDeleteChild(command: {
  agentDir: string
  sessionDirs: string[]
  path: string
  parentPath: string
  sessionId: string
  childId: string
  recoveryPath: string
}): Promise<void> {
  await sessionHelper(
    '--session-delete',
    command,
    { PRIME_AGENT_CODING_AGENT_DIR: command.agentDir },
    MAX_HELPER_OUTPUT_BYTES
  )
}
