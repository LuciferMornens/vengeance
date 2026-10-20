import {
  normalizeEngineId,
  type BackgroundAgentInfo,
  type CreateAgentArgs,
  type EngineId
} from '@shared/api/engine'
import type {
  ForkPoint,
  ImportCandidate,
  SessionExportFormat,
  SessionListItem
} from '@shared/api/sessions'
import { bridge } from '../../lib/bridge'
import { rpc } from '../../lib/engine'
import { invoke } from '../../lib/ipc'
import { normalizePath, samePath } from '../../lib/paths'
import { REVEAL_LABEL, TRASH_NAME } from '../../lib/platform-copy'
import { hasReadyHistory } from '../../store/agent-state'
import { ensureAgentHistory, useAgents } from '../../store/agents'
import { useApp, workspaceEngine } from '../../store/app'
import { toast } from '../../ui'
import { toastFailure } from '../chat/failure-toast'
import { setDraftText } from '../composer'
import {
  newSession,
  requestSessionActivation,
  setSessionOpeningTarget,
  spawnAgent,
  withSessionOpening
} from '../shell/workspace'
import { agentSessionFile, agentTitle } from './model'
import {
  dismissDormant,
  findListed,
  focusWorkspace,
  useSessions,
  type SessionTarget
} from './store'

function fail(title: string, error: unknown): void {
  toast({ level: 'error', title, description: (error as Error).message })
}

/** Bring an open agent to the front (and its workspace with it). */
export async function activateAgent(agentId: string, activationRevision?: number): Promise<void> {
  const store = useAgents.getState()
  const agent = store.agents[agentId]
  if (
    !agent ||
    (activationRevision !== undefined && store.activationRevision !== activationRevision)
  ) {
    return
  }
  if (agent.status === 'ready' && !hasReadyHistory(agent)) {
    const revision = activationRevision ?? requestSessionActivation()
    await withSessionOpening(revision, async () => {
      const path = agentSessionFile(agent)
      if (path) setSessionOpeningTarget(revision, agent.info.engine, path)
      store.setActive(agentId, revision)
      focusWorkspace(agent.info.cwd)
      await ensureAgentHistory(agentId)
    }).catch((error) => fail('Could not open the session', error))
  } else {
    store.setActive(agentId, activationRevision)
    focusWorkspace(agent.info.cwd)
  }
}

/** The open agent currently on this session file, if any. */
export function findAgentForFile(path: string, engine?: EngineId): string | undefined {
  const { agents, order } = useAgents.getState()
  return order.find((id) => {
    const agent = agents[id]
    return (
      !!agent &&
      (!engine || agent.info.engine === engine) &&
      samePath(agentSessionFile(agent), path)
    )
  })
}

/** Put a forked/navigated-away message back into the agent's composer draft (nothing for empty text). */
function prefillDraft(agentId: string, text: string): void {
  if (text) setDraftText(agentId, text)
}

async function startAgent(
  args: CreateAgentArgs,
  failure: string,
  activationRevision = requestSessionActivation()
): Promise<string | null> {
  try {
    const id = await spawnAgent(args, { activationRevision })
    await activateAgent(id, activationRevision)
    return id
  } catch (error) {
    fail(failure, error)
    return null
  }
}

/** Opens still starting their engine, by normalized session path: a second open joins the first. */
const pendingOpens = new Map<string, Promise<string | null>>()

interface OpenSessionOptions {
  cwd?: string
  engine?: EngineId
  activationRevision?: number
  nativeAgentId?: string
}

/**
 * The single way to open a persisted session file: focuses the agent that already has it open (one engine
 * per session file, never two writers), otherwise resumes it in a new engine (`--session`) in `cwd`, or the
 * folder stored in the file when `cwd` is omitted. Resolves with the agent id, or null when it could not
 * be opened (the error was shown).
 */
