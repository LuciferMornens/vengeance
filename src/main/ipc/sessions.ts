import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions
} from 'electron'
import type {
  ExportSessionArgs,
  ExportSessionResult,
  ImportCandidate,
  SessionExportFormat,
  ShareSessionArgs
} from '@shared/api/sessions'
import { isEngineId, normalizeEngineId, type EngineId } from '@shared/api/engine'
import { appState } from '../app-state'
import { env } from '../env'
import type { EngineManager } from '../engine/manager'
import {
  branchMockSession,
  importMockSession,
  listMockSessions,
  MOCK_SESSIONS_ROOT,
  mockForkPoints,
  renameMockSession,
  trashMockSession
} from '../engine/mock-sessions'
import { importSession, inspectImport } from '../features/sessions/import'
import {
  mockImportCandidate,
  mockSessionTree,
  setMockSessionLabel
} from '../features/sessions/mock'
import {
  branchOf,
  branchSession,
  discoverSessionWorkspaces,
  exportSessionJsonl,
  exportSessionWithCli,
  forkPoints,
  listSessions,
  prewarmSessionFiles,
  readSessionHeader,
  renameSession,
  serializeBranch,
  sessionCwd,
  sessionVersion,
  sessionsRoots,
  SessionsWatcher,
  sessionTree,
  setSessionLabel,
  trashSession
} from '../features/sessions/service'
import { shareReadiness, uploadGist, uploadGistHtml } from '../features/sessions/share'
import { replaceFile } from '../features/settings/json-file'
import type { IpcContext } from './context'
import { broadcast, handle, onQuit } from './handle'
import { comparablePath, directoryExists, samePath } from '../paths'
import {
  branchPrimeSession,
  deletePrimeSession,
  discoverPrimeWorkspaces,
  exportPrimeSession,
  importPrimeSession,
  inspectPrimeImport,
  listPrimeSessions,
  primeForkPoints,
  primeSessionCwd,
  primeSessionIdentity,
  primeSessionRoots,
  primeSessionTree,
  renamePrimeSession,
  setPrimeSessionLabel
} from '../engine/prime/sessions'

/** Header version of mock-mode JSONL exports (pi's CURRENT_SESSION_VERSION). */
const MOCK_SESSION_VERSION = 3

function knownWorkspacePaths(): string[] {
  const prefs = appState.getPrefs()
  return [
    ...new Map(
      [
        ...prefs.workspaces.map((workspace) => workspace.path),
        ...prefs.openSessions.map((session) => session.cwd)
      ].map((cwd) => [comparablePath(cwd), cwd])
    ).values()
  ]
}

async function sessionEngine(
  context: IpcContext,
  path: string,
  requested?: EngineId
): Promise<EngineId> {
  const running = context.manager
    .list()
    .find((agent) => (agent.sessionFile ? samePath(agent.sessionFile, path) : false))
  if (running) return running.engine
  const stored = appState.getPrefs().openSessions.find((session) => samePath(session.path, path))
  if (stored) return normalizeEngineId(stored.engine)
  if (requested) {
    if (!isEngineId(requested)) throw new Error('Choose a supported engine')
    return requested
  }
  return (await primeSessionIdentity(path)) ? 'prime' : 'pi'
}

function safeFileName(title: string | undefined): string {
  const cleaned = (title ?? 'session')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'session'
}

const FILTERS: Record<SessionExportFormat, { name: string; extensions: string[] }> = {
  html: { name: 'Web page (HTML)', extensions: ['html'] },
  jsonl: { name: 'Session file (JSONL)', extensions: ['jsonl'] }
}

