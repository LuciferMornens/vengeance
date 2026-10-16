import { create } from 'zustand'
import {
  DEFAULT_APP_STATE,
  type AppPersistedState,
  type FeaturePrefs,
  type Workspace
} from '@shared/api/app'
import { basename } from '../lib/format'
import { invoke } from '../lib/ipc'
import { normalizePath, samePath } from '../lib/paths'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'

export interface UiState {
  settingsOpen: boolean
  /** Settings section id (owned by the settings feature). */
  settingsSection: string | null
  /** An explicit session configuration target; null uses the workspace default. */
  settingsEngine: EngineId | null
  paletteOpen: boolean
}

export interface AppStore {
  /** True once persisted prefs have loaded. */
  ready: boolean
  prefs: AppPersistedState
  ui: UiState
  workspaceDiscovery: 'idle' | 'loading' | 'ready' | 'error'
  workspaceDiscoveryError: string | null

  load(): Promise<void>
  discoverWorkspaces(): Promise<void>
  /** Optimistically update prefs and persist (debounced). */
  update(patch: Partial<AppPersistedState>): void
  updateFeaturePrefs<K extends keyof FeaturePrefs>(feature: K, value: FeaturePrefs[K]): void
  /** Add/refresh a workspace and make it active. */
  openWorkspace(path: string, engine?: EngineId): Workspace
  setWorkspaceEngine(path: string, engine: EngineId): void
  removeWorkspace(path: string): void
  toggleSidebar(open?: boolean): void
  toggleInspector(open?: boolean): void
  setInspectorTab(tab: string): void
  openSettings(section?: string, engine?: EngineId): void
  closeSettings(): void
  setPaletteOpen(open: boolean): void
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingPatch: Partial<AppPersistedState> = {}
let workspaceDiscoveryInvalidated = false
let workspaceDiscoveryRunning = false

export async function flushAppPreferences(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  const patch = pendingPatch
  pendingPatch = {}
  if (Object.keys(patch).length) await invoke('app:set-state', patch)
}

function persist(patch: Partial<AppPersistedState>): void {
  pendingPatch = {
    ...pendingPatch,
    ...patch,
    features: patch.features
      ? { ...pendingPatch.features, ...patch.features }
      : pendingPatch.features
  }
  if (!pendingPatch.features) delete pendingPatch.features
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    const toSend = pendingPatch
    pendingPatch = {}
    persistTimer = null
    void invoke('app:set-state', toSend)
  }, 200)
}

