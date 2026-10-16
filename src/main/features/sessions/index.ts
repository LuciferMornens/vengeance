import { createReadStream, type Stats } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionListItem } from '@shared/api/sessions'
import { comparablePath } from '../../paths'
import type { PiSessionHeader } from './service'

const SEARCH_TEXT_LIMIT = 4000
const MAX_CACHED_BYTES = 32 * 1024 * 1024
const MAX_CACHED_FILES = 8192
const MAX_CONCURRENT_READS = 4
const MAX_CONCURRENT_METADATA_READS = 16
const READ_BUFFER_BYTES = 64 * 1024
const HEADER_BUFFER_BYTES = 4096
const MAX_HEADER_SCAN_BYTES = 1024 * 1024
const CACHE_ENTRY_OVERHEAD_BYTES = 512

interface CachedFile {
  signature: string
  header: PiSessionHeader | null
  summary?: SessionListItem | null
  bytes: number
}

function fileSignature(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}

export async function mapSessionFiles<Value, Result>(
  values: readonly Value[],
  visit: (value: Value) => Promise<Result>
): Promise<Result[]> {
  let nextIndex = 0
  const results = new Array<Result>(values.length)
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await visit(values[index]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(values.length, MAX_CONCURRENT_METADATA_READS) }, worker)
  )
  return results
}

export async function sessionFilesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter(
        (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl')
      )
      .map((entry) => join(directory, entry.name))
      .sort((first, second) => second.localeCompare(first))
  } catch {
    return []
  }
}

async function* sessionLines(
  path: string,
  highWaterMark = READ_BUFFER_BYTES,
  maximumBytes?: number
): AsyncGenerator<string> {
  const stream = createReadStream(path, {
    encoding: 'utf8',
    highWaterMark,
    end: maximumBytes === undefined ? undefined : maximumBytes - 1
  })
  const fragments: string[] = []
  try {
    for await (const chunk of stream) {
      const text = String(chunk)
      let start = 0
      let newline = text.indexOf('\n')
      while (newline !== -1) {
        fragments.push(text.slice(start, newline))
        yield fragments.join('')
        fragments.length = 0
        start = newline + 1
        newline = text.indexOf('\n', start)
      }
      if (start < text.length) fragments.push(text.slice(start))
    }
    if (fragments.length) yield fragments.join('')
  } finally {
    stream.destroy()
  }
}

function parseEntry(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null
  try {
    const entry: unknown = JSON.parse(line)
    if (!entry) return null
    return typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
  } catch {
    return null
  }
}

function sessionHeader(entry: Record<string, unknown>): PiSessionHeader | null {
  if (entry.type !== 'session' || typeof entry.id !== 'string') return null
  return {
    ...entry,
    type: 'session',
    id: entry.id,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
    cwd: typeof entry.cwd === 'string' ? entry.cwd : ''
  }
}

export async function readIndexedSessionHeader(path: string): Promise<PiSessionHeader> {
  // The engine itself bounds header discovery to one MiB.
  for await (const line of sessionLines(path, HEADER_BUFFER_BYTES, MAX_HEADER_SCAN_BYTES)) {
    const entry = parseEntry(line)
    if (!entry) continue
    const header = sessionHeader(entry)
    if (header) return header
    break
  }
  throw new Error('This is not a session file')
}

function messageText(content: unknown, limit: number): string {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return ''
  let text = ''
  let textBlocks = 0
  for (const block of content) {
    if (block?.type !== 'text') continue
    const separator = textBlocks++ > 0 ? ' ' : ''
    text += (separator + (typeof block.text === 'string' ? block.text : '')).slice(
      0,
      limit - text.length
    )
    if (text.length >= limit) break
  }
  return text
}

function detachText(text: string): string {
  // A short V8 substring can otherwise keep an entire image-bearing JSON line alive.
  return Buffer.from(text, 'utf16le').toString('utf16le')
}

