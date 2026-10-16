import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app } from 'electron'
import type { PrimeSettingsContext } from './configuration'
import { getPrimeAgentDir, locatePrimeEngine } from './locate'
import { killProcessTree } from '../runtime'
import { jsonObject } from './configuration-store'

const CAPTURE_TIMEOUT_MS = 30_000
const RESOURCE_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const runs = new Map<string, ChildProcess>()

function primeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PRIME_AGENT_CODING_AGENT_DIR: getPrimeAgentDir(),
    DO_NOT_TRACK: '1',
    NO_COLOR: '1'
  }
}

export function capturePrimeResourceCommand(
  command: Record<string, unknown>,
  cwd: string | null
): Promise<Record<string, unknown>> {
  const name = process.platform === 'win32' ? 'vengeance-prime-auth.exe' : 'vengeance-prime-auth'
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'prime-auth', name)
    : join(app.getAppPath(), 'resources', 'prime-auth', 'bin', name)
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ['--resources'],
      {
        cwd: cwd ?? undefined,
        windowsHide: true,
        env: primeEnvironment(),
        timeout: CAPTURE_TIMEOUT_MS,
        maxBuffer: RESOURCE_OUTPUT_LIMIT_BYTES
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Engine 2 could not read its resources. Refresh and try again.'))
          return
        }
        try {
          const response = jsonObject(JSON.parse(stdout))
          const result = jsonObject(response?.result)
          if (response?.ok !== true || !result) {
            throw new Error(
              typeof response?.error === 'string'
                ? response.error
                : 'The engine returned an invalid resource response.'
            )
          }
          resolve(result)
        } catch (failure) {
          reject(failure)
        }
      }
    )
    child.stdin?.on('error', reject)
    child.stdin?.end(JSON.stringify(command))
  })
}

export async function startPrimeCommand(
  args: string[],
  cwd: string | null,
  context: PrimeSettingsContext,
  changed: 'packages' | 'mcp',
  local = false
): Promise<string> {
  const location = await locatePrimeEngine(context.overridePath)
  const runId = `prime-process-${randomUUID()}`
  const child = spawn(location.executablePath, args, {
    cwd: cwd ?? undefined,
    windowsHide: true,
    env: primeEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  runs.set(runId, child)
  let settled = false
  const finish = (code: number | null, error?: string): void => {
    if (settled) return
    settled = true
    runs.delete(runId)
    context.broadcast?.('settings:process-done', { runId, ok: code === 0, code, error })
    if (code === 0) {
      context.broadcast?.('settings:changed', {
        area: changed,
        ...(local && cwd ? { project: { cwd, trusted: true } } : {})
      })
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (text: string) => {
    context.broadcast?.('settings:process-log', { runId, text, stream: 'stdout' })
  })
  child.stderr.on('data', (text: string) => {
    context.broadcast?.('settings:process-log', { runId, text, stream: 'stderr' })
  })
  child.once('error', (error) => finish(null, error.message))
  child.once('close', (code) => finish(code))
  return runId
}

export function cancelPrimeRun(runId: string): void {
  const child = runs.get(runId)
  if (child) killProcessTree(child)
}

export function stopPrimeRuns(): void {
  for (const child of runs.values()) killProcessTree(child)
  runs.clear()
}
