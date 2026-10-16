import { constants } from 'node:fs'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import { shell } from 'electron'
import type {
  ForkPoint,
  ImportCandidate,
  ImportSessionArgs,
  ImportSessionResult,
  SessionExportFormat,
  SessionListQuery,
  SessionListResult,
  WorkspaceDiscovery
} from '@shared/api/sessions'
import type { FlatSessionTree } from '@shared/engine-types'
import { mapSessionFiles, SessionIndex, sessionFilesIn } from '../../features/sessions/index'
import { comparablePath, directoryExists, isInside, samePath } from '../../paths'
import { connectPrimeResident, primeDaemonCommand, withPrimeServiceSession } from './daemon'
import { getPrimeAgentDir } from './locate'
import { normalizeTree } from './normalize'
import { nativePrimeSessionCommand } from './sessions-native'
import { resolvePrimeSessionRoot, type PrimeSessionPathOptions } from './session-paths'
import { asRecord, stringValue } from './transport'

const sessionIndex = new SessionIndex('prime')
const knownRoots = new Set<string>()
const pendingListings = new Map<string, Promise<SessionListResult>>()
const pendingDiscoveries = new Map<string, Promise<WorkspaceDiscovery[]>>()

export async function primeSessionRoot(
  cwd?: string | null,
  options: PrimeSessionPathOptions = {}
): Promise<string> {
  const root = await resolvePrimeSessionRoot(cwd, options)
  knownRoots.add(comparablePath(root))
  return root
}

export async function primeSessionRoots(knownCwds: string[] = []): Promise<string[]> {
  await primeSessionRoot()
  await mapSessionFiles(knownCwds, (cwd) => primeSessionRoot(cwd))
  const directories = new Map<string, string>()
  for (const directory of [join(getPrimeAgentDir(), 'sessions'), ...knownRoots]) {
    const key = comparablePath(directory)
    if (!directories.has(key)) directories.set(key, directory)
  }
  return [...directories.values()]
}

function validPrimeId(identifier: string): boolean {
  return (
    identifier !== '' && identifier !== '.' && identifier !== '..' && !/[/\\:]/.test(identifier)
  )
}

export async function primeSessionIdentity(
  path: string
): Promise<{ cwd: string; engine: 'prime' } | null> {
  if (!path.toLowerCase().endsWith('.jsonl')) return null
  const result = await sessionIndex.header(path)
  if (!result || !validPrimeId(result.header.id)) return null
  const roots = await primeSessionRoots(result.header.cwd ? [result.header.cwd] : [])
  if (!roots.some((root) => !samePath(root, path) && isInside(root, path))) return null
  return { cwd: result.header.cwd, engine: 'prime' }
}

async function requirePrimeSession(path: string): Promise<{ cwd: string; engine: 'prime' }> {
  const identity = await primeSessionIdentity(path)
  if (!identity) throw new Error('This file is not in an Engine 2 session folder')
  return identity
}

export async function listPrimeSessions(
  query: SessionListQuery,
  _overridePath?: string | null
): Promise<SessionListResult> {
  const key = JSON.stringify([getPrimeAgentDir(), query.cwd])
  const pending = pendingListings.get(key)
  if (pending) return pending
  const request = loadPrimeSessions(query)
  pendingListings.set(key, request)
  try {
    return await request
  } finally {
    pendingListings.delete(key)
  }
}

async function loadPrimeSessions(query: SessionListQuery): Promise<SessionListResult> {
  const sessionDir = await primeSessionRoot(query.cwd)
  const directories = query.cwd ? [sessionDir] : await primeSessionRoots()
  const sessions = await sessionIndex.list(directories)
  return {
    sessionDir,
    sessions: sessions
      .filter(
        (session) =>
          validPrimeId(session.id) &&
          (!query.cwd || (!!session.cwd && samePath(session.cwd, query.cwd)))
      )
      .map((session) => ({ ...session, engine: 'prime' }))
  }
}

