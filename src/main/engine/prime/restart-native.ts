import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'
import { primeHelperPath } from './helper'
import { asRecord, stringValue, type PrimeRecord } from './transport'

export interface PrimeRestartCheckpoint {
  agentDir: string
  socketPath: string
  nativeAgentId: string
  sessionPath: string
  rosterPath: string
  backupDir: string
  configPatch: PrimeRecord
}

const HELPER_TIMEOUT_MS = 15_000
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024
const HELPER_PROTOCOL = 1
const HELPER_REVISION = '763094e1b6a7c17450ee8399b06cda1853847ca5'
const executeFile = promisify(execFile)

export async function checkPrimeRestartHelper(): Promise<void> {
  await shellEnvironmentReady()
  const result = await executeFile(primeHelperPath(), ['--version'], {
    windowsHide: true,
    env: childBaseEnv(),
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: MAX_HELPER_OUTPUT_BYTES
  })
  const metadata = asRecord(JSON.parse(result.stdout))
  if (
    metadata.protocol !== HELPER_PROTOCOL ||
    metadata.revision !== HELPER_REVISION ||
    metadata.restartConfig !== true ||
    metadata.restartCapture !== true
  ) {
    throw new Error('Update Vengeance before restarting this Engine 2 session')
  }
}

export async function nativePrimeRestartCommand(
  operation: 'inspect' | 'workers' | 'capture' | 'patch' | 'rollback',
  checkpoint: PrimeRestartCheckpoint
): Promise<PrimeRecord> {
  await shellEnvironmentReady()
  return new Promise((resolve, reject) => {
    const child = spawn(primeHelperPath(), ['--restart-config'], {
      windowsHide: true,
      env: { ...childBaseEnv(), PRIME_AGENT_CODING_AGENT_DIR: checkpoint.agentDir },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const chunks: Buffer[] = []
    let outputLength = 0
    let failure: Error | undefined
    const timeout = setTimeout(() => {
      failure = new Error('Engine 2 timed out preparing the restart configuration')
      child.kill()
    }, HELPER_TIMEOUT_MS)
    child.once('error', (error) => {
      failure = error
    })
    child.stdin.on('error', (error) => {
      failure ??= error
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outputLength += chunk.length
      if (outputLength > MAX_HELPER_OUTPUT_BYTES) {
        failure = new Error('Engine 2 returned an oversized restart response')
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (failure) {
        reject(failure)
        return
      }
      try {
        const response = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (code !== 0 || response.ok !== true) {
          throw new Error(
            stringValue(response.error) ?? 'Engine 2 could not prepare its restart configuration'
          )
        }
        resolve(asRecord(response.result))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify({ operation, ...checkpoint }))
  })
}