export const useApp = create<AppStore>()((set, get) => ({
  ready: false,
  prefs: DEFAULT_APP_STATE,
  ui: { settingsOpen: false, settingsSection: null, settingsEngine: null, paletteOpen: false },
  workspaceDiscovery: 'idle',
  workspaceDiscoveryError: null,

  async load() {
    const prefs = await invoke('app:get-state')
    set({ prefs, ready: true })
  },

  async discoverWorkspaces() {
    if (workspaceDiscoveryRunning) {
      workspaceDiscoveryInvalidated = true
      return
    }
    workspaceDiscoveryRunning = true
    // Only the first scan (or a retry after a failure) shows progress; later re-scans run quietly, so the switcher
    // never flickers while agents write their sessions.
    const quiet = get().workspaceDiscovery === 'ready'
    if (!quiet) set({ workspaceDiscovery: 'loading', workspaceDiscoveryError: null })
    try {
      const discovered = await invoke('sessions:workspaces')
      const { prefs } = get()
      const known = new Set(prefs.workspaces.map((workspace) => normalizePath(workspace.path)))
      const hidden = new Set((prefs.features.sessions?.hiddenWorkspaces ?? []).map(normalizePath))
      const workspaces = [...prefs.workspaces]
      const restored = prefs.openSessions.map((session) => ({
        path: session.cwd,
        engine: session.engine
      }))
      const candidates = [
        ...restored,
        ...discovered,
        ...(prefs.activeWorkspace ? [{ path: prefs.activeWorkspace, engine: undefined }] : [])
      ]
      for (const { path, engine } of candidates) {
        if (!path) continue
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
      if (workspaces.length !== prefs.workspaces.length) get().update({ workspaces })
      if (!quiet) set({ workspaceDiscovery: 'ready' })
    } catch (error) {
      // A failed quiet re-scan keeps the list it has; the next one tries again.
      if (!quiet) {
        set({
          workspaceDiscovery: 'error',
          workspaceDiscoveryError: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      workspaceDiscoveryRunning = false
      if (workspaceDiscoveryInvalidated) {
        workspaceDiscoveryInvalidated = false
        void get().discoverWorkspaces()
      }
    }
  },

  update(patch) {
    set((state) => ({
      ui:
        patch.activeWorkspace !== undefined && patch.activeWorkspace !== state.prefs.activeWorkspace
          ? { ...state.ui, settingsEngine: null }
          : state.ui,
      prefs: {
        ...state.prefs,
        ...patch,
        features: patch.features
          ? { ...state.prefs.features, ...patch.features }
          : state.prefs.features
      }
    }))
    persist(patch)
  },

  updateFeaturePrefs(feature, value) {
    get().update({ features: { [feature]: value } })
  },

  openWorkspace(path, engine) {
    const { workspaces } = get().prefs
    const existing = workspaces.find((w) => samePath(w.path, path))
    const workspace: Workspace = {
      ...(existing ?? { path, name: basename(path) }),
      engine: engine ?? normalizeEngineId(existing ? existing.engine : get().prefs.defaultEngine),
      lastOpenedAt: Date.now()
    }
    get().update({
      workspaces: [workspace, ...workspaces.filter((w) => !samePath(w.path, path))],
      activeWorkspace: workspace.path,
      features: {
        sessions: {
          ...get().prefs.features.sessions,
          hiddenWorkspaces: (get().prefs.features.sessions?.hiddenWorkspaces ?? []).filter(
            (hidden) => !samePath(hidden, path)
          )
        }
      }
    })
    return workspace
  },

  setWorkspaceEngine(path, engine) {
    const { workspaces } = get().prefs
    const known = workspaces.some((workspace) => samePath(workspace.path, path))
    get().update({
      workspaces: known
        ? workspaces.map((workspace) =>
            samePath(workspace.path, path) ? { ...workspace, engine } : workspace
          )
        : [...workspaces, { path, name: basename(path), engine, lastOpenedAt: Date.now() }]
    })
  },

  removeWorkspace(path) {
    const { workspaces, activeWorkspace } = get().prefs
    const remaining = workspaces.filter((w) => !samePath(w.path, path))
    const sessions = get().prefs.features.sessions
    const hiddenWorkspaces = [
      ...new Set([...(sessions?.hiddenWorkspaces ?? []), normalizePath(path)])
    ]
    get().update({
      workspaces: remaining,
      activeWorkspace: samePath(activeWorkspace, path)
        ? (remaining[0]?.path ?? null)
        : activeWorkspace,
      features: { sessions: { ...sessions, hiddenWorkspaces } }
    })
  },

  toggleSidebar(open) {
    const sidebar = get().prefs.sidebar
    get().update({ sidebar: { ...sidebar, open: open ?? !sidebar.open } })
  },

  toggleInspector(open) {
    const inspector = get().prefs.inspector
    get().update({ inspector: { ...inspector, open: open ?? !inspector.open } })
  },

  setInspectorTab(tab) {
    get().update({ inspector: { ...get().prefs.inspector, tab, open: true } })
  },

  openSettings(section, engine) {
    set((state) => ({
      ui: {
        ...state.ui,
        settingsOpen: true,
        settingsSection: section ?? state.ui.settingsSection,
        settingsEngine: engine ?? (state.ui.settingsOpen ? state.ui.settingsEngine : null),
        paletteOpen: false
      }
    }))
  },

  closeSettings() {
    set((state) => ({ ui: { ...state.ui, settingsOpen: false } }))
  },

  setPaletteOpen(open) {
    set((state) => ({ ui: { ...state.ui, paletteOpen: open } }))
  }
}))

/** The active workspace object, if any. */
export const selectActiveWorkspace = (state: AppStore): Workspace | undefined =>
  state.prefs.workspaces.find((w) => samePath(w.path, state.prefs.activeWorkspace))

export function selectWorkspaceEngine(state: AppStore, path: string | null): EngineId {
  const { prefs } = state
  const workspace = prefs.workspaces.find((item) => samePath(item.path, path))
  return normalizeEngineId(workspace ? workspace.engine : prefs.defaultEngine)
}

export function workspaceEngine(path: string | null): EngineId {
  return selectWorkspaceEngine(useApp.getState(), path)
}
