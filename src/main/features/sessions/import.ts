import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, parse } from 'node:path'
import type { ImportCandidate, ImportSessionArgs, ImportSessionResult } from '@shared/api/sessions'
import type { SessionEntry } from '@shared/engine-types'
import { directoryExists, samePath } from '../../paths'
import { piSessions } from '../settings/pi-modules'
import { rememberSessionRoot, sessionDirFor, sessionStorage, type PiSessionHeader } from './service'

/**
 * `/import` for the desktop: pi's `AgentSessionRuntime.importFromJsonl` needs an in-process runtime, so
 * the same steps run here instead — the file is copied (never moved or edited) into the session folder
 * of the folder it continues in, with pi's `-1`, `-2` … suffixes on name clashes, and then resumed
 * with `--session`. When the stored folder no longer exists (pi's "continue in current cwd" prompt),
 * the copy's header points at the target workspace instead.
 */

/** Largest file accepted for import (session files with images can be large). */
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c: { type?: string; text?: string }) =>
      c?.type === 'text' && typeof c.text === 'string' ? c.text : ''
    )
    .join(' ')
}

async function readSessionFile(
  overridePath: string | null,
  sourcePath: string
): Promise<{ content: string; header: PiSessionHeader; entries: SessionEntry[] }> {
  if (!sourcePath.toLowerCase().endsWith('.jsonl')) throw new Error('Choose a .jsonl session file')
  const size = statSync(sourcePath).size
  if (size > MAX_IMPORT_BYTES) throw new Error('This file is too large to import')
  const content = await readFile(sourcePath, 'utf8')
  const [header, ...entries] = (await piSessions(overridePath)).parseSessionEntries(content)
  if (!header || header.type !== 'session' || typeof header.id !== 'string')
    throw new Error('This file is not a session file')
  return {
    content,
    header,
    entries: entries.filter((e): e is SessionEntry => e.type !== 'session')
  }
}

/** Describe a picked file for the review step (read-only). */
export async function inspectImport(
  overridePath: string | null,
  sourcePath: string
): Promise<ImportCandidate> {
  const { header, entries } = await readSessionFile(overridePath, sourcePath)
  let messageCount = 0
  let firstMessage = ''
  let name: string | undefined
  for (const entry of entries) {
    if (entry.type === 'session_info') name = entry.name?.trim() || undefined
    if (entry.type !== 'message') continue
    const role = entry.message.role
    if (role === 'user' || role === 'assistant') messageCount++
    if (role === 'user' && !firstMessage)
      firstMessage = textOf(entry.message.content).replace(/\s+/g, ' ').trim()
  }
  const createdAt = new Date(header.timestamp).getTime()
  return {
    sourcePath,
    fileName: basename(sourcePath),
    sessionId: header.id,
    cwd: header.cwd,
    cwdExists: await directoryExists(header.cwd),
    name,
    firstMessage,
    messageCount,
    createdAt: Number.isNaN(createdAt) ? statSync(sourcePath).mtimeMs : createdAt
  }
}

function freeDestination(dir: string, fileName: string): string {
  const { name, ext } = parse(fileName)
  let destination = join(dir, fileName)
  for (let suffix = 1; existsSync(destination); suffix++)
    destination = join(dir, `${name}-${suffix}${ext}`)
  return destination
}

export async function importSession(
  overridePath: string | null,
  { sourcePath, fallbackCwd }: ImportSessionArgs
): Promise<ImportSessionResult> {
  const { content, header } = await readSessionFile(overridePath, sourcePath)
  const movedToFallback = !(await directoryExists(header.cwd))
  const cwd = movedToFallback ? fallbackCwd : header.cwd
  if (!(await directoryExists(cwd))) throw new Error('Choose an available workspace folder')
  const dir = sessionDirFor(await sessionStorage(overridePath), cwd)
  rememberSessionRoot(dir)
  const alreadyStored = samePath(join(dir, basename(sourcePath)), sourcePath)
  if (alreadyStored && !movedToFallback) return { path: sourcePath, cwd, movedToFallback }
  await mkdir(dir, { recursive: true })
  const destination = freeDestination(dir, basename(sourcePath))
  let copy = content
  if (movedToFallback) {
    const newline = content.indexOf('\n')
    const rest = newline >= 0 ? content.slice(newline) : '\n'
    copy = JSON.stringify({ ...header, cwd: fallbackCwd }) + rest
  }
  // 'wx': never overwrite a session that appeared between the check and the write.
  await writeFile(destination, copy, { encoding: 'utf8', flag: 'wx' })
  return { path: destination, cwd, movedToFallback }
}