async function showSave(
  event: IpcMainInvokeEvent,
  options: SaveDialogOptions
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

async function showOpen(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions
): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender)
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Save dialog offering both formats (the requested one first); the extension kept decides the format. */
async function chooseExportPath(
  args: ExportSessionArgs,
  event: IpcMainInvokeEvent
): Promise<ExportSessionResult | null> {
  const other: SessionExportFormat = args.format === 'html' ? 'jsonl' : 'html'
  const path = await showSave(event, {
    title: 'Export session',
    defaultPath: join(app.getPath('downloads'), `${safeFileName(args.title)}.${args.format}`),
    filters: [FILTERS[args.format], FILTERS[other]]
  })
  if (!path) return null
  const ext = extname(path).toLowerCase()
  return {
    path,
    format: ext === '.jsonl' ? 'jsonl' : ext === '.html' || ext === '.htm' ? 'html' : args.format
  }
}

/**
 * N3: `/export <path>` without a dialog, with the engine's own /export rules: `.jsonl` exports JSONL,
 * anything else HTML; relative paths resolve against the session's folder.
 */
async function explicitExportTarget(
  context: IpcContext,
  args: ExportSessionArgs,
  outputPath: string
): Promise<ExportSessionResult> {
  const requested = outputPath.trim()
  if (!requested) throw new Error('Enter a file name to export to')
  let path = requested
  if (!isAbsolute(requested)) {
    const agentCwd = args.agentId ? context.manager.get(args.agentId)?.cwd : undefined
    const base =
      agentCwd ??
      (args.sessionPath && !env.mock
        ? (await sessionEngine(context, args.sessionPath, args.engine)) === 'prime'
          ? await primeSessionCwd(args.sessionPath)
          : await sessionCwd(context.engineOverridePath(), args.sessionPath)
        : '')
    if (!base) throw new Error('Use an absolute path to export this session')
    path = resolve(base, requested)
  }
  if (args.sessionPath && samePath(path, args.sessionPath))
    throw new Error('Choose a path other than the session file itself')
  assertClosed(context.manager, path)
  await mkdir(dirname(path), { recursive: true })
  return { path, format: extname(path).toLowerCase() === '.jsonl' ? 'jsonl' : 'html' }
}

/** Refuse writes to a file a running engine owns (it keeps its own in-memory tree of that file). */
function assertClosed(manager: EngineManager, path: string): void {
  if (manager.list().some((agent) => agent.sessionFile && samePath(agent.sessionFile, path))) {
    throw new Error('This session is open in an engine; change it there')
  }
}

/** JSONL export of a running engine's active branch (its live leaf, also for ephemeral sessions). */
async function exportAgentJsonl(
  context: IpcContext,
  agentId: string,
  outputPath: string
): Promise<void> {
  const agent = context.manager.get(agentId)
  if (agent?.engine === 'prime' && !env.mock) {
    await context.manager.nativeCommand(agentId, 'export_jsonl', { outputPath })
    return
  }
  const [entries, state] = await Promise.all([
    context.manager.command(agentId, { type: 'get_entries' }),
    context.manager.command(agentId, { type: 'get_state' })
  ])
  if (!entries.success) throw new Error(entries.error)
  if (!state.success) throw new Error(state.error)
  if (entries.command !== 'get_entries' || state.command !== 'get_state')
    throw new Error('Unexpected engine response')
  // The engine's own (absolute) session path: the renderer's copy can predate a fork or switch.
  const sessionFile = state.data.sessionFile
  const cwd =
    sessionFile && !env.mock ? (await readSessionHeader(sessionFile)).cwd : (agent?.args.cwd ?? '')
  const version = env.mock
    ? MOCK_SESSION_VERSION
    : await sessionVersion(context.engineOverridePath())
  await replaceFile(
    outputPath,
    serializeBranch(
      version,
      state.data.sessionId,
      cwd,
      branchOf(entries.data.entries, entries.data.leafId)
    )
  )
}

