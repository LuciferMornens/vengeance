import { useEffect } from 'react'
import { create } from 'zustand'
import type { EngineId } from '@shared/api/engine'
import type { JsonValue, SettingsSnapshot } from '@shared/api/settings'
import { findSetting } from '@shared/api/settings-schema'
import { on } from '../../lib/ipc'
import { selectWorkspaceEngine, useApp, workspaceEngine } from '../../store/app'
import { useAgents } from '../../store/agents'
import { settingsInvokeForFolder } from './ipc'
import { getAt, splitKey } from './values'

/**
 * Effective engine settings for GUI code that must honor them (e.g. `hideThinkingBlock`,
 * `doubleEscapeAction`, `treeFilterMode`, `markdown.mermaid`).
 *
 * Trusted project settings override that backend's global settings, then its schema defaults.
 * Snapshots live with mounted consumers, open agents and the active workspace, and refresh on
 * `settings:changed` (including edits made outside Vengeance).
 */

interface EffectiveStore {
  /** Snapshots keyed by backend and folder; null folders contain global settings only. */
  snapshots: Record<string, SettingsSnapshot>
  ensure(cwd: string | null, engine: EngineId): void
  retain(cwd: string | null, engine: EngineId): () => void
  prune(): void
  /** Refresh scopes still in use; old values stay visible until fresh ones arrive. */
  reload(engine: EngineId): void
}

const keyOf = (cwd: string | null, engine: EngineId) => JSON.stringify([engine, cwd])

const useEffectiveStore = create<EffectiveStore>()((set, get) => {
  const consumers = new Map<string, number>()
  const requests = new Map<string, { dirty: boolean; unused: boolean }>()

  const retainedKeys = (): Set<string> => {
    const cwd = useApp.getState().prefs.activeWorkspace
    return new Set([
      ...consumers.keys(),
      keyOf(cwd, workspaceEngine(cwd)),
      ...Object.values(useAgents.getState().agents).map((agent) =>
        keyOf(agent.info.cwd, agent.info.engine)
      )
    ])
  }

  const fetchSnapshot = (cwd: string | null, engine: EngineId) => {
    const key = keyOf(cwd, engine)
    const pending = requests.get(key)
    if (pending) {
      if (pending.unused) {
        pending.unused = false
        pending.dirty = true
      }
      return
    }
    const request = { dirty: false, unused: false }
    requests.set(key, request)
    void settingsInvokeForFolder(engine, cwd, 'settings:snapshot', cwd)
      .then((snapshot) => {
        if (request.dirty || request.unused) return
        set((state) => ({ snapshots: { ...state.snapshots, [key]: snapshot } }))
      })
      .catch(() => undefined)
      .finally(() => {
        if (requests.get(key) !== request) return
        requests.delete(key)
        if (request.dirty && !request.unused) fetchSnapshot(cwd, engine)
      })
  }
  return {
    snapshots: {},
    ensure(cwd, engine) {
      const key = keyOf(cwd, engine)
      if (!get().snapshots[key]) fetchSnapshot(cwd, engine)
    },
    retain(cwd, engine) {
      const key = keyOf(cwd, engine)
      consumers.set(key, (consumers.get(key) ?? 0) + 1)
      get().ensure(cwd, engine)
      return () => {
        const remaining = (consumers.get(key) ?? 1) - 1
        if (remaining > 0) consumers.set(key, remaining)
        else {
          consumers.delete(key)
          get().prune()
        }
      }
    },
    prune() {
      const retained = retainedKeys()
      for (const [key, request] of requests) {
        if (!retained.has(key)) request.unused = true
      }
      const snapshots = get().snapshots
      const removed = Object.keys(snapshots).filter((key) => !retained.has(key))
      if (removed.length === 0) return
      const next = { ...snapshots }
      for (const key of removed) delete next[key]
      set({ snapshots: next })
    },
    reload(engine) {
      get().prune()
      const keys = new Set([...Object.keys(get().snapshots), ...requests.keys()])
      for (const key of keys) {
        const [cachedEngine, cwd] = JSON.parse(key) as [EngineId, string | null]
        if (cachedEngine !== engine) continue
        const request = requests.get(key)
        if (request && !request.unused) request.dirty = true
        else if (request) continue
        else fetchSnapshot(cwd, engine)
      }
    }
  }
})

const unsubscribeChanges = on('settings:changed', ({ area, engine = 'pi' }) => {
  if (area === 'settings' || area === 'trust') useEffectiveStore.getState().reload(engine)
})
const unsubscribeAgents = useAgents.subscribe((state, previous) => {
  if (state.order !== previous.order) useEffectiveStore.getState().prune()
})
const unsubscribeWorkspace = useApp.subscribe((state, previous) => {
  if (
    state.prefs.activeWorkspace !== previous.prefs.activeWorkspace ||
    state.prefs.workspaces !== previous.prefs.workspaces
  )
    useEffectiveStore.getState().prune()
})
import.meta.hot?.dispose(() => {
  unsubscribeChanges()
  unsubscribeAgents()
  unsubscribeWorkspace()
})

function resolveEffective(
  snapshot: SettingsSnapshot | undefined,
  key: string,
  engine: EngineId
): JsonValue | undefined {
  const path = splitKey(key)
  const project = snapshot?.project?.trust.effective
    ? getAt(snapshot.project.data, path)
    : undefined
  const value = project ?? getAt(snapshot?.global.data, path)
  if (value !== undefined) return value
  const fallback = engine === 'pi' ? findSetting(key)?.default : undefined
  return fallback === null ? undefined : fallback
}

/**
 * Effective value of an engine setting (dotted key, e.g. `markdown.mermaid`) for `cwd` (default: the
 * active workspace). `undefined` while loading or when the setting has no default.
 */
export function useEffectiveSetting(
  key: string,
  cwd?: string | null,
  engine?: EngineId
): JsonValue | undefined {
  const activeWorkspace = useApp((s) => s.prefs.activeWorkspace)
  const folder = cwd === undefined ? activeWorkspace : cwd
  const selectedEngine = useApp((state) => engine ?? selectWorkspaceEngine(state, folder))
  const snapshot = useEffectiveStore((s) => s.snapshots[keyOf(folder, selectedEngine)])
  useEffect(
    () => useEffectiveStore.getState().retain(folder, selectedEngine),
    [folder, selectedEngine]
  )
  return resolveEffective(snapshot, key, selectedEngine)
}

/** Imperative variant for event handlers (returns the default until the folder's settings loaded once). */
export function getEffectiveSetting(
  key: string,
  cwd?: string | null,
  engine?: EngineId
): JsonValue | undefined {
  const folder = cwd === undefined ? useApp.getState().prefs.activeWorkspace : cwd
  const store = useEffectiveStore.getState()
  const selectedEngine = engine ?? workspaceEngine(folder)
  store.ensure(folder, selectedEngine)
  return resolveEffective(store.snapshots[keyOf(folder, selectedEngine)], key, selectedEngine)
}
