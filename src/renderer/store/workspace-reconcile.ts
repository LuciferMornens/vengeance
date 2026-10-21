import type { AppPersistedState, Workspace } from '@shared/api/app'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'
import type { WorkspaceDiscoveryResult } from '@shared/api/sessions'
import { basename } from '../lib/format'

type WorkspacePrefs = Pick<
  AppPersistedState,
  'workspaces' | 'activeWorkspace' | 'openSessions' | 'features'
>

/**
 * The workspace list after a discovery scan. Workspaces the user opened or pinned, the active workspace and folders
 * of restored tabs stay; one whose folder is gone stays too (`shownWorkspaces` leaves it out until it is back). A
 * workspace only found through its saved history (never opened) leaves when its folder is gone or a complete scan no
 * longer finds that history. Folders with history and folders of restored tabs join unless the user removed them.
 * Returns `prefs.workspaces` itself when nothing changes. `normalizePath` gives a folder's comparable form.
 */
export function reconcileWorkspaces(
  prefs: WorkspacePrefs,
  discovery: WorkspaceDiscoveryResult,
  normalizePath: (path: string) => string
): Workspace[] {
  const candidates: Array<{ path: string; engine?: EngineId }> = [
    ...prefs.openSessions.map((session) => ({ path: session.cwd, engine: session.engine })),
    ...discovery.workspaces,
    ...(prefs.activeWorkspace ? [{ path: prefs.activeWorkspace }] : [])
  ].filter(({ path }) => !!path)
  const held = new Set(
    [...prefs.openSessions.map((session) => session.cwd), prefs.activeWorkspace ?? '']
      .filter(Boolean)
      .map(normalizePath)
  )
  const gone = new Set(discovery.gone.map(normalizePath))
  const found = new Set(discovery.workspaces.map((workspace) => normalizePath(workspace.path)))
  const workspaces = prefs.workspaces.filter((workspace) => {
    const key = normalizePath(workspace.path)
    if (held.has(key) || workspace.pinned || workspace.lastOpenedAt > 0) return true
    return !gone.has(key) && (!discovery.complete || found.has(key))
  })
  const hidden = new Set((prefs.features.sessions?.hiddenWorkspaces ?? []).map(normalizePath))
  const known = new Set(workspaces.map((workspace) => normalizePath(workspace.path)))
  for (const { path, engine } of candidates) {
    const key = normalizePath(path)
    if (known.has(key) || hidden.has(key)) continue
    known.add(key)
    workspaces.push({
      path,
      name: basename(path),
      lastOpenedAt: 0,
      engine: normalizeEngineId(engine)
    })
  }
  const changed =
    workspaces.length !== prefs.workspaces.length ||
    workspaces.some((workspace, index) => workspace !== prefs.workspaces[index])
  return changed ? workspaces : prefs.workspaces
}

/**
 * The workspaces to offer: one whose folder is gone (deleted, or on an unmounted drive) is left out until it is back,
 * unless it is active.
 */
export function shownWorkspaces(
  workspaces: Workspace[],
  missing: ReadonlySet<string>,
  activeWorkspace: string | null,
  normalizePath: (path: string) => string
): Workspace[] {
  if (missing.size === 0) return workspaces
  const active = activeWorkspace ? normalizePath(activeWorkspace) : undefined
  return workspaces.filter((workspace) => {
    const key = normalizePath(workspace.path)
    return key === active || !missing.has(key)
  })
}