export async function openSessionFile(
  path: string,
  options: OpenSessionOptions = {}
): Promise<string | null> {
  const knownEngine = options.engine
  const cached = knownEngine ? findAgentForFile(path, knownEngine) : undefined
  if (knownEngine && cached && hasReadyHistory(useAgents.getState().agents[cached])) {
    const activationRevision =
      options.activationRevision ?? useAgents.getState().requestActivation()
    await activateAgent(cached, activationRevision)
    setSessionOpeningTarget(activationRevision, knownEngine, path)
    return cached
  }
  const activationRevision = options.activationRevision ?? requestSessionActivation()
  return withSessionOpening(activationRevision, async () => {
    let engine = options.engine
    if (!engine) {
      try {
        engine = (await invoke('sessions:describe', path)).engine
      } catch (error) {
        fail('Could not open the session', error)
        return null
      }
    }
    setSessionOpeningTarget(activationRevision, engine, path)
    const key = `${engine}:${normalizePath(path)}`
    let opening = pendingOpens.get(key)
    if (!opening) {
      const open = findAgentForFile(path, engine)
      if (open) {
        await activateAgent(open, activationRevision)
        return open
      }
      opening = resumeSessionFile(path, { ...options, engine, activationRevision }).finally(() =>
        pendingOpens.delete(key)
      )
      pendingOpens.set(key, opening)
    }
    const agentId = await opening
    if (agentId) await activateAgent(agentId, activationRevision)
    return agentId
  })
}

async function resumeSessionFile(
  path: string,
  options: OpenSessionOptions
): Promise<string | null> {
  try {
    const description = await invoke('sessions:describe', path)
    const engine = options.engine ?? description.engine
    if (!description.cwdExists) {
      const candidate = await invoke('sessions:inspect-import', {
        sourcePath: path,
        cwd: description.cwd || options.cwd || '',
        engine
      })
      useSessions.getState().openDialog({ kind: 'import', candidate })
      return null
    }
    const cwd = description.cwd || options.cwd || useApp.getState().prefs.activeWorkspace
    if (!cwd) throw new Error('Choose a workspace to open this session.')
    return startAgent(
      { cwd, engine, sessionPath: path, nativeAgentId: options.nativeAgentId },
      'Could not open the session',
      options.activationRevision
    )
  } catch (error) {
    fail('Could not open the session', error)
    return null
  }
}

/** Open a listed session (see `openSessionFile`). */
export async function openSession(
  item: SessionListItem,
  activationRevision?: number
): Promise<void> {
  await openSessionFile(item.path, {
    cwd: item.cwd || undefined,
    engine: item.engine,
    activationRevision
  })
}

export async function resumeBackgroundAgent(resident: BackgroundAgentInfo): Promise<void> {
  const activationRevision = useAgents.getState().requestActivation()
  if (!resident.sessionPath) {
    const paths = new Set(
      useSessions
        .getState()
        .background.filter(
          (candidate) => candidate.engine === resident.engine && candidate.id === resident.id
        )
        .flatMap((candidate) =>
          candidate.sessionPath ? [normalizePath(candidate.sessionPath)] : []
        )
    )
    if (paths.size > 1) {
      fail(
        'Could not resume the background agent',
        new Error('This Engine identity matches several sessions. Select its saved conversation.')
      )
      return
    }
  }
  const key = `resident:${resident.engine}:${resident.id}`
  const pending = pendingOpens.get(key)
  if (pending) {
    return withSessionOpening(activationRevision, async () => {
      const agentId = await pending
      if (agentId) activateAgent(agentId, activationRevision)
    })
  }
  const state = useAgents.getState()
  const open = state.order.find((id) => {
    const agent = state.agents[id]
    return (
      agent?.info.engine === resident.engine &&
      (resident.sessionPath
        ? samePath(agentSessionFile(agent), resident.sessionPath)
        : (agent.info.nativeAgentId ?? agent.info.args.nativeAgentId) === resident.id)
    )
  })
  if (open) {
    activateAgent(open, activationRevision)
    return
  }
  if (resident.sessionPath) {
    await openSessionFile(resident.sessionPath, {
      cwd: resident.cwd,
      engine: resident.engine,
      activationRevision
    })
    return
  }
  const opening = startAgent(
    {
      cwd: resident.cwd,
      engine: resident.engine,
      nativeAgentId: resident.id,
      sessionPath: resident.sessionPath
    },
    'Could not resume the background agent',
    activationRevision
  ).finally(() => pendingOpens.delete(key))
  pendingOpens.set(key, opening)
  await opening
}

