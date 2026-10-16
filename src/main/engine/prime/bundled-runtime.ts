import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { BundledEngine } from '../bundled'

const pending = new Map<string, Promise<string>>()

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
    await cp(engine.packageDir, candidate, { recursive: true, errorOnExist: true })
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
