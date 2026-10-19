import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function nativeProcessIsAlive(processId: number): Promise<boolean> {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Engine 2 returned an invalid native process ID')
  }
  try {
    process.kill(processId, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another user's reused POSIX PID cannot belong to this runtime.
    if (code === 'ESRCH' || (code === 'EPERM' && process.platform !== 'win32')) return false
    throw error
  }
  if (process.platform !== 'linux') return true

  let information: string
  try {
    information = await readFile(join('/proc', String(processId), 'stat'), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ESRCH') return false
    throw error
  }
  // A zombie retains its PID until its parent reaps it, but cannot execute or hold runtime sockets.
  // The comm field can contain spaces and parentheses; state follows its final closing parenthesis.
  const close = information.lastIndexOf(')')
  const state = /^\s+([A-Za-z])(?:\s|$)/.exec(information.slice(close + 1))?.[1]
  if (!information.startsWith(`${processId} (`) || close < 0 || !state) {
    throw new Error(`Engine 2 could not inspect native process ${processId}`)
  }
  return state !== 'Z' && state !== 'X' && state !== 'x'
}
