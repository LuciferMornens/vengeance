import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { JsonObject, JsonValue, SettingsFileState, SettingsScope } from '@shared/api/settings'
import { getPrimeAgentDir } from './locate'

const LOCK_ATTEMPTS = 10
const LOCK_RETRY_MS = 20
const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 40
const PRIVATE_FILE_MODE = 0o600
const SECRET_MASK = '••••'
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function primeProjectDir(cwd: string): string {
  return join(cwd, '.prime', 'agent')
}

export function expandPrimePath(value: string, base = process.cwd()): string {
  const home = process.env.HOME || homedir()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(home, value.slice(2))
  return isAbsolute(value) ? value : resolve(base, value)
}

export function primeSettingsPath(scope: SettingsScope, cwd: string | null): string {
  if (scope === 'global') return join(getPrimeAgentDir(), 'settings.json')
  if (!cwd) throw new Error('Choose a workspace before editing project settings.')
  return join(primeProjectDir(cwd), 'settings.json')
}

export function jsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as JsonObject
}

export function jsonStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}

export function assertSafeKey(key: string): void {
  if (!key || UNSAFE_KEYS.has(key)) throw new Error('Invalid configuration key.')
}

function stripJsonComments(text: string): string {
  let result = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++
      result += '\n'
      continue
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++
      index++
      result += ' '
      continue
    }
    result += character
  }
  return result
}

function withoutTrailingCommas(text: string): string {
  let result = ''
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === ',' && /^[\s]*[}\]]/.test(text.slice(index + 1))) continue
    result += character
  }
  return result
}

export function parsePrimeJson(text: string, comments = false): JsonObject {
  const document = comments ? withoutTrailingCommas(stripJsonComments(text)) : text
  const value: unknown = JSON.parse(document.replace(/^\uFEFF/, '') || '{}')
  const data = jsonObject(value)
  if (!data) throw new Error('The file must contain a JSON object.')
  return data
}

export async function readPrimeJson(path: string): Promise<SettingsFileState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { path, exists: false, text: '', data: {} }
    return { path, exists: true, text: '', data: {}, error: (error as Error).message }
  }
  try {
    return {
      path,
      exists: true,
      text,
      data: parsePrimeJson(text, basename(path) === 'models.json')
    }
  } catch {
    return {
      path,
      exists: true,
      text,
      data: {},
      error: `${basename(path)} must contain a valid JSON object.`
    }
  }
}

export function serializePrimeJson(data: JsonObject): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

async function acquirePrimeLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lockPath)
      return () => rmdir(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      await delay(LOCK_RETRY_MS)
    }
  }
  // Native writers use the same directory lock. Never steal a possibly active lock.
  throw new Error(`${basename(path)} is being changed by the engine. Try again shortly.`)
}

export async function writePrimeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporaryPath, 'wx', PRIVATE_FILE_MODE)
    try {
      await file.writeFile(text, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
      try {
        await rename(temporaryPath, path)
        return
      } catch (error) {
        const retryable = ['EPERM', 'EBUSY', 'EACCES'].includes(errorCode(error) ?? '')
        if (!retryable || attempt === RENAME_ATTEMPTS - 1) throw error
        await delay(RENAME_RETRY_MS * (attempt + 1))
      }
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function updatePrimeJson(
  path: string,
  mutate: (current: JsonObject) => JsonObject,
  replaceInvalid = false
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const release = await acquirePrimeLock(path)
  try {
    const current = await readPrimeJson(path)
    if (current.error && !replaceInvalid) {
      throw new Error(`${basename(path)} could not be read: ${current.error}`)
    }
    await writePrimeText(path, serializePrimeJson(mutate(current.data)))
  } finally {
    await release()
  }
}

export function setPrimeValue(
  data: JsonObject,
  parts: string[],
  value: JsonValue | undefined
): JsonObject {
  const [key, ...remaining] = parts
  if (!key) throw new Error('Choose a configuration field to change.')
  assertSafeKey(key)
  const result = { ...data }
  if (!remaining.length) {
    if (value === undefined) delete result[key]
    else result[key] = value
    return result
  }
  const updated = setPrimeValue(jsonObject(data[key]) ?? {}, remaining, value)
  if (Object.keys(updated).length) result[key] = updated
  else delete result[key]
  return result
}

function secretString(value: string): boolean {
  if (!value || value.startsWith('!')) return false
  if (/^\$\{?[A-Z][A-Z0-9_]*\}?$/.test(value)) return false
  if (/^[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET)$/.test(value)) return false
  return value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').trim() !== ''
}

export function maskPrimeSecret(value: string): string {
  return value.length >= 12 ? `${SECRET_MASK}${value.slice(-4)}` : SECRET_MASK
}

function secretField(key: string, parent: string): boolean {
  return (
    parent === 'headers' ||
    parent === 'env' ||
    /^(apiKey|key|token|access|refresh|bearer|clientSecret)$/i.test(key)
  )
}

export function maskPrimeSecrets(data: JsonObject): JsonObject {
  function visit(value: JsonValue, key: string, parent: string): JsonValue {
    if (typeof value === 'string' && secretField(key, parent) && secretString(value)) {
      return maskPrimeSecret(value)
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, '', key))
    const object = jsonObject(value)
    if (!object) return value
    return Object.fromEntries(
      Object.entries(object).map(([child, item]) => [child, visit(item, child, key)])
    )
  }
  return visit(data, '', '') as JsonObject
}

export function mergePrimeSettings(base: JsonObject, overrides: JsonObject): JsonObject {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(overrides)])]
      .map((key) => {
        const original = base[key]
        const replacement = overrides[key]
        const originalObject = jsonObject(original)
        const replacementObject = jsonObject(replacement)
        return [
          key,
          replacement === null || replacement === undefined
            ? original
            : originalObject && replacementObject
              ? mergePrimeSettings(originalObject, replacementObject)
              : replacement
        ]
      })
      .filter((entry) => entry[1] !== undefined)
  )
}

export function restorePrimeSecrets(data: JsonObject, stored: JsonObject): JsonObject {
  function visit(value: JsonValue, original: JsonValue | undefined): JsonValue {
    if (typeof value === 'string' && value.startsWith(SECRET_MASK)) {
      if (typeof original !== 'string' || maskPrimeSecret(original) !== value) {
        throw new Error('A masked credential no longer matches its saved value. Enter it again.')
      }
      return original
    }
    if (Array.isArray(value)) {
      const originals = Array.isArray(original) ? original : []
      return value.map((item, index) => {
        const identifier = jsonObject(item)?.id
        const match = identifier
          ? originals.find((candidate) => jsonObject(candidate)?.id === identifier)
          : originals[index]
        return visit(item, match)
      })
    }
    const object = jsonObject(value)
    if (!object) return value
    const originalObject = jsonObject(original) ?? {}
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, visit(item, originalObject[key])])
    )
  }
  return visit(data, stored) as JsonObject
}

export function safePrimeFileState(state: SettingsFileState): SettingsFileState {
  const data = maskPrimeSecrets(state.data)
  return { ...state, data, text: state.error || !state.exists ? '' : serializePrimeJson(data) }
}