export async function discoverPrimeWorkspaces(
  _overridePath?: string | null,
  knownCwds: string[] = []
): Promise<WorkspaceDiscovery[]> {
  const directories = await primeSessionRoots(knownCwds)
  const key = JSON.stringify(directories.map(comparablePath).sort())
  const pending = pendingDiscoveries.get(key)
  if (pending) return pending
  const request = loadPrimeWorkspaces(directories)
  pendingDiscoveries.set(key, request)
  try {
    return await request
  } finally {
    pendingDiscoveries.delete(key)
  }
}

async function loadPrimeWorkspaces(directories: string[]): Promise<WorkspaceDiscovery[]> {
  const files = (await mapSessionFiles(directories, sessionFilesIn)).flat()
  const workspaces = new Map<string, WorkspaceDiscovery>()
  await mapSessionFiles(files, async (path) => {
    const result = await sessionIndex.header(path)
    if (!result?.header.cwd || !validPrimeId(result.header.id)) return
    const key = comparablePath(result.header.cwd)
    const workspace = workspaces.get(key)
    if (!workspace || workspace.lastActivityAt < result.modifiedAt) {
      workspaces.set(key, {
        path: result.header.cwd,
        lastActivityAt: result.modifiedAt,
        engine: 'prime'
      })
    }
  })
  return [...workspaces.values()].sort(
    (first, second) => second.lastActivityAt - first.lastActivityAt
  )
}

export async function primeSessionCwd(path: string): Promise<string> {
  return (await requirePrimeSession(path)).cwd
}

export async function renamePrimeSession(
  path: string,
  name: string,
  overridePath?: string | null
): Promise<void> {
  await requirePrimeSession(path)
  const resident = await connectPrimeResident(
    { sessionPath: path },
    { executablePath: overridePath }
  )
  if (resident) {
    try {
      await resident.client.request('rename_saved_session', {
        sessionPath: path,
        name: name.trim()
      })
      return
    } finally {
      resident.client.close()
    }
  }
  await primeDaemonCommand(
    'rename_saved_session',
    { sessionPath: path, name: name.trim() },
    {
      executablePath: overridePath
    }
  )
}

export async function deletePrimeSession(
  path: string,
  overridePath?: string | null
): Promise<void> {
  await requirePrimeSession(path)
  const resident = await connectPrimeResident(
    { sessionPath: path },
    { executablePath: overridePath }
  )
  if (resident) {
    try {
      await resident.client.request('kill', { activeSessionId: resident.nativeAgentId }, 0)
    } finally {
      resident.client.close()
    }
  }
  await shell.trashItem(path)
}

export async function primeSessionTree(
  path: string,
  overridePath?: string | null
): Promise<FlatSessionTree> {
  const { cwd } = await requirePrimeSession(path)
  return withPrimeServiceSession(
    cwd,
    async (request) => normalizeTree(await request('get_session_tree')),
    path,
    { executablePath: overridePath }
  )
}

export async function primeForkPoints(
  path: string,
  overridePath?: string | null
): Promise<ForkPoint[]> {
  const tree = await primeSessionTree(path, overridePath)
  return tree.nodes.flatMap(({ entry }) => {
    if (entry.type !== 'message' || entry.message.role !== 'user') return []
    const content = entry.message.content
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((block) => block.type === 'text')
            .map((block) => ('text' in block ? block.text : ''))
            .join('')
    if (!text) return []
    return [
      {
        entryId: entry.id,
        parentId: entry.parentId,
        text,
        timestamp: entry.message.timestamp ?? new Date(entry.timestamp).getTime()
      }
    ]
  })
}

export async function inspectPrimeImport(sourcePath: string): Promise<ImportCandidate> {
  if (!sourcePath.toLowerCase().endsWith('.jsonl')) throw new Error('Choose a .jsonl session file')
  const session = await sessionIndex.summary(sourcePath)
  if (!session || !validPrimeId(session.id)) throw new Error('This is not an Engine 2 session file')
  return {
    engine: 'prime',
    sourcePath,
    fileName: basename(sourcePath),
    sessionId: session.id,
    cwd: session.cwd,
    cwdExists: await directoryExists(session.cwd),
    name: session.name,
    firstMessage: session.firstMessage,
    messageCount: session.messageCount,
    createdAt: session.createdAt
  }
}