export function targetForAgent(agentId: string): SessionTarget | null {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return null
  return {
    agentId,
    path: agentSessionFile(agent),
    cwd: agent.info.cwd,
    title: agentTitle(agent),
    engine: agent.info.engine
  }
}

export function sessionTargetEngine(target: SessionTarget): EngineId {
  const agent = target.agentId ? useAgents.getState().agents[target.agentId] : undefined
  const listing = target.path ? findListed(useSessions.getState().lists, target.path) : undefined
  return normalizeEngineId(agent?.info.engine ?? target.engine ?? listing?.engine)
}

const warmedEngines = new Set<EngineId>()

/**
 * Editing a saved session file loads the engine's session module on first use (about 200 ms, once per run). Start
 * that load when the user is about to act on a saved session: its menu opened or its rename started.
 */
export function prewarmSavedSession(target: SessionTarget): void {
  if (target.agentId || !target.path) return
  const engine = sessionTargetEngine(target)
  if (warmedEngines.has(engine)) return
  warmedEngines.add(engine)
  void invoke('sessions:prewarm', engine).catch(() => warmedEngines.delete(engine))
}

/**
 * Rename a session: `set_session_name` for an open agent (also dropping an extension-set title, which
 * would otherwise keep overriding the name), the session file otherwise. Used by the sidebar, the chat
 * header and `/name`.
 */
export async function renameSession(target: SessionTarget, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed || trimmed === target.title) return
  try {
    if (target.agentId) {
      await rpc(target.agentId, { type: 'set_session_name', name: trimmed })
      const agent = useAgents.getState().agents[target.agentId]
      if (agent)
        useAgents.getState().patchAgent(target.agentId, {
          sessionName: trimmed,
          ext: { ...agent.ext, title: undefined }
        })
    } else if (target.path) {
      await invoke('sessions:rename', target.path, trimmed)
    }
    useSessions.getState().reloadLoaded()
  } catch (error) {
    fail('Could not rename the session', error)
  }
}

/** Fork at a user message: the new session ends right before it and the message returns to the composer. */
export async function forkAt(
  target: SessionTarget,
  point: Pick<ForkPoint, 'entryId' | 'parentId' | 'text'>,
  onActiveBranch = true
): Promise<void> {
  try {
    const agent = target.agentId ? useAgents.getState().agents[target.agentId] : undefined
    if (agent && onActiveBranch && agent.phase === 'idle') {
      // In place, exactly like the engine's /fork: this agent moves to the new session file.
      const result = await rpc(agent.id, { type: 'fork', entryId: point.entryId })
      if (result.cancelled) {
        toast({ level: 'info', title: 'Fork cancelled by an extension' })
        return
      }
      await useAgents.getState().refresh(agent.id)
      prefillDraft(agent.id, result.text || point.text)
      activateAgent(agent.id)
      useSessions.getState().reloadLoaded()
      return
    }
    // Closed session, busy agent or an abandoned branch: branch into a new session next to it.
    let id: string | null
    if (point.parentId && target.path) {
      const engine = sessionTargetEngine(target)
      const sessionPath = await invoke('sessions:branch', {
        sessionPath: target.path,
        entryId: point.parentId,
        engine
      })
      id = await startAgent({ cwd: target.cwd, sessionPath, engine }, 'Could not open the fork')
    } else {
      id = await newSession({ cwd: target.cwd, engine: sessionTargetEngine(target) })
      if (id) focusWorkspace(target.cwd)
    }
    if (id) prefillDraft(id, point.text)
  } catch (error) {
    fail('Could not fork the session', error)
  }
}

/** New session containing the path root → entry, opened next to the current one. */
export async function continueFrom(target: SessionTarget, entryId: string): Promise<void> {
  if (!target.path) {
    toast({
      level: 'warning',
      title: 'This session is not saved to disk',
      description: 'Ephemeral sessions cannot be branched.'
    })
    return
  }
  try {
    const engine = sessionTargetEngine(target)
    const sessionPath = await invoke('sessions:branch', {
      sessionPath: target.path,
      entryId,
      engine
    })
    await startAgent({ cwd: target.cwd, sessionPath, engine }, 'Could not open the branch')
  } catch (error) {
    fail('Could not branch the session', error)
  }
}

