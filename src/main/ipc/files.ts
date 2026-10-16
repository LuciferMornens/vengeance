import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { FileMatch, ReadFileOptions, ReadFileResult } from '@shared/api/system'
import { isInside, samePath } from '../paths'

const execFileAsync = promisify(execFile)

const DEFAULT_READ_BYTES = 512 * 1024
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_FILES = 50_000
const CACHE_MS = 15_000

/** Folders the renderer may read from, and files it may never read (credentials). */
export interface ReadAccess {
  allowedRoots: string[]
  deniedFiles: string[]
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Pure access rule (paths already resolved): inside an allowed root and not a denied file. */
export function isReadAllowed(target: string, access: ReadAccess): boolean {
  if (access.deniedFiles.some((file) => samePath(file, target))) return false
  return access.allowedRoots.some((root) => isInside(root, target))
}

export async function readFileBounded(path: string, options: ReadFileOptions | undefined, access: ReadAccess): Promise<ReadFileResult> {
  const target = isAbsolute(path) ? path : resolve(options?.cwd ?? process.cwd(), path)
  const limit = Math.min(options?.maxBytes ?? DEFAULT_READ_BYTES, MAX_READ_BYTES)
  const info = await stat(target)
  if (!info.isFile()) throw new Error(`Not a file: ${target}`)
  // Compare real paths so symlinks/junctions cannot escape the allowed folders.
  const [real, roots, denied] = await Promise.all([
    realOrResolved(target),
    Promise.all(access.allowedRoots.map(realOrResolved)),
    Promise.all(access.deniedFiles.map(realOrResolved))
  ])
  if (!isReadAllowed(real, { allowedRoots: roots, deniedFiles: denied }) || !isReadAllowed(target, access)) {
    throw new Error(`Reading ${target} is not allowed (only files in open workspaces and session folders)`)
  }
  const handle = await open(target, 'r')
  try {
    const length = Math.min(info.size, limit)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const binary = buffer.subarray(0, Math.min(length, 8000)).includes(0)
    return {
      path: target,
      size: info.size,
      content: binary ? '' : buffer.toString('utf8'),
      truncated: info.size > limit,
      binary
    }
  } finally {
    await handle.close()
  }
}

const fileCache = new Map<string, { at: number; files: Promise<string[]> }>()

async function gitFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000
  })
  return stdout.split('\0').filter(Boolean).slice(0, MAX_FILES)
}

async function fdFiles(cwd: string): Promise<string[]> {
  const fd = join(homedir(), '.pi', 'agent', 'bin', process.platform === 'win32' ? 'fd.exe' : 'fd')
  if (!existsSync(fd)) throw new Error('fd not available')
  const { stdout } = await execFileAsync(fd, ['--type', 'f', '--hidden', '--exclude', '.git', '--max-results', String(MAX_FILES)], {
    cwd,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15_000
  })
  return stdout.split(/\r?\n/).filter(Boolean)
}

const WALK_SKIP = new Set(['.git', 'node_modules', 'dist', 'out', 'build', '.next', 'target', '.venv'])

async function walkFiles(cwd: string): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < MAX_FILES) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(join(cwd, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) queue.push(rel)
      } else if (entry.isFile()) files.push(rel)
    }
  }
  return files
}

function workspaceFiles(cwd: string): Promise<string[]> {
  const cached = fileCache.get(cwd)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.files
  const files = gitFiles(cwd)
    .catch(() => fdFiles(cwd))
    .catch(() => walkFiles(cwd))
    .then((list) => list.map((f) => f.split(sep).join('/')))
  fileCache.set(cwd, { at: Date.now(), files })
  files.catch(() => fileCache.delete(cwd))
  return files
}

/** Subsequence fuzzy score; higher is better, -1 = no match. Rewards basename hits and contiguous runs. */
export function fuzzyScore(path: string, query: string): number {
  if (!query) return 1
  const hay = path.toLowerCase()
  const needle = query.toLowerCase()
  const base = hay.slice(hay.lastIndexOf('/') + 1)
  if (base.startsWith(needle)) return 1000 - path.length
  if (base.includes(needle)) return 800 - path.length
  if (hay.includes(needle)) return 600 - path.length
  let score = 0
  let run = 0
  let from = 0
  for (const ch of needle) {
    const at = hay.indexOf(ch, from)
    if (at === -1) return -1
    run = at === from ? run + 1 : 0
    score += 1 + run * 2 + (at === 0 || hay[at - 1] === '/' || hay[at - 1] === '-' || hay[at - 1] === '_' || hay[at - 1] === '.' ? 3 : 0)
    from = at + 1
  }
  return score * 4 - path.length * 0.1
}

export async function listFiles(cwd: string, query: string, limit = 50): Promise<FileMatch[]> {
  const files = await workspaceFiles(resolve(cwd))
  const trimmed = query.trim().replace(/\\/g, '/')
  const matches: FileMatch[] = []
  for (const path of files) {
    const score = fuzzyScore(path, trimmed)
    if (score >= 0) matches.push({ path, score })
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return matches.slice(0, limit)
}

