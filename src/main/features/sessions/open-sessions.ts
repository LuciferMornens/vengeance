import { existsSync } from 'node:fs'
import type { AppPersistedState, OpenSessionRef } from '@shared/api/app'
import { normalizeEngineId } from '@shared/api/engine'

function isOpenSessionRef(value: unknown): value is OpenSessionRef {
  const entry = value as Partial<OpenSessionRef> | null
  return typeof entry?.path === 'string' && typeof entry.cwd === 'string'
}

/**
 * Keep file-backed tabs, including sessions whose workspace needs relocation. New sessions without
 * a prompt have no file. When the active file is gone, the next entry takes its place, else the first.
 */
export function restorableOpenSessions(
  stored: Partial<AppPersistedState>
): Pick<AppPersistedState, 'openSessions' | 'activeSession'> {
  const saved: unknown[] = Array.isArray(stored.openSessions) ? stored.openSessions : []
  const entries = saved.filter(isOpenSessionRef)
  const activeIndex = entries.findIndex((entry) => entry.path === stored.activeSession)
  const openSessions: OpenSessionRef[] = []
  let activeSession: string | null = null
  entries.forEach((entry, index) => {
    if (!existsSync(entry.path)) return
    openSessions.push({ path: entry.path, cwd: entry.cwd, engine: normalizeEngineId(entry.engine) })
    if (activeIndex >= 0 && index >= activeIndex && activeSession === null)
      activeSession = entry.path
  })
  return { openSessions, activeSession: activeSession ?? openSessions[0]?.path ?? null }
}
