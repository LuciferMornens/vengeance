import { execFile } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { shell } from 'electron'
import type { ForkPoint, SessionListItem, SessionListResult } from '@shared/api/sessions'
import type { FlatSessionTree, SessionEntry } from '@shared/engine-types'
import { locateEngine } from '../../engine/locate'
import { engineEnv } from '../../engine/runtime'
import { flattenSessionTree } from '../../engine/session-tree'
import { comparablePath, isInside, samePath } from '../../paths'
import { readJsonFile, replaceFile } from '../settings/json-file'
import { piConfig, piPaths, piSessions, type PiSessionHeader } from '../settings/pi-modules'
import { mapSessionFiles, readIndexedSessionHeader, SessionIndex, sessionFilesIn } from './index'

export type { PiSessionHeader }

const execFileAsync = promisify(execFile)

/**
 * Where the engine keeps sessions: finding session files needs only the agent dir and the `sessionDir` settings.
 * Reading and editing a saved session loads the engine's SessionManager (`piSessions`) on first use.
 */
export interface SessionStorage {
  agentDir: string
  /** pi `normalizePath` (`dist/utils/paths.js`), as the settings manager applies it to `sessionDir`. */
  normalizePath: (path: string) => string
}

const FALLBACK_SESSION_VERSION = 3

export async function sessionStorage(overridePath: string | null): Promise<SessionStorage> {
  const [config, paths] = await Promise.all([piConfig(overridePath), piPaths(overridePath)])
  return { agentDir: config.getAgentDir(), normalizePath: paths.normalizePath }
}

/** `CURRENT_SESSION_VERSION` of the installed engine (header version of exported files). */
export async function sessionVersion(overridePath: string | null): Promise<number> {
  const version = (await piSessions(overridePath)).CURRENT_SESSION_VERSION
  return typeof version === 'number' ? version : FALLBACK_SESSION_VERSION
}

/**
 * Load the engine's saved-session module ahead of a likely edit (a session menu opened, a rename started), so the
 * first rename, branch, tree or export does not pay its one-time import. Failures surface on the real operation.
 */
export async function prewarmSessionFiles(overridePath: string | null): Promise<void> {
  await piSessions(overridePath).then(
    () => undefined,
    () => undefined
  )
}

async function openSession(overridePath: string | null, path: string) {
  return (await piSessions(overridePath)).SessionManager.open(path)
}

/** pi's env override for session storage (`PI_CODING_AGENT_SESSION_DIR`, see docs/sessions.md). */
const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

function expandTilde(path: string): string {
  return path === '~'
    ? homedir()
    : path.startsWith('~/') || path.startsWith('~\\')
      ? join(homedir(), path.slice(2))
      : path
}

/**
 * Custom session storage the engine itself would use when started in `cwd` (env, then the
 * `sessionDir` setting incl. project settings), or undefined for pi's per-workspace default.
 */
function customSessionDir(storage: SessionStorage, cwd: string | null): string | undefined {
  const fromEnv = process.env[SESSION_DIR_ENV]
  if (fromEnv) return resolve(expandTilde(fromEnv))
  try {
    const dir = configuredSessionDir(storage, cwd)
    return dir ? resolve(cwd ?? homedir(), expandTilde(dir)) : undefined
  } catch {
    return undefined
  }
}

/**
 * The `sessionDir` setting as pi 1.1.0's SettingsManager reads it: in `cwd`, the project's `.pi/settings.json`
 * over the agent dir's, normalized (`getSessionDir`); without a workspace, the agent dir's own value. Read from
 * the files, so the main process does not load the settings manager (it pulls in pi-ai).
 */
function configuredSessionDir(storage: SessionStorage, cwd: string | null): string | undefined {
  const global = readJsonFile(join(storage.agentDir, 'settings.json')).data.sessionDir
  if (cwd === null) return typeof global === 'string' ? global : undefined
  const project = readJsonFile(join(resolve(cwd), '.pi', 'settings.json')).data.sessionDir
  const value = project !== undefined ? project : global
  return typeof value === 'string' && value ? storage.normalizePath(value) : undefined
}

/** pi's default per-workspace folder: `<agentDir>/sessions/--<cwd with / \ : → ->--`. */
function defaultSessionDir(agentDir: string, cwd: string): string {
  const encoded = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'sessions', encoded)
}

/** Folder the engine stores sessions in when it runs in `cwd`. */
export function sessionDirFor(storage: SessionStorage, cwd: string): string {
  return rememberedCustomDir(storage, cwd) ?? defaultSessionDir(storage.agentDir, cwd)
}

