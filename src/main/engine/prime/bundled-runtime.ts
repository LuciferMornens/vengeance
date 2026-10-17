import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { BundledEngine } from '../bundled'

const executeFile = promisify(execFile)
const pending = new Map<string, Promise<string>>()

// A downloaded app quarantines every file it contains. Gatekeeper blocks a quarantined copy of an
// unnotarized executable, so the runtime copy of the already-approved app drops the attribute.
async function clearQuarantine(directory: string): Promise<void> {
  try {
    await executeFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', directory])
  } catch {
    // xattr reports files that never had the attribute; the copy runs without it either way.
  }
}

async function prepare(engine: BundledEngine, directory: string): Promise<string> {
  const executable = join(directory, basename(engine.entry))
  let existing = false
  try {
    existing = (await stat(directory)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing) {
    try {
      const receipt = await readFile(join(directory, '.vengeance-runtime'), 'utf8')
      if (receipt === engine.payloadHash && (await stat(executable)).isFile()) return executable
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    throw new Error(
      `Engine 2's runtime cache is damaged. Close its sessions, remove ${directory}, then restart Vengeance.`
    )
  }
  const candidate = `${directory}.staging-${randomUUID()}`
  await mkdir(dirname(directory), { recursive: true })
  // Resident daemons outlive the app, so their files must survive installer replacement of resources.
  try {
    // fs.cp applies each source file's mode to its copy, so executable bits carry over.
    await cp(engine.packageDir, candidate, { recursive: true, errorOnExist: true })
    if (process.platform === 'darwin') await clearQuarantine(candidate)
    if (process.platform !== 'win32') {
      try {
        await access(join(candidate, basename(engine.entry)), constants.X_OK)
      } catch {
        throw new Error('The bundled Engine 2 is damaged. Reinstall Vengeance.')
      }
    }
    await writeFile(join(candidate, '.vengeance-runtime'), engine.payloadHash)
    await rename(candidate, directory)
    return executable
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
}

export function bundledPrimeRuntime(engine: BundledEngine): Promise<string> {
  const directory = join(app.getPath('userData'), 'engines', 'bundled-prime', engine.payloadHash)
  const existing = pending.get(directory)
  if (existing) return existing
  const operation = prepare(engine, directory)
  pending.set(directory, operation)
  void operation.catch(() => pending.delete(directory))
  return operation
}
