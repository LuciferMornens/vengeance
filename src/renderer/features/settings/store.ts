import { create } from 'zustand'
import type { EngineId } from '@shared/api/engine'
import type {
  JsonObject,
  JsonValue,
  ModelCatalog,
  SettingPath,
  SettingsChangeArea,
  SettingsScope,
  SettingsSnapshot
} from '@shared/api/settings'
import { on } from '../../lib/ipc'
import { normalizePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { flushAppPreferences, useApp, workspaceEngine } from '../../store/app'
import { toast } from '../../ui'
import {
  afterEngineConfigChange,
  agentsForEngine,
  applyLiveSetting,
  applyOutsideSettingsEdit,
  refreshAgents
} from './engines'
import { settingsInvoke, settingsInvokeForFolder } from './ipc'
import { findEngineSetting, getAt, liveSetting, settingEffect, splitKey } from './values'

/** Engine settings state for the settings sheet: both files, active scope, catalog, search. */

export interface SettingsTarget {
  engine: EngineId
  cwd: string | null
  scope: SettingsScope
}

export interface SettingsStore {
  engine: EngineId
  setEngine(engine: EngineId): void
  selectDefaultEngine(engine: EngineId): Promise<void>
  snapshot: SettingsSnapshot | null
  loading: boolean
  error: string | null
  /** Editing scope; project requires an active workspace. */
  scope: SettingsScope
  catalog: ModelCatalog | null
  catalogLoading: boolean
  catalogError: string | null
  query: string
  /** Setting key to pulse after a search jump. */
  highlight: string | null

  load(): Promise<void>
  /** `withExtensionProviders` re-reads the providers extensions register (the Providers page only: it loads them). */
  loadCatalog(force?: boolean, withExtensionProviders?: boolean): Promise<void>
  setScope(scope: SettingsScope): void
  setQuery(query: string): void
  setHighlight(key: string | null): void
  /** Write one key in the active scope (`undefined` resets it). */
  set(
    key: string | SettingPath,
    value: JsonValue | undefined,
    scope?: SettingsScope,
    effect?: 'restart' | 'none'
  ): Promise<void>
  setForTarget(
    target: SettingsTarget,
    key: string | SettingPath,
    value: JsonValue | undefined,
    effect?: 'restart' | 'none'
  ): Promise<void>
  replaceSnapshot(snapshot: SettingsSnapshot, engine?: EngineId): void
}

export function activeCwd(): string | null {
  return useApp.getState().prefs.activeWorkspace
}

function setAtLocal(root: JsonObject, path: SettingPath, value: JsonValue | undefined): JsonObject {
  const [head, ...rest] = path
  if (head === undefined) return root
  const next = { ...root }
  if (rest.length === 0) {
    if (value === undefined) delete next[head]
    else next[head] = value
    return next
  }
  const child = next[head]
  const updated = setAtLocal(
    child && typeof child === 'object' && !Array.isArray(child) ? child : {},
    rest,
    value
  )
  if (Object.keys(updated).length === 0) delete next[head]
  else next[head] = updated
  return next
}

/** The catalog every picker shows: it also offers what only an open session has. */
export function withSessionModels(catalog: ModelCatalog): ModelCatalog {
  return { ...catalog, models: [...catalog.models, ...(catalog.sessionModels ?? [])] }
}

/** The latest catalog request wins when loads overlap. */
let catalogRequests = 0
let snapshotRequests = 0
let engineSelections = 0
const settingsBaselines = new Map<string, SettingsSnapshot>()
const snapshotQueues = new Map<EngineId, Promise<unknown>>()
const baselineSeeds = new Set<string>()
const outsideReads = new Map<string, boolean>()

function baselineKey(engine: EngineId, cwd: string | null): string {
  return JSON.stringify([engine, cwd === null ? null : normalizePath(cwd)])
}

function serializeSnapshot<Result>(engine: EngineId, read: () => Promise<Result>): Promise<Result> {
  const pending = (snapshotQueues.get(engine) ?? Promise.resolve()).then(read, read)
  snapshotQueues.set(engine, pending)
  void pending
    .finally(() => {
      if (snapshotQueues.get(engine) === pending) snapshotQueues.delete(engine)
    })
    .catch(() => undefined)
  return pending
}

function retainedBaselineScopes(): Map<string, { engine: EngineId; cwd: string | null }> {
  const scopes = new Map<string, { engine: EngineId; cwd: string | null }>()
  const retain = (engine: EngineId, cwd: string | null) => {
    if (cwd) scopes.set(baselineKey(engine, cwd), { engine, cwd })
    scopes.set(baselineKey(engine, null), { engine, cwd: null })
  }
  if (useApp.getState().ready) {
    retain(workspaceEngine(activeCwd()), activeCwd())
    retain(useSettings.getState().engine, activeCwd())
  }
  for (const agent of Object.values(useAgents.getState().agents)) {
    retain(agent.info.engine, agent.info.cwd)
  }
  return scopes
}

function rememberSnapshot(
  engine: EngineId,
  snapshot: SettingsSnapshot,
  scope?: SettingsScope,
  seedOnly = false
): void {
  const retained = retainedBaselineScopes()
  const remember = (cwd: string | null) => {
    const key = baselineKey(engine, cwd)
    if (retained.has(key) && (!seedOnly || !settingsBaselines.has(key))) {
      settingsBaselines.set(key, snapshot)
    }
  }
  if (scope !== 'project' && !snapshot.global.error) remember(null)
  if (scope !== 'global' && snapshot.project && !snapshot.project.error)
    remember(snapshot.project.cwd)
}

function synchronizeBaselines(): void {
  const retained = retainedBaselineScopes()
  for (const key of settingsBaselines.keys()) {
    if (!retained.has(key)) settingsBaselines.delete(key)
  }
  for (const [key, { engine, cwd }] of retained) {
    if (settingsBaselines.has(key) || baselineSeeds.has(key)) continue
    baselineSeeds.add(key)
    void serializeSnapshot(engine, async () => {
      if (!retainedBaselineScopes().has(key) || settingsBaselines.has(key)) return
      const snapshot = await settingsInvokeForFolder(engine, cwd, 'settings:snapshot', cwd)
      rememberSnapshot(engine, snapshot, undefined, true)
    })
      .catch(() => undefined)
      .finally(() => baselineSeeds.delete(key))
  }
}

export const useSettings = create<SettingsStore>()((set, get) => ({
  engine: workspaceEngine(activeCwd()),
  snapshot: null,
  loading: false,
  error: null,
  scope: 'global',
  catalog: null,
  catalogLoading: false,
  catalogError: null,
  query: '',
  highlight: null,

  async selectDefaultEngine(engine) {
    const selection = ++engineSelections
    const app = useApp.getState()
    const cwd = app.prefs.activeWorkspace
    const previousEngine = workspaceEngine(cwd)
    if (cwd) app.setWorkspaceEngine(cwd, engine)
    else app.update({ defaultEngine: engine })
    if (app.ui.settingsOpen) app.openSettings(undefined, engine)
    get().setEngine(engine)
    try {
      await flushAppPreferences()
    } catch (error) {
      if (selection === engineSelections && workspaceEngine(cwd) === engine) {
        if (cwd) app.setWorkspaceEngine(cwd, previousEngine)
        else app.update({ defaultEngine: previousEngine })
        if (activeCwd() === cwd) {
          if (useApp.getState().ui.settingsOpen) app.openSettings(undefined, previousEngine)
          get().setEngine(previousEngine)
        }
      }
      toast({
        level: 'error',
        title: 'Engine choice not saved',
        description: error instanceof Error ? error.message : String(error)
      })
    }
  },

  setEngine(engine) {
    if (engine === get().engine) return
    snapshotRequests += 1
    catalogRequests += 1
    set({
      engine,
      snapshot: null,
      catalog: null,
      catalogLoading: false,
      catalogError: null,
      query: '',
      highlight: null,
      error: null
    })
    synchronizeBaselines()
    void get().load()
  },

  async load() {
    const engine = get().engine
    const cwd = activeCwd()
    const request = ++snapshotRequests
    set({ loading: true, error: null })
    try {
      const snapshot = await serializeSnapshot(engine, async () => {
        const next = await settingsInvokeForFolder(engine, cwd, 'settings:snapshot', cwd)
        rememberSnapshot(engine, next, undefined, true)
        return next
      })
      if (request === snapshotRequests) {
        set((state) => ({ snapshot, scope: snapshot.project ? state.scope : 'global' }))
      }
    } catch (error) {
      if (request === snapshotRequests)
        set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (request === snapshotRequests) set({ loading: false })
    }
  },

  async loadCatalog(force, withExtensionProviders) {
    if (!withExtensionProviders && !force && (get().catalogLoading || get().catalog)) return
    const request = ++catalogRequests
    const engine = get().engine
    set({ catalogLoading: true, catalogError: null })
    try {
      const catalog = await settingsInvoke(
        engine,
        withExtensionProviders ? 'settings:extension-providers' : 'settings:catalog'
      )
      if (request === catalogRequests) set({ catalog: withSessionModels(catalog) })
    } catch (error) {
      if (request === catalogRequests) {
        set({ catalogError: error instanceof Error ? error.message : String(error) })
        toast({
          level: 'error',
          title: 'Could not load models',
          description: (error as Error).message
        })
      }
    } finally {
      if (request === catalogRequests) set({ catalogLoading: false })
    }
  },

  setScope(scope) {
    set({ scope })
  },

  setQuery(query) {
    set({ query })
  },

  setHighlight(highlight) {
    set({ highlight })
  },

  async set(key, value, scopeOverride, effectOverride) {
    return get().setForTarget(
      { engine: get().engine, cwd: activeCwd(), scope: scopeOverride ?? get().scope },
      key,
      value,
      effectOverride
    )
  },

  async setForTarget({ engine, cwd, scope }, key, value, effectOverride) {
    const path = splitKey(key)
    const snapshot = get().engine === engine && activeCwd() === cwd ? get().snapshot : null
    // Optimistic: reflect the change immediately, then reconcile with what landed on disk.
    if (snapshot) {
      const file = scope === 'global' ? snapshot.global : snapshot.project
      if (file) {
        const data = setAtLocal(file.data, path, value)
        set({
          snapshot:
            scope === 'global'
              ? { ...snapshot, global: { ...snapshot.global, data } }
              : { ...snapshot, project: { ...snapshot.project!, data } }
        })
      }
    }
    try {
      const next = await settingsInvokeForFolder(engine, cwd, 'settings:set', {
        scope,
        cwd,
        path,
        value
      })
      rememberSnapshot(engine, next, scope)
      if (get().engine === engine && activeCwd() === cwd) set({ snapshot: next })
      const def = findEngineSetting(path.join('.'), engine)
      const live = def && liveSetting(def, engine, scope)
      if (live) await applyLiveSetting(live, next, engine, scope)
      else {
        const affected =
          scope === 'project' ? { agentIds: agentsForEngine(engine, cwd), patch: {} } : undefined
        afterEngineConfigChange(
          effectOverride ?? (def ? settingEffect(def) : 'restart'),
          affected,
          engine
        )
      }
    } catch (error) {
      toast({ level: 'error', title: 'Setting not saved', description: (error as Error).message })
      if (get().engine === engine) void get().load()
    }
  },

  replaceSnapshot(snapshot, engine = get().engine) {
    rememberSnapshot(engine, snapshot)
    if (get().engine === engine && (snapshot.project?.cwd ?? null) === activeCwd())
      set({ snapshot })
  }
}))

/** Areas engines read only at startup, and how the restart offer names a change to them. */
const ENGINE_STARTUP_AREAS = new Map<SettingsChangeArea, string>([
  ['auth', 'Sign-ins changed.'],
  ['models', 'Custom models changed.'],
  ['packages', 'Packages changed.'],
  ['resources', 'Extensions, skills or prompts changed.'],
  ['mcp', 'MCP servers changed.'],
  ['instructions', 'Context files changed.']
])

/**
 * settings.json changed outside Vengeance: reload, then bring open engines in line with what changed. `adopt`: a run
 * Vengeance started rewrote it and announces its own change, so the new file only becomes the baseline.
 */
async function followOutsideSettingsEdit(
  engine: EngineId,
  projectCwd?: string,
  adopt = false
): Promise<void> {
  const cwd = projectCwd ?? activeCwd()
  const scope = projectCwd ? 'project' : 'global'
  const key = baselineKey(engine, projectCwd ?? null)
  if (outsideReads.has(key)) {
    outsideReads.set(key, true)
    return
  }
  outsideReads.set(key, false)
  try {
    do {
      outsideReads.set(key, false)
      await serializeSnapshot(engine, async () => {
        const previous = settingsBaselines.get(key)
        const next = await settingsInvokeForFolder(engine, cwd, 'settings:snapshot', cwd)
        if (useSettings.getState().engine === engine && activeCwd() === cwd) {
          useSettings.setState({ snapshot: next })
        }
        if (scope === 'global' ? next.global.error : next.project?.error) return
        rememberSnapshot(engine, next, scope)
        // A newly observed folder has no evidence of a startup change yet.
        if (previous && !adopt) await applyOutsideSettingsEdit(previous, next, engine, scope)
      })
    } while (outsideReads.get(key))
  } catch {
    refreshAgents(engine)
  } finally {
    outsideReads.delete(key)
  }
}

on('settings:account-models', ({ engine = 'pi' }) => {
  if (useSettings.getState().engine === engine) void useSettings.getState().loadCatalog(true)
})

// Keep the sheet and open engines in sync with changes made elsewhere: other Vengeance views, the terminal, other programs.
on('settings:changed', ({ engine = 'pi', area, external, project, fromRun, apply }) => {
  const store = useSettings.getState()
  if (store.engine === engine && (area === 'auth' || area === 'models'))
    void store.loadCatalog(true)
  // Engines read credentials, custom models, packages, resources, MCP config and instructions only at startup. A
  // change to an untrusted project loads nowhere until the folder is trusted, and trusting it restarts its sessions.
  const reason = ENGINE_STARTUP_AREAS.get(area)
  if (reason && apply !== 'new-sessions') {
    if (!project) afterEngineConfigChange('restart', undefined, engine, reason)
    else if (project.trusted)
      afterEngineConfigChange(
        'restart',
        { agentIds: agentsForEngine(engine, project.cwd), patch: {} },
        engine,
        reason
      )
  }
  if (external && area === 'settings' && (!project || project.trusted)) {
    void followOutsideSettingsEdit(engine, project?.cwd, fromRun)
    return
  }
  if (store.engine !== engine) return
  if (project && project.cwd !== activeCwd()) return
  if (store.snapshot) void store.load()
})

/** While the sheet stays open in a focused window, the engine keeps what its sections read warm (it idles out at 60 s). */
const KEEP_WARM_MS = 45_000
let keepWarm: ReturnType<typeof setInterval> | null = null

function prewarm(engine: EngineId): void {
  void settingsInvoke(engine, 'settings:prewarm').catch(() => undefined)
}

const prewarmShown = () => prewarm(useSettings.getState().engine)

function startKeepWarm(): void {
  if (keepWarm !== null) return
  keepWarm = setInterval(() => document.hasFocus() && prewarmShown(), KEEP_WARM_MS)
  window.addEventListener('focus', prewarmShown)
}

function stopKeepWarm(): void {
  if (keepWarm === null) return
  clearInterval(keepWarm)
  keepWarm = null
  window.removeEventListener('focus', prewarmShown)
}

/** Generic Settings follows workspace defaults; session configuration can target its own engine. */
useApp.subscribe((state, previous) => {
  if (!state.ready) return
  if (!state.ui.settingsOpen && previous.ui.settingsOpen) stopKeepWarm()
  const workspaceChanged = state.prefs.activeWorkspace !== previous.prefs.activeWorkspace
  const opened = state.ui.settingsOpen && !previous.ui.settingsOpen
  const targetChanged = state.ui.settingsEngine !== previous.ui.settingsEngine
  const defaultsChanged =
    state.prefs.workspaces !== previous.prefs.workspaces ||
    state.prefs.defaultEngine !== previous.prefs.defaultEngine
  if (
    !workspaceChanged &&
    !opened &&
    !targetChanged &&
    !defaultsChanged &&
    state.ready === previous.ready
  )
    return
  const settings = useSettings.getState()
  const engine =
    state.ui.settingsOpen && !workspaceChanged && state.ui.settingsEngine
      ? state.ui.settingsEngine
      : workspaceEngine(state.prefs.activeWorkspace)
  // Settings is opening, or shows another engine: let it warm up what its sections read while the sheet loads.
  if (state.ui.settingsOpen && (opened || settings.engine !== engine)) {
    prewarm(engine)
    startKeepWarm()
  }
  if (settings.engine !== engine) {
    settings.setEngine(engine)
    return
  }
  synchronizeBaselines()
  if (!workspaceChanged && state.ready === previous.ready) return
  const refreshCatalog = settings.catalog !== null || settings.catalogLoading
  snapshotRequests += 1
  catalogRequests += 1
  useSettings.setState({
    snapshot: null,
    error: null,
    catalog: null,
    catalogLoading: false,
    catalogError: null
  })
  void settings.load()
  if (refreshCatalog) void settings.loadCatalog(true)
})

// Startup preferences determine the backend before any account configuration is read.
useAgents.subscribe((state, previous) => {
  if (state.order !== previous.order) synchronizeBaselines()
})
if (useApp.getState().ready) {
  synchronizeBaselines()
  void useSettings.getState().load()
}

/** Effective value + where it comes from, for the active scope. */
export interface ResolvedSetting {
  value: JsonValue | undefined
  /** Defined in the active scope's file. */
  setHere: boolean
  /** Project file defines it (shown as an override indicator in global scope). */
  projectValue: JsonValue | undefined
  globalValue: JsonValue | undefined
  origin: 'project' | 'global' | 'default'
}

export function resolveSetting(
  snapshot: SettingsSnapshot | null,
  scope: SettingsScope,
  key: string | SettingPath,
  engine: EngineId = 'pi'
): ResolvedSetting {
  const path = splitKey(key)
  const inheritNull = (value: JsonValue | undefined) =>
    engine === 'prime' && value === null ? undefined : value
  const globalValue = inheritNull(getAt(snapshot?.global.data, path))
  const projectValue = inheritNull(
    snapshot?.project ? getAt(snapshot.project.data, path) : undefined
  )
  if (scope === 'project') {
    if (projectValue !== undefined)
      return { value: projectValue, setHere: true, projectValue, globalValue, origin: 'project' }
    return {
      value: globalValue,
      setHere: false,
      projectValue,
      globalValue,
      origin: globalValue !== undefined ? 'global' : 'default'
    }
  }
  return {
    value: globalValue,
    setHere: globalValue !== undefined,
    projectValue,
    globalValue,
    origin: globalValue !== undefined ? 'global' : 'default'
  }
}

export function useResolved(key: string | SettingPath): ResolvedSetting {
  const snapshot = useSettings((s) => s.snapshot)
  const scope = useSettings((s) => s.scope)
  const engine = useSettings((s) => s.engine)
  return resolveSetting(snapshot, scope, key, engine)
}