function rememberedCustomDir(storage: SessionStorage, cwd: string | null): string | undefined {
  const dir = customSessionDir(storage, cwd)
  if (dir) rememberSessionRoot(dir)
  return dir
}

// ─── Allowed roots (S3: file operations stay inside session folders) ────────────────────────────

/** Custom session folders seen while listing/importing (project `sessionDir` settings). */
const knownRoots = new Set<string>()

export function rememberSessionRoot(dir: string): void {
  knownRoots.add(comparablePath(dir))
}

function allowedRoots(storage: SessionStorage): string[] {
  const roots = [join(storage.agentDir, 'sessions'), ...knownRoots]
  const global = customSessionDir(storage, null)
  if (global) roots.push(global)
  return roots
}

/** Throw unless `path` is an existing `.jsonl` file inside a session folder the engine uses. */
export function assertSessionFile(storage: SessionStorage, path: string): void {
  if (!path.toLowerCase().endsWith('.jsonl')) throw new Error('Not a session file')
  if (!allowedRoots(storage).some((root) => !samePath(root, path) && isInside(root, path))) {
    throw new Error('This file is outside the session folders')
  }
  if (!existsSync(path)) throw new Error(`Session file not found: ${path}`)
}

/** Throw unless `path` is a session file in a folder the engine stores sessions in. */
async function assertStoredSession(overridePath: string | null, path: string): Promise<void> {
  const storage = await sessionStorage(overridePath)
  const header = await readSessionHeader(path)
  if (header.cwd) rememberedCustomDir(storage, header.cwd)
  assertSessionFile(storage, path)
}

// ─── Listing ─────────────────────────────────────────────────────────────────

const sessionIndex = new SessionIndex()
const pendingListings = new Map<string, Promise<SessionListResult>>()
const pendingDiscoveries = new Map<string, Promise<DiscoveredWorkspace[]>>()

interface DiscoveredWorkspace {
  path: string
  lastActivityAt: number
}

/** pi-subagents' per-task folders inside a run folder: `run-0`, `run-1`, … */
const SUBAGENT_TASK_FOLDER = /^run-\d+$/

/** Subfolders of `dir` (none when it does not exist). */
async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Child sessions pi-subagents writes next to a parent session `<folder>/<name>.jsonl`, in
 * `<folder>/<name>/<run id>/run-<n>/*.jsonl`. The SDK lists only a folder's top level.
 */
async function subagentChildren(parents: SessionListItem[]): Promise<SessionListItem[]> {
  const parentDirectories = [...new Set(parents.map((parent) => dirname(parent.path)))]
  const childDirectories = new Set(
    (
      await mapSessionFiles(parentDirectories, async (directory) =>
        (await subfolders(directory)).map((folder) => comparablePath(join(directory, folder)))
      )
    ).flat()
  )
  const parentsWithChildren = parents.filter((parent) =>
    childDirectories.has(
      comparablePath(join(dirname(parent.path), basename(parent.path, '.jsonl')))
    )
  )
  const children = await mapSessionFiles(parentsWithChildren, async (parent) => {
    const runsDir = join(dirname(parent.path), basename(parent.path, '.jsonl'))
    const found: SessionListItem[] = []
    for (const runId of await subfolders(runsDir)) {
      for (const task of (await subfolders(join(runsDir, runId))).filter((name) =>
        SUBAGENT_TASK_FOLDER.test(name)
      )) {
        const sessions = await sessionIndex.list([join(runsDir, runId, task)])
        found.push(
          ...sessions.map((info) => ({ ...info, subagentRun: { parentPath: parent.path, runId } }))
        )
      }
    }
    return found
  })
  return children.flat()
}

/** Listed sessions plus the subagent children stored under them. */
async function withSubagentChildren(sessions: SessionListItem[]): Promise<SessionListItem[]> {
  return [...sessions, ...(await subagentChildren(sessions))]
}

async function allSessionDirectories(storage: SessionStorage): Promise<string[]> {
  const root = join(storage.agentDir, 'sessions')
  const defaults = (await subfolders(root)).map((folder) => join(root, folder))
  const custom = rememberedCustomDir(storage, null)
  const directories = [...defaults, ...knownRoots, ...(custom ? [custom] : [])]
  return [
    ...new Map(directories.map((directory) => [comparablePath(directory), directory])).values()
  ]
}

/** Workspace discovery reads headers, including known project-specific storage roots. */
export async function discoverSessionWorkspaces(
  overridePath: string | null,
  knownCwds: string[] = []
): Promise<DiscoveredWorkspace[]> {
  const key = JSON.stringify([overridePath, [...knownCwds].map(comparablePath).sort()])
  const pending = pendingDiscoveries.get(key)
  if (pending) return pending
  const request = loadSessionWorkspaces(overridePath, knownCwds)
  pendingDiscoveries.set(key, request)
  try {
    return await request
  } finally {
    pendingDiscoveries.delete(key)
  }
}