function waitForIdle(agentId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const agent = useAgents.getState().agents[agentId]
      if (!agent || agent.phase === 'idle' || Date.now() - started > timeoutMs) return resolve()
      setTimeout(tick, 50)
    }
    tick()
  })
}

export interface GoToPointOptions {
  summarize: boolean
  customInstructions?: string
}

/**
 * Move an open session to an earlier point in place (same file, like the TUI's /tree). A running response
 * is stopped first. Selecting a user message puts its text back into an empty composer. Returns false when
 * it failed or an extension cancelled it. Needs the bridge (`bridge.available`).
 */
export async function goToPoint(
  agentId: string,
  entryId: string,
  options: GoToPointOptions
): Promise<boolean> {
  try {
    if (useAgents.getState().agents[agentId]?.phase === 'running') {
      await useAgents.getState().abort(agentId)
      await waitForIdle(agentId, 10_000)
    }
    const result = await bridge.navigateTree(agentId, entryId, {
      summarize: options.summarize,
      customInstructions: options.customInstructions || undefined
    })
    if (result.cancelled) {
      toast({ level: 'info', title: 'Navigation cancelled by an extension' })
      return false
    }
    if (result.editorText) prefillDraft(agentId, result.editorText)
    useSessions.getState().reloadLoaded()
    return true
  } catch (error) {
    // A branch summary can fail on an Engine sign-in the provider refused to renew.
    toastFailure(
      options.summarize ? 'Could not summarize and move' : 'Could not move to this point',
      error
    )
    return false
  }
}

/**
 * Set or clear an entry label: live through the bridge for an open agent, in the file for a closed session.
 * Returns false when it failed.
 */
export async function setEntryLabel(
  target: Pick<SessionTarget, 'agentId' | 'path'>,
  entryId: string,
  label: string
): Promise<boolean> {
  const value = label.trim() || undefined
  try {
    if (target.agentId) await bridge.setLabel(target.agentId, entryId, value)
    else if (target.path)
      await invoke('sessions:set-label', { sessionPath: target.path, entryId, label: value })
    else return false
    return true
  } catch (error) {
    fail('Could not save the label', error)
    return false
  }
}

export async function cloneSession(target: SessionTarget): Promise<void> {
  try {
    const agent = target.agentId ? useAgents.getState().agents[target.agentId] : undefined
    if (agent) {
      const result = await rpc(agent.id, { type: 'clone' })
      if (result.cancelled) {
        toast({ level: 'info', title: 'Clone cancelled by an extension' })
        return
      }
      await useAgents.getState().refresh(agent.id)
      activateAgent(agent.id)
      toast({
        level: 'success',
        title: 'Session cloned',
        description: 'You are now working in the copy; the original stays in your history.'
      })
      useSessions.getState().reloadLoaded()
      return
    }
    if (target.path)
      await startAgent(
        { cwd: target.cwd, forkFrom: target.path, engine: sessionTargetEngine(target) },
        'Could not clone the session'
      )
  } catch (error) {
    fail('Could not clone the session', error)
  }
}

/** Export HTML or JSONL (the save dialog offers both; `format` is pre-selected). */
export async function exportSession(
  target: SessionTarget,
  format: SessionExportFormat = 'html'
): Promise<void> {
  if (!target.path && !target.agentId) return
  try {
    const written = await invoke('sessions:export', {
      sessionPath: target.path ?? '',
      agentId: target.agentId,
      title: target.title,
      format,
      engine: sessionTargetEngine(target)
    })
    if (written) {
      toast({
        level: 'success',
        title: written.format === 'html' ? 'Exported as a web page' : 'Exported as a session file',
        description: written.path,
        action: { label: REVEAL_LABEL, onClick: () => void invoke('sys:reveal', written.path) }
      })
    }
  } catch (error) {
    fail('Export failed', error)
  }
}

/** Share flow (review → secret gist → link), see SessionDialogs. */
export function shareSession(target: SessionTarget): void {
  useSessions.getState().openDialog({ kind: 'share', target })
}