export async function importPrimeSession(
  args: ImportSessionArgs,
  overridePath?: string | null
): Promise<ImportSessionResult> {
  const candidate = await inspectPrimeImport(args.sourcePath)
  const movedToFallback = !candidate.cwdExists
  const cwd = movedToFallback ? args.fallbackCwd : candidate.cwd
  if (!(await directoryExists(cwd))) throw new Error('Choose an available workspace folder')
  const sessionDir = await primeSessionRoot(cwd)
  if (!movedToFallback && samePath(dirname(args.sourcePath), sessionDir)) {
    return { path: args.sourcePath, cwd, movedToFallback, engine: 'prime' }
  }
  if (movedToFallback) {
    // Native import's cwdOverride is transient; a native fork writes the destination cwd.
    const path = await nativePrimeSessionCommand({
      operation: 'fork',
      path: args.sourcePath,
      cwd,
      sessionDir
    })
    knownRoots.add(comparablePath(sessionDir))
    return { path, cwd, movedToFallback, engine: 'prime' }
  }
  const destination = await copyPrimeImport(args.sourcePath, sessionDir)
  try {
    return await withPrimeServiceSession(
      cwd,
      async (request) => {
        const imported = await request('import_jsonl', { inputPath: destination })
        const state = stringValue(imported.sessionFile) ? imported : await request('get_state')
        const path =
          stringValue(state.sessionFile) ?? stringValue(asRecord(state.state).sessionFile)
        if (!path) throw new Error('Engine 2 did not return the imported session path')
        knownRoots.add(comparablePath(dirname(path)))
        return { path, cwd, movedToFallback, engine: 'prime' }
      },
      undefined,
      { executablePath: overridePath, persistSession: true, sessionDir }
    )
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
}

async function copyPrimeImport(sourcePath: string, sessionDir: string): Promise<string> {
  await mkdir(sessionDir, { recursive: true })
  const { name, ext } = parse(basename(sourcePath))
  let suffix = 0
  while (true) {
    const destination = join(sessionDir, `${name}${suffix ? `-${suffix}` : ''}${ext}`)
    try {
      // Reserve the complete copy atomically; native import must never overwrite another session.
      await copyFile(sourcePath, destination, constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      suffix++
    }
  }
}

export async function branchPrimeSession(
  path: string,
  entryId: string,
  _overridePath?: string | null
): Promise<string> {
  await requirePrimeSession(path)
  return nativePrimeSessionCommand({
    operation: 'branch',
    path,
    entryId,
    sessionDir: dirname(path)
  })
}

export async function forkPrimeSession(
  path: string,
  cwd: string,
  sessionDir?: string
): Promise<string> {
  await requirePrimeSession(path)
  const root = sessionDir ?? (await primeSessionRoot(cwd))
  const created = await nativePrimeSessionCommand({
    operation: 'fork',
    path,
    cwd,
    sessionDir: root
  })
  knownRoots.add(comparablePath(root))
  return created
}

export async function setPrimeSessionLabel(
  path: string,
  entryId: string,
  label: string | undefined,
  overridePath?: string | null
): Promise<void> {
  const { cwd } = await requirePrimeSession(path)
  await withPrimeServiceSession(
    cwd,
    async (request) => {
      await request('set_session_entry_label', { entryId, label: label?.trim() || null })
    },
    path,
    { executablePath: overridePath }
  )
}

export async function exportPrimeSession(
  path: string,
  format: SessionExportFormat,
  outputPath: string,
  overridePath?: string | null
): Promise<void> {
  const { cwd } = await requirePrimeSession(path)
  if (samePath(path, outputPath))
    throw new Error('Choose a path other than the session file itself')
  await withPrimeServiceSession(
    cwd,
    async (request) => {
      await request(format === 'html' ? 'export_html' : 'export_jsonl', { outputPath })
    },
    path,
    { executablePath: overridePath }
  )
}