async function exportHtml(
  context: IpcContext,
  args: { sessionPath: string; agentId?: string; engine?: EngineId },
  outputPath: string
): Promise<void> {
  if (args.agentId) {
    const response = await context.manager.command(args.agentId, {
      type: 'export_html',
      outputPath
    })
    if (!response.success) throw new Error(response.error)
    return
  }
  if (env.mock) return
  if ((await sessionEngine(context, args.sessionPath, args.engine)) === 'prime') {
    return exportPrimeSession(
      args.sessionPath,
      'html',
      outputPath,
      context.engineOverridePath('prime')
    )
  }
  await exportSessionWithCli(context.engineOverridePath(), args.sessionPath, outputPath)
}

async function shareSession(
  context: IpcContext,
  args: ShareSessionArgs
): Promise<{ url: string; gistUrl: string }> {
  if (env.mock) {
    await new Promise((resolve) => setTimeout(resolve, 900))
    const id = '4f9c2e7a1b3d5e6f8a0c'
    return { url: `https://pi.dev/session/#${id}`, gistUrl: `https://gist.github.com/dev/${id}` }
  }
  const dir = await mkdtemp(join(tmpdir(), 'vengeance-share-'))
  try {
    const htmlPath = join(dir, 'session.html')
    await exportHtml(context, args, htmlPath)
    const engine = args.agentId
      ? context.manager.get(args.agentId)?.engine
      : await sessionEngine(context, args.sessionPath, args.engine)
    if (engine === 'prime') return await uploadGistHtml(htmlPath)
    return await uploadGist(context.engineOverridePath(), htmlPath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Session browser: list / rename / trash / branch / label / export / import / share, live file watching. */
export function registerSessionsIpc(context: IpcContext): void {
  const watchers: Record<EngineId, SessionsWatcher> = {
    pi: new SessionsWatcher((root) => broadcast('sessions:changed', { root })),
    prime: new SessionsWatcher((root) => broadcast('sessions:changed', { root }))
  }
  onQuit('before-quit', () => {
    for (const watcher of Object.values(watchers)) watcher.close()
  })
  const changed = () => broadcast('sessions:changed', { root: MOCK_SESSIONS_ROOT })
  const override = () => context.engineOverridePath()
  const pendingRoots = new Map<string, Promise<string[]>>()
  const rootsFor = (engine: EngineId, cwds: string[]): Promise<string[]> => {
    const key = JSON.stringify([
      engine,
      context.engineOverridePath(engine),
      cwds.map(comparablePath).sort()
    ])
    const pending = pendingRoots.get(key)
    if (pending) return pending
    const request = (
      engine === 'prime' ? primeSessionRoots(cwds) : sessionsRoots(override(), null, cwds)
    ).finally(() => pendingRoots.delete(key))
    pendingRoots.set(key, request)
    return request
  }
  const inspectCandidate = async (engine: EngineId, path: string): Promise<ImportCandidate> => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (env.mock) return { ...mockImportCandidate(), sourcePath: path, engine }
    return engine === 'prime'
      ? inspectPrimeImport(path)
      : { ...(await inspectImport(override(), path)), engine }
  }
  const pickImport = async (
    engine: EngineId,
    event: IpcMainInvokeEvent
  ): Promise<ImportCandidate | null> => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (env.mock) return { ...mockImportCandidate(), engine }
    const path = await showOpen(event, {
      title: 'Import a session',
      properties: ['openFile'],
      filters: [FILTERS.jsonl]
    })
    return path ? inspectCandidate(engine, path) : null
  }

  handle('sessions:workspaces', async () => {
    if (env.mock) {
      const discovered = new Map<string, { path: string; lastActivityAt: number; engine: 'pi' }>()
      for (const session of listMockSessions(null)) {
        const key = session.cwd.toLowerCase()
        const previous = discovered.get(key)
        if (!previous || session.modifiedAt > previous.lastActivityAt) {
          discovered.set(key, {
            path: session.cwd,
            lastActivityAt: session.modifiedAt,
            engine: 'pi'
          })
        }
      }
      return [...discovered.values()]
    }
    const known = knownWorkspacePaths()
    const [standard, prime] = await Promise.allSettled([
      discoverSessionWorkspaces(override(), known),
      discoverPrimeWorkspaces(context.engineOverridePath('prime'), known)
    ])
    const discovered =
      standard.status === 'fulfilled'
        ? standard.value.map((workspace) => ({ ...workspace, engine: 'pi' as const }))
        : []
    return [...discovered, ...(prime.status === 'fulfilled' ? prime.value : [])]
  })

  handle('sessions:describe', async (path) => {
    const engine = await sessionEngine(context, path)
    const saved = appState.getPrefs().openSessions.some((session) => samePath(session.path, path))
    const cwd = env.mock
      ? (listMockSessions(null).find((session) => samePath(session.path, path))?.cwd ?? '')
      : saved
        ? (await readSessionHeader(path)).cwd
        : engine === 'prime'
          ? await primeSessionCwd(path)
          : await sessionCwd(override(), path)
    const cwdExists = env.mock || (await directoryExists(cwd))
    return { cwd, engine, cwdExists }
  })

  handle('sessions:resolve', async (args) => {
    if (!isEngineId(args.engine)) throw new Error('Choose a supported engine')
    const reference = args.reference.trim()
    if (!reference) throw new Error('Enter a session path or identifier')
    const absolute = resolve(args.cwd, reference)
    if (!env.mock) {
      await rootsFor(args.engine, knownWorkspacePaths())
    }
    const sessions = env.mock
      ? listMockSessions(null)
      : args.engine === 'prime'
        ? (
            await listPrimeSessions(
              { cwd: null, engine: 'prime' },
              context.engineOverridePath('prime')
            )
          ).sessions
        : (await listSessions(override(), null)).sessions
    const exact = sessions.find(
      (session) => session.id === reference || samePath(session.path, absolute)
    )
    const prefixes = exact
      ? [exact]
      : sessions.filter((session) => session.id.startsWith(reference))
    if (prefixes.length > 1)
      throw new Error('Several sessions match that identifier. Enter more characters.')
    const match = prefixes[0]
    if (match)
      return {
        path: match.path,
        cwd: match.cwd,
        engine: normalizeEngineId(match.engine ?? args.engine)
      }
    const engine = await sessionEngine(context, absolute, args.engine)
    const cwd =
      engine === 'prime' ? await primeSessionCwd(absolute) : await sessionCwd(override(), absolute)
    return { path: absolute, cwd, engine }
  })

  handle('sessions:list', async (query) => {
    const { cwd } = query
    const engine = normalizeEngineId(query.engine)
    if (env.mock) {
      return {
        sessions:
          engine === 'prime'
            ? []
            : listMockSessions(cwd).map((session) => ({ ...session, engine })),
        sessionDir: MOCK_SESSIONS_ROOT
      }
    }
    if (engine === 'prime') {
      await rootsFor(engine, cwd === null ? knownWorkspacePaths() : [cwd])
      const result = await listPrimeSessions(query, context.engineOverridePath('prime'))
      watchers.prime.watch(await primeSessionRoots())
      return result
    }
    await rootsFor(engine, cwd === null ? knownWorkspacePaths() : [cwd])
    const result = await listSessions(override(), cwd)
    watchers.pi.watch(await sessionsRoots(override(), null))
    return { ...result, sessions: result.sessions.map((session) => ({ ...session, engine })) }
  })

  handle('sessions:rename', async (path, name) => {
    if (env.mock) {
      renameMockSession(path, name)
      changed()
      return
    }
    assertClosed(context.manager, path)
    if ((await sessionEngine(context, path)) === 'prime') {
      return renamePrimeSession(path, name, context.engineOverridePath('prime'))
    }
    await renameSession(override(), path, name)
  })

  handle('sessions:trash', async (path) => {
    if (env.mock) {
      trashMockSession(path)
      changed()
      return
    }
    if ((await sessionEngine(context, path)) === 'prime') {
      return deletePrimeSession(path, context.engineOverridePath('prime'))
    }
    await trashSession(override(), path)
  })

  handle('sessions:branch', async ({ sessionPath, entryId, engine }) => {
    if (env.mock) {
      const created = branchMockSession(sessionPath)
      changed()
      return created
    }
    if ((await sessionEngine(context, sessionPath, engine)) === 'prime') {
      return branchPrimeSession(sessionPath, entryId, context.engineOverridePath('prime'))
    }
    return branchSession(override(), sessionPath, entryId)
  })

  handle('sessions:prewarm', async (engine) => {
    if (env.mock || engine === 'prime') return
    await prewarmSessionFiles(override())
  })

  handle('sessions:fork-points', async (path) => {
    if (env.mock) return mockForkPoints(path)
    return (await sessionEngine(context, path)) === 'prime'
      ? primeForkPoints(path, context.engineOverridePath('prime'))
      : forkPoints(override(), path)
  })

  handle('sessions:tree', async (path) => {
    if (env.mock) return mockSessionTree(path)
    return (await sessionEngine(context, path)) === 'prime'
      ? primeSessionTree(path, context.engineOverridePath('prime'))
      : sessionTree(override(), path)
  })

  handle('sessions:set-label', async ({ sessionPath, entryId, label, engine }) => {
    if (env.mock) {
      setMockSessionLabel(sessionPath, entryId, label)
      return
    }
    assertClosed(context.manager, sessionPath)
    if ((await sessionEngine(context, sessionPath, engine)) === 'prime') {
      return setPrimeSessionLabel(sessionPath, entryId, label, context.engineOverridePath('prime'))
    }
    await setSessionLabel(override(), sessionPath, entryId, label)
  })

  handle('sessions:cwd', async (path) => {
    if (env.mock)
      return listMockSessions(null).find((session) => samePath(session.path, path))?.cwd ?? ''
    return (await sessionEngine(context, path)) === 'prime'
      ? primeSessionCwd(path)
      : sessionCwd(override(), path)
  })

  handle('sessions:export', async (args, event) => {
    const chosen =
      args.outputPath !== undefined
        ? await explicitExportTarget(context, args, args.outputPath)
        : await chooseExportPath(args, event)
    if (!chosen) return null
    if (chosen.format === 'html') {
      await exportHtml(context, args, chosen.path)
    } else if (args.agentId) {
      await exportAgentJsonl(context, args.agentId, chosen.path)
    } else if (!env.mock) {
      if ((await sessionEngine(context, args.sessionPath, args.engine)) === 'prime') {
        await exportPrimeSession(
          args.sessionPath,
          'jsonl',
          chosen.path,
          context.engineOverridePath('prime')
        )
      } else {
        await exportSessionJsonl(override(), args.sessionPath, chosen.path)
      }
    }
    return chosen
  })

  handle('sessions:pick-import', (event) => pickImport('pi', event))
  handle('sessions:pick-import-for-engine', (engine, event) => pickImport(engine, event))
  handle('sessions:inspect-import', (args) =>
    inspectCandidate(args.engine, resolve(args.cwd, args.sourcePath))
  )

  handle('sessions:import', async (args) => {
    if (env.mock) {
      const candidate = mockImportCandidate()
      const path = importMockSession(
        args.fallbackCwd,
        candidate.name,
        candidate.firstMessage,
        candidate.messageCount
      )
      changed()
      return {
        path,
        cwd: args.fallbackCwd,
        movedToFallback: true,
        engine: normalizeEngineId(args.engine)
      }
    }
    if (args.engine === 'prime')
      return importPrimeSession(args, context.engineOverridePath('prime'))
    return importSession(override(), args)
  })

  handle('sessions:share-readiness', async () =>
    env.mock ? { ready: true as const } : shareReadiness()
  )

  handle('sessions:share', async (args) => shareSession(context, args))
}