/** Import flow: pick a `.jsonl`, review it, then copy and open it (see SessionDialogs). */
export async function pickImport(requestedEngine?: EngineId): Promise<void> {
  try {
    const state = useAgents.getState()
    const active = state.activeAgentId ? state.agents[state.activeAgentId] : undefined
    const engine =
      requestedEngine ??
      active?.info.engine ??
      workspaceEngine(useApp.getState().prefs.activeWorkspace)
    const candidate = await invoke('sessions:pick-import-for-engine', engine)
    if (candidate) useSessions.getState().openDialog({ kind: 'import', candidate })
  } catch (error) {
    fail('Could not read that file', error)
  }
}

/** Copy a reviewed file into the session folder and open it. */
export async function importAndOpen(
  candidate: ImportCandidate,
  fallbackCwd: string
): Promise<boolean> {
  try {
    const result = await invoke('sessions:import', {
      sourcePath: candidate.sourcePath,
      fallbackCwd,
      engine: candidate.engine
    })
    useSessions.getState().reloadLoaded()
    const id = await openSessionFile(result.path, {
      cwd: result.cwd,
      engine: result.engine ?? candidate.engine
    })
    if (id && result.movedToFallback) dismissDormant(candidate.sourcePath)
    if (id)
      toast({
        level: 'success',
        title: 'Session imported',
        description: result.movedToFallback ? 'It continues in this workspace.' : undefined
      })
    return id !== null
  } catch (error) {
    fail('Could not import the session', error)
    return false
  }
}

/** New session that is never written to disk (`--no-session`). */
export async function newEphemeralSession(): Promise<void> {
  await newSession({ noSession: true })
}

export function revealSession(path: string): void {
  void invoke('sys:reveal', path)
}

export async function deleteSession(target: SessionTarget & { path: string }): Promise<void> {
  const engine = sessionTargetEngine(target)
  const open = findAgentForFile(target.path, engine)
  try {
    if (open && engine !== 'prime') await useAgents.getState().disposeAgent(open)
    await invoke('sessions:trash', target.path)
    // Native deletion stops the resident. Keep its tab available if that operation fails.
    if (open && engine === 'prime') await useAgents.getState().disposeAgent(open)
    dismissDormant(target.path)
    toast({ level: 'success', title: `Moved to the ${TRASH_NAME}`, description: target.title })
    useSessions.getState().reloadLoaded()
  } finally {
    if (engine === 'prime') void useSessions.getState().loadBackground()
  }
}

/**
 * Close an agent. The next session in front comes from the same workspace; after a workspace's last session the window
 * stays in that workspace ("No session open"), except under All workspaces, where every open session is listed.
 */
export async function closeAgent(agentId: string): Promise<void> {
  const activationRevision = useAgents.getState().activationRevision
  try {
    await useAgents.getState().disposeAgent(agentId)
    const { activeAgentId, order } = useAgents.getState()
    const allScope = useApp.getState().prefs.features.sessions?.scope === 'all'
    const next = activeAgentId ?? (allScope ? order.at(-1) : undefined)
    if (next) activateAgent(next, activationRevision)
    useSessions.getState().reloadLoaded()
  } catch (error) {
    fail('Could not close the session', error)
  } finally {
    void useSessions.getState().loadBackground()
  }
}

/** Resident sessions detach; process-backed sessions ask before stopping an active run. */
export function requestCloseAgent(agentId: string): void {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  if (agent.info.engine !== 'prime' && agent.phase === 'running')
    useSessions.getState().openDialog({ kind: 'close', agentId, title: agentTitle(agent) })
  else void closeAgent(agentId)
}

/** Switch to the workspace's latest open or restored tab before starting a new session. */
export async function switchWorkspace(path: string): Promise<void> {
  const store = useAgents.getState()
  const activationRevision = store.requestActivation()
  const { agents, order } = store
  const open = [...order].reverse().find((id) => samePath(agents[id]?.info.cwd, path))
  const dormant = useSessions.getState().dormant.find((session) => samePath(session.cwd, path))
  useApp.getState().openWorkspace(path)
  if (open) store.setActive(open, activationRevision)
  else if (dormant) {
    await openSessionFile(dormant.path, {
      cwd: dormant.cwd,
      engine: dormant.engine,
      activationRevision
    })
  } else await newSession({ cwd: path }, { activationRevision })
}
