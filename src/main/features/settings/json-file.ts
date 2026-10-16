import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { JsonObject } from '@shared/api/settings'
import { locateEngine } from '../../engine/locate'

/**
 * JSON config files owned by the engine (settings.json, models.json). Reads tolerate missing files;
 * writes take the same `proper-lockfile` lock pi's own SettingsManager uses, preserve every unknown
 * key, keep 2-space formatting and replace the file atomically (temp + rename).
 */

export interface JsonFileRead {
  exists: boolean
  text: string
  data: JsonObject
  error?: string
}

export function readJsonFile(path: string): JsonFileRead {
  if (!existsSync(path)) return { exists: false, text: '', data: {} }
  let text = ''
  try {
    text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return { exists: true, text: '', data: {}, error: (error as Error).message }
  }
  if (!text.trim()) return { exists: true, text, data: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { exists: true, text, data: {}, error: 'The file must contain a JSON object.' }
    // SAFETY: JSON.parse output checked to be a plain object above.
    return { exists: true, text, data: parsed as JsonObject }
  } catch (error) {
    return { exists: true, text, data: {}, error: (error as Error).message }
  }
}

interface LockfileModule {
  lockSync(path: string, options: { realpath: boolean }): () => void
}

let lockfile: LockfileModule | null | undefined

/** pi's own `proper-lockfile`, resolved from the installed engine so locks interoperate. */
async function engineLockfile(override: string | null): Promise<LockfileModule | null> {
  if (lockfile !== undefined) return lockfile
  try {
    const location = await locateEngine(override)
    const requireFromPi = createRequire(join(location.packageDir, 'package.json'))
    // SAFETY: proper-lockfile is a CommonJS dependency of pi exposing lockSync(path, { realpath }).
    lockfile = requireFromPi('proper-lockfile') as LockfileModule
  } catch {
    lockfile = null
  }
  return lockfile
}

function lockWithRetry(lock: LockfileModule, path: string): () => void {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return lock.lockSync(path, { realpath: false })
    } catch (error) {
      lastError = error
      if ((error as { code?: string }).code !== 'ELOCKED') throw error
      const until = Date.now() + 25
      while (Date.now() < until) {
        // Short synchronous wait, same strategy as pi's FileSettingsStorage.
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not lock the settings file')
}

export function serializeJson(data: JsonObject): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/** Windows: antivirus / the search indexer briefly hold files open, which makes rename fail transiently. */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_ATTEMPTS = 5

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** The text Vengeance last wrote to each config file, so the config watcher can tell its own writes from outside edits. */
const writtenTexts = new Map<string, string>()

function writtenKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** What Vengeance last wrote to `path` through writeFileAtomic (undefined when it never wrote it). */
export function lastWrittenText(path: string): string | undefined {
  return writtenTexts.get(writtenKey(path))
}

/** Write a config file atomically (`replaceFile`) and remember the text for the config watcher. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  // Recorded before the rename: the watcher's event for it can only arrive afterwards.
  writtenTexts.set(writtenKey(path), text)
  await replaceFile(path, text)
}

/**
 * Write temp + rename, so readers never see a half-written file; retries transient rename failures, and the temp
 * file never outlives the call.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, path)
        return
      } catch (error) {
        const code = (error as { code?: string }).code
        if (attempt >= RENAME_ATTEMPTS || !code || !TRANSIENT_RENAME_ERRORS.has(code)) throw error
        await sleep(40 * attempt)
      }
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Read-modify-write under the engine's lock. `mutate` receives the current object (throws when the existing
 * file is corrupt) and returns the next object.
 */
export async function updateJsonFile(path: string, override: string | null, mutate: (current: JsonObject) => JsonObject): Promise<void> {
  const lock = await engineLockfile(override)
  mkdirSync(dirname(path), { recursive: true })
  const release = lock ? lockWithRetry(lock, path) : null
  try {
    const current = readJsonFile(path)
    if (current.error && current.text.trim()) throw new Error(`${basename(path)} is not valid JSON (${current.error}). Fix it in Raw JSON first.`)
    await writeFileAtomic(path, serializeJson(mutate(current.data)))
  } finally {
    release?.()
  }
}

/** Replace the whole file with already validated text under the engine's lock, even when the current file is corrupt. */
export async function replaceJsonFile(path: string, override: string | null, text: string): Promise<void> {
  const lock = await engineLockfile(override)
  mkdirSync(dirname(path), { recursive: true })
  const release = lock ? lockWithRetry(lock, path) : null
  try {
    await writeFileAtomic(path, text)
  } finally {
    release?.()
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Immutable set/unset of a nested key; unset prunes parents that become empty. */
export function setAtPath(root: JsonObject, path: string[], value: JsonObject[string] | undefined): JsonObject {
  const [head, ...rest] = path
  if (head === undefined) return root
  const next: JsonObject = { ...root }
  if (rest.length === 0) {
    if (value === undefined) delete next[head]
    else next[head] = value
    return next
  }
  const child = isObject(root[head]) ? (root[head] as JsonObject) : {}
  const updated = setAtPath(child, rest, value)
  if (Object.keys(updated).length === 0) delete next[head]
  else next[head] = updated
  return next
}
