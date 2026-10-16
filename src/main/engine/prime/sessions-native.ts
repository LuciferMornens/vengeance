import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { getPrimeAgentDir } from './locate'
import { asRecord, stringValue } from './transport'

const MAX_HELPER_OUTPUT_BYTES = 64 * 1024

type SessionCommand =
  | { operation: 'fork'; path: string; cwd: string; sessionDir: string }
  | { operation: 'branch'; path: string; entryId: string; sessionDir: string }

export function nativePrimeSessionCommand(command: SessionCommand): Promise<string> {
  const name = process.platform === 'win32' ? 'vengeance-prime-auth.exe' : 'vengeance-prime-auth'
  const executable = app.isPackaged
    ? join(process.resourcesPath, 'prime-auth', name)
    : join(app.getAppPath(), 'resources', 'prime-auth', 'bin', name)
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--session'], {
      windowsHide: true,
      env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: getPrimeAgentDir() },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const chunks: Buffer[] = []
    let length = 0
    let failure: Error | undefined
    child.once('error', reject)
    child.stdin.on('error', (error) => {
      failure ??= error
    })
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > MAX_HELPER_OUTPUT_BYTES) {
        failure = new Error('Engine 2 returned an oversized session response')
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.once('close', (code) => {
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error('Engine 2 could not create the session'))
      try {
        const response = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const path = stringValue(response.path)
        if (response.ok !== true || !path) {
          throw new Error(stringValue(response.error) ?? 'Engine 2 did not return a session path')
        }
        resolve(path)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(JSON.stringify(command))
  })
}
