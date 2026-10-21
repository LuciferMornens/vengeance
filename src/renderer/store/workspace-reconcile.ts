import type { AppPersistedState, Workspace } from '@shared/api/app'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'
import type { WorkspaceDiscoveryResult } from '@shared/api/sessions'
import { basename } from '../lib/format'

type WorkspacePrefs = Pick<
  AppPersistedState,
  'workspaces' | 'activeWorkspace' | 'openSessions' | 'features'
>

/**
 * The workspace list after a discovery scan. The active workspace, folders of restored tabs and pinned workspaces
 * always stay. Any other workspace leaves when its folder was deleted, and one only found through its saved history
 * (never opened) also leaves once a complete scan no longer finds that history. Folders with history and folders of
 * restored tabs join unless the user removed them. Returns `prefs.workspaces` itself when nothing changes.
 * `normalizePath` gives a folder's comparable form.
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
    if (held.has(key) || workspace.pinned) return true
    if (gone.has(key)) return false
    return workspace.lastOpenedAt > 0 || !discovery.complete || found.has(key)
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