async function loadSessionWorkspaces(
  overridePath: string | null,
  knownCwds: string[]
): Promise<DiscoveredWorkspace[]> {
  const storage = await sessionStorage(overridePath)
  for (const cwd of knownCwds) rememberedCustomDir(storage, cwd)
  const directories = await allSessionDirectories(storage)
  const files = (await mapSessionFiles(directories, sessionFilesIn)).flat()
  const workspaces = new Map<string, DiscoveredWorkspace>()
  await mapSessionFiles(files, async (path) => {
    const result = await sessionIndex.header(path)
    if (!result?.header.cwd) return
    const key = comparablePath(result.header.cwd)
    const workspace = workspaces.get(key)
    if (!workspace || result.modifiedAt > workspace.lastActivityAt) {
      workspaces.set(key, { path: result.header.cwd, lastActivityAt: result.modifiedAt })
    }
  })
  return [...workspaces.values()].sort(
    (first, second) => second.lastActivityAt - first.lastActivityAt
  )
}

export async function sessionsRoots(
  overridePath: string | null,
  cwd: string | null,
  knownCwds: string[] = []
): Promise<string[]> {
  const storage = await sessionStorage(overridePath)
  for (const knownCwd of knownCwds) rememberedCustomDir(storage, knownCwd)
  const custom = rememberedCustomDir(storage, cwd)
  if (cwd !== null) return [custom ?? join(storage.agentDir, 'sessions')]
  const roots = [join(storage.agentDir, 'sessions'), ...knownRoots]
  return roots.filter(
    (root, index) =>
      !roots.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          isInside(other, root) &&
          (!samePath(root, other) || otherIndex < index)
      )
  )
}

export async function listSessions(
  overridePath: string | null,
  cwd: string | null
): Promise<SessionListResult> {
  const key = JSON.stringify([overridePath, cwd === null ? null : comparablePath(cwd)])
  const pending = pendingListings.get(key)
  if (pending) return pending
  const request = loadSessions(overridePath, cwd)
  pendingListings.set(key, request)
  try {
    return await request
  } finally {
    pendingListings.delete(key)
  }
}

async function loadSessions(
  overridePath: string | null,
  cwd: string | null
): Promise<SessionListResult> {
  const storage = await sessionStorage(overridePath)
  const dir = rememberedCustomDir(storage, cwd)
  if (cwd === null) {
    const sessions = await sessionIndex.list(await allSessionDirectories(storage))
    return {
      sessions: await withSubagentChildren(sessions),
      sessionDir: dir ?? join(storage.agentDir, 'sessions')
    }
  }
  // Listing must stay read-only: pi's list(cwd) creates the default folder when missing.
  const folder = dir ?? defaultSessionDir(storage.agentDir, cwd)
  if (!existsSync(folder)) return { sessions: [], sessionDir: folder }
  const sessions = await sessionIndex.list([folder])
  const filtered = dir
    ? sessions.filter((session) => session.cwd && samePath(session.cwd, cwd))
    : sessions
  return { sessions: await withSubagentChildren(filtered), sessionDir: folder }
}

// ─── File operations (closed sessions) ──────────────────────────────────────

export async function renameSession(
  overridePath: string | null,
  path: string,
  name: string
): Promise<void> {
  await assertStoredSession(overridePath, path)
  ;(await openSession(overridePath, path)).appendSessionInfo(name.trim())
}

export async function trashSession(overridePath: string | null, path: string): Promise<void> {
  await assertStoredSession(overridePath, path)
  await shell.trashItem(path)
}

export async function branchSession(
  overridePath: string | null,
  path: string,
  entryId: string
): Promise<string> {
  await assertStoredSession(overridePath, path)
  const created = (await openSession(overridePath, path)).createBranchedSession(entryId)
  if (!created) throw new Error('The engine did not create a session file')
  return created
}

export async function sessionTree(
  overridePath: string | null,
  path: string
): Promise<FlatSessionTree> {
  await assertStoredSession(overridePath, path)
  const manager = await openSession(overridePath, path)
  return { nodes: flattenSessionTree(manager.getTree()), leafId: manager.getLeafId() }
}

export async function setSessionLabel(
  overridePath: string | null,
  path: string,
  entryId: string,
  label: string | undefined
): Promise<void> {
  await assertStoredSession(overridePath, path)
  const trimmed = label?.trim()
  ;(await openSession(overridePath, path)).appendLabelChange(entryId, trimmed ? trimmed : undefined)
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
    )
    .join('')
}

