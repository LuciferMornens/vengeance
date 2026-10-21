import { useMemo } from 'react'
import type { Workspace } from '@shared/api/app'
import { normalizePath } from '../lib/paths'
import { useApp } from './app'
import { shownWorkspaces } from './workspace-reconcile'

/** The workspaces the switcher, palette and onboarding offer (see `shownWorkspaces`). */
export function useShownWorkspaces(): Workspace[] {
  const workspaces = useApp((s) => s.prefs.workspaces)
  const missing = useApp((s) => s.missingWorkspaces)
  const active = useApp((s) => s.prefs.activeWorkspace)
  return useMemo(
    () => shownWorkspaces(workspaces, missing, active, normalizePath),
    [workspaces, missing, active]
  )
}
