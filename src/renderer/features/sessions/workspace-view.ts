import type { SessionScope } from '@shared/api/sessions'
import { samePath } from '../../lib/paths'

interface WorkspaceView {
  scope: SessionScope
  activeWorkspace: string | null
  workspaces: readonly { path: string }[]
}

/**
 * Whether an open session in `cwd` is listed in the sidebar. A workspace lists its own sessions, and also those whose
 * folder the switcher cannot reach (a hidden or forgotten workspace), so no open session is ever stranded; All
 * workspaces lists every one.
 */
export function inWorkspaceView(cwd: string, { scope, activeWorkspace, workspaces }: WorkspaceView): boolean {
  if (scope === 'all' || !activeWorkspace || samePath(cwd, activeWorkspace)) return true
  return !workspaces.some((workspace) => samePath(workspace.path, cwd))
}