export async function forkPoints(overridePath: string | null, path: string): Promise<ForkPoint[]> {
  await assertStoredSession(overridePath, path)
  return (await openSession(overridePath, path))
    .getBranch()
    .flatMap((entry) => {
      if (entry.type !== 'message' || entry.message.role !== 'user') return []
      const text = messageText(entry.message.content).trim()
      if (!text) return []
      const timestamp = entry.message.timestamp ?? new Date(entry.timestamp).getTime()
      return [{ entryId: entry.id, parentId: entry.parentId, text, timestamp }]
    })
}

/** Header of a session file (first line), read without loading the transcript. */
export async function readSessionHeader(path: string): Promise<PiSessionHeader> {
  return readIndexedSessionHeader(path)
}

export async function sessionCwd(overridePath: string | null, path: string): Promise<string> {
  await assertStoredSession(overridePath, path)
  return (await readSessionHeader(path)).cwd
}

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * pi's JSONL export (`serializeSessionBranch`): a fresh header and the active branch root → leaf,
 * with parent links rewritten into a single line.
 */
export function serializeBranch(
  version: number,
  sessionId: string,
  cwd: string,
  branch: SessionEntry[]
): string {
  const header: PiSessionHeader = {
    type: 'session',
    version,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd
  }
  const lines: object[] = [header]
  let parentId: string | null = null
  for (const entry of branch) {
    lines.push({ ...entry, parentId })
    parentId = entry.id
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** Entries on the path root → `leafId` of an entry list (`get_entries`). */
export function branchOf(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const path: SessionEntry[] = []
  for (let id = leafId; id; ) {
    const entry = byId.get(id)
    if (!entry) break
    path.push(entry)
    id = entry.parentId
  }
  return path.reverse()
}

/** JSONL export of a closed session's active branch. */
export async function exportSessionJsonl(
  overridePath: string | null,
  path: string,
  outputPath: string
): Promise<void> {
  await assertStoredSession(overridePath, path)
  const manager = await openSession(overridePath, path)
  await replaceFile(
    outputPath,
    serializeBranch(
      await sessionVersion(overridePath),
      manager.getSessionId(),
      manager.getCwd(),
      manager.getBranch()
    )
  )
}

const HTML_EXPORT_TIMEOUT_MS = 60_000

/** Closed sessions export HTML through the CLI (`pi --export <session> <out>`). */
export async function exportSessionWithCli(
  overridePath: string | null,
  path: string,
  outputPath: string
): Promise<void> {
  await assertStoredSession(overridePath, path)
  const location = await locateEngine(overridePath)
  await execFileAsync(location.node.path, [location.cliPath, '--export', path, outputPath], {
    env: engineEnv(location),
    windowsHide: true,
    timeout: HTML_EXPORT_TIMEOUT_MS
  })
}

// ─── Watching ────────────────────────────────────────────────────────────────

const WATCH_DEBOUNCE_MS = 350

interface WatchedSessionsRoot {
  watcher: FSWatcher
  timer: NodeJS.Timeout | null
}

/** Recursive watchers follow the requested storage roots and release roots no longer in scope. */
export class SessionsWatcher {
  private readonly roots = new Map<string, WatchedSessionsRoot>()

  constructor(private readonly onChange: (root: string) => void) {}

  watch(requested: string | string[]): void {
    const roots = new Set(
      (typeof requested === 'string' ? [requested] : requested).map(comparablePath)
    )
    for (const root of this.roots.keys()) {
      if (!roots.has(root)) this.closeRoot(root)
    }
    for (const root of roots) {
      if (this.roots.has(root) || !existsSync(root)) continue
      try {
        const watcher = watch(root, { recursive: true }, (event, file) => {
          if (event !== 'rename' && file && !String(file).toLowerCase().endsWith('.jsonl')) return
          const watched = this.roots.get(root)
          if (!watched) return
          if (watched.timer) clearTimeout(watched.timer)
          watched.timer = setTimeout(() => {
            watched.timer = null
            this.onChange(root)
          }, WATCH_DEBOUNCE_MS)
        })
        this.roots.set(root, { watcher, timer: null })
        watcher.on('error', () => this.closeRoot(root))
      } catch {
        this.closeRoot(root)
      }
    }
  }

  private closeRoot(root: string): void {
    const watched = this.roots.get(root)
    if (!watched) return
    watched.watcher.close()
    if (watched.timer) clearTimeout(watched.timer)
    this.roots.delete(root)
  }

  close(): void {
    for (const root of this.roots.keys()) this.closeRoot(root)
  }
}