async function readSummary(
  path: string,
  stats: Stats,
  format: 'pi' | 'prime'
): Promise<{ header: PiSessionHeader; summary: SessionListItem } | null> {
  let header: PiSessionHeader | null = null
  let messageCount = 0
  let firstMessage = ''
  let searchText = ''
  let name: string | undefined
  let lastActivity: number | undefined

  for await (const line of sessionLines(path)) {
    const entry = parseEntry(line)
    if (!entry) continue
    if (
      format === 'prime' &&
      (typeof entry.type !== 'string' ||
        typeof entry.id !== 'string' ||
        typeof entry.timestamp !== 'string' ||
        (entry.parentId != null && typeof entry.parentId !== 'string') ||
        (entry.message != null &&
          (typeof entry.message !== 'object' || Array.isArray(entry.message))))
    )
      continue
    if (!header) {
      header = sessionHeader(entry)
      if (!header) return null
      continue
    }
    if (format === 'prime' && entry.type === 'session') {
      header = sessionHeader(entry)
      if (!header) return null
      continue
    }
    if (
      format === 'prime' &&
      entry.type === 'model_change' &&
      (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string')
    )
      return null
    if (entry.type === 'session_info') {
      name = typeof entry.name === 'string' ? entry.name.trim() || undefined : undefined
    }
    if (entry.type !== 'message') continue
    messageCount++
    const message = entry.message as Record<string, unknown> | undefined
    if (
      typeof message !== 'object' ||
      message === null ||
      (format === 'pi' && !('content' in message))
    )
      continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const validTimestamp =
      typeof message.timestamp === 'number' &&
      (format !== 'prime' || (Number.isInteger(message.timestamp) && message.timestamp >= 0))
    const activity = validTimestamp
      ? message.timestamp
      : format === 'prime'
        ? NaN
        : new Date(String(entry.timestamp)).getTime()
    if (typeof activity === 'number' && !Number.isNaN(activity)) {
      lastActivity = Math.max(lastActivity ?? 0, activity)
    }

    const needsFirstMessage = !firstMessage && message.role === 'user'
    if (!needsFirstMessage && searchText.length >= SEARCH_TEXT_LIMIT) continue
    const text = messageText(
      message.content,
      needsFirstMessage ? Infinity : SEARCH_TEXT_LIMIT - searchText.length
    )
    if (!text) continue
    if (needsFirstMessage) firstMessage = text
    if (searchText.length < SEARCH_TEXT_LIMIT) {
      searchText += `${searchText ? ' ' : ''}${text}`.slice(
        0,
        SEARCH_TEXT_LIMIT - searchText.length
      )
    }
  }
  if (!header) return null
  const createdAt = new Date(header.timestamp).getTime()
  return {
    header,
    summary: {
      path,
      id: header.id,
      cwd: header.cwd,
      name,
      parentSessionPath: header.parentSession,
      createdAt,
      modifiedAt:
        lastActivity !== undefined && lastActivity > 0
          ? lastActivity
          : Number.isNaN(createdAt)
            ? stats.mtimeMs
            : createdAt,
      messageCount,
      firstMessage:
        format === 'pi' && firstMessage === '(no messages)' ? '' : detachText(firstMessage),
      searchText: detachText(`${name ?? ''} ${searchText}`.toLowerCase())
    }
  }
}

/** Read-only metadata; transcript ownership and all mutations remain with the engine. */
export class SessionIndex {
  private readonly cache = new Map<string, CachedFile>()
  private readonly pending = new Map<string, Promise<SessionListItem | null>>()
  private readonly waiting: Array<() => void> = []
  private cachedBytes = 0
  private activeReads = 0

  constructor(private readonly format: 'pi' | 'prime' = 'pi') {}

  private async withReadSlot<Result>(read: () => Promise<Result>): Promise<Result> {
    if (this.activeReads >= MAX_CONCURRENT_READS) {
      await new Promise<void>((resolveRead) => this.waiting.push(resolveRead))
    } else {
      this.activeReads++
    }
    try {
      return await read()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.activeReads--
    }
  }

  private cached(path: string, signature: string): CachedFile | undefined {
    const cached = this.cache.get(path)
    if (!cached || cached.signature !== signature) return undefined
    this.cache.delete(path)
    this.cache.set(path, cached)
    return cached
  }

  private forget(path: string): void {
    const cached = this.cache.get(path)
    if (cached) this.cachedBytes -= cached.bytes
    this.cache.delete(path)
  }

  private remember(path: string, entry: Omit<CachedFile, 'bytes'>): void {
    const cached = this.cache.get(path)
    if (
      cached?.signature === entry.signature &&
      cached.summary !== undefined &&
      entry.summary === undefined
    )
      return
    this.forget(path)
    // UTF-16 string storage plus allowance for each map entry and metadata object.
    const summary = entry.summary
    const textLength =
      path.length +
      JSON.stringify(entry.header).length +
      (summary
        ? summary.path.length +
          summary.id.length +
          summary.cwd.length +
          (summary.name?.length ?? 0) +
          (summary.parentSessionPath?.length ?? 0) +
          summary.firstMessage.length +
          summary.searchText.length
        : 0)
    const bytes = textLength * 2 + CACHE_ENTRY_OVERHEAD_BYTES
    if (bytes > MAX_CACHED_BYTES) return
    while (this.cache.size >= MAX_CACHED_FILES || this.cachedBytes + bytes > MAX_CACHED_BYTES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
    this.cache.set(path, { ...entry, bytes })
    this.cachedBytes += bytes
  }

  async header(path: string): Promise<{ header: PiSessionHeader; modifiedAt: number } | null> {
    const key = comparablePath(path)
    try {
      const stats = await stat(path)
      const signature = fileSignature(stats)
      const cached = this.cached(key, signature)
      if (cached) {
        return cached.header ? { header: { ...cached.header }, modifiedAt: stats.mtimeMs } : null
      }
      return await this.withReadSlot(async () => {
        const header = await readIndexedSessionHeader(path).catch(() => null)
        this.remember(key, { signature, header })
        return header ? { header: { ...header }, modifiedAt: stats.mtimeMs } : null
      })
    } catch {
      this.forget(key)
      return null
    }
  }

  async summary(path: string): Promise<SessionListItem | null> {
    const key = comparablePath(path)
    const pending = this.pending.get(key)
    if (pending) {
      const summary = await pending
      return summary ? { ...summary } : null
    }
    const task = this.loadSummary(path, key)
    this.pending.set(key, task)
    try {
      const summary = await task
      return summary ? { ...summary } : null
    } finally {
      this.pending.delete(key)
    }
  }

  private async loadSummary(path: string, key: string): Promise<SessionListItem | null> {
    try {
      const stats = await stat(path)
      const signature = fileSignature(stats)
      const cached = this.cached(key, signature)
      if (cached?.summary !== undefined) return cached.summary
      return await this.withReadSlot(async () => {
        const result = await readSummary(path, stats, this.format)
        this.remember(key, {
          signature,
          header: result?.header ?? null,
          summary: result?.summary ?? null
        })
        return result?.summary ?? null
      })
    } catch {
      this.forget(key)
      return null
    }
  }

  async list(directories: string[]): Promise<SessionListItem[]> {
    const paths = (await mapSessionFiles(directories, sessionFilesIn)).flat()
    const summaries = await mapSessionFiles(paths, (path) => this.summary(path))
    return summaries
      .filter((summary): summary is SessionListItem => summary !== null)
      .sort((first, second) => second.modifiedAt - first.modifiedAt)
  }
}
