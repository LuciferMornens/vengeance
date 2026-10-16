import { create } from 'zustand'
import type { OpenSessionRef } from '@shared/api/app'
import {
  ENGINE_LABELS,
  normalizeEngineId,
  type BackgroundAgentInfo,
  type EngineId
} from '@shared/api/engine'
import type {
  ImportCandidate,
  SessionListItem,
  SessionScope,
  SessionsPrefs
} from '@shared/api/sessions'
import { invoke, on } from '../../lib/ipc'
import { sameSessionLineage } from '@shared/session-identity'
import { normalizePath, samePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { setListingLookup } from './model'

export const ALL_WORKSPACES = '*'

const pendingLists = new Map<string, Promise<void>>()
const invalidatedLists = new Set<string>()
let backgroundInvalidated = false
const MAX_INACTIVE_LISTS = 8
const MAX_INACTIVE_CHARACTERS = 8 * 1024 * 1024
const LIST_FRESH_MS = 5000
const listingIndexes = new WeakMap<Record<string, SessionList>, Map<string, SessionListItem>>()

function selectedListKey(): string {
  const { prefs } = useApp.getState()
  return listKey(prefs.features.sessions?.scope === 'all' ? null : prefs.activeWorkspace)
}

function listingCharacters(list: SessionList): number {
  return list.items.reduce(
    (total, item) => total + item.firstMessage.length + (item.searchText?.length ?? 0),
    0
  )
}

function trimLists(lists: Record<string, SessionList>, dormant: OpenSessionRef[]) {
  const selected = selectedListKey()
  const dormantPaths = new Set(dormant.map((session) => normalizePath(session.path)))
  const inactive = Object.entries(lists)
    .filter(([key, list]) => key !== selected && !list.loading)
    .sort(([, first], [, second]) => second.accessedAt - first.accessedAt)
  let characters = 0
  let count = 0
  const trimmed = { ...lists }
  for (const [key, list] of inactive) {
    const size = listingCharacters(list)
    if (count < MAX_INACTIVE_LISTS && characters + size <= MAX_INACTIVE_CHARACTERS) {
      count++
      characters += size
      continue
    }
    // Restored tabs still need their names without keeping the workspace's entire history.
    const retained = list.items.filter((item) => dormantPaths.has(normalizePath(item.path)))
    if (retained.length) trimmed[key] = { ...list, items: retained, loaded: false }
    else delete trimmed[key]
  }
  return trimmed
}

export function listKey(cwd: string | null): string {
  return cwd === null ? ALL_WORKSPACES : normalizePath(cwd)
}

export interface SessionList {
  warning?: string
  /** The query this list was loaded for (null = every workspace). */
  cwd: string | null
  items: SessionListItem[]
  loading: boolean
  loaded: boolean
  accessedAt: number
  loadedAt?: number
  error?: string
}

/** What a session operation acts on: an open agent and/or a session file. */
export interface SessionTarget {
  engine?: EngineId
  agentId?: string
  path?: string
  cwd: string
  title: string
}

export type SessionDialog =
  | { kind: 'fork'; target: SessionTarget }
  | { kind: 'delete'; target: SessionTarget & { path: string } }
  | { kind: 'close'; agentId: string; title: string }
  | { kind: 'share'; target: SessionTarget }
  | { kind: 'import'; candidate: ImportCandidate }
  /** Session tree of a closed session file (browse, label, branch). */
  | { kind: 'tree'; target: SessionTarget & { path: string } }

interface SessionsStore {
  lists: Record<string, SessionList>
  query: string
  /** Row key being renamed inline (session path or `agent:<id>`). */
  renaming: string | null
  dialog: SessionDialog | null
  /** Agents that finished a run while in the background. */
  unread: Record<string, true>
  /** Bumped to ask the sidebar search to take focus. */
  searchFocusNonce: number
  /** Sessions open at the last quit that have not been resumed yet (restore.ts), in their saved order. */
  dormant: OpenSessionRef[]
  background: BackgroundAgentInfo[]
  backgroundLoading: boolean
  backgroundError: string | null
  expandedLists: string[]

  load(cwd: string | null, force?: boolean): Promise<void>
  loadBackground(): Promise<void>
  reloadLoaded(): void
  setQuery(query: string): void
  setRenaming(key: string | null): void
  openDialog(dialog: SessionDialog | null): void
  focusSearch(): void
  toggleExpanded(key: string): void
}

export const useSessions = create<SessionsStore>()((set, get) => ({
  lists: {},
  query: '',
  renaming: null,
  dialog: null,
  unread: {},
  searchFocusNonce: 0,
  dormant: [],
  background: [],
  backgroundLoading: false,
  backgroundError: null,
  expandedLists: [],

  async loadBackground() {
    if (get().backgroundLoading) {
      backgroundInvalidated = true
      return
    }
    set({ backgroundLoading: true })
    try {
      const background = await invoke('engine:background-list', 'prime')
      set((state) => ({
        background: sameBackgroundAgents(state.background, background)
          ? state.background
          : background,
        backgroundError: null
      }))
    } catch (error) {
      set({ backgroundError: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ backgroundLoading: false })
      if (backgroundInvalidated) {
        backgroundInvalidated = false
        void get().loadBackground()
      }
    }
  },

  async load(cwd, force = false) {
    const key = listKey(cwd)
    const pending = pendingLists.get(key)
    if (pending) return pending
    const current = get().lists[key]
    if (
      !force &&
      current?.loaded &&
      !current.error &&
      Date.now() - (current.loadedAt ?? 0) < LIST_FRESH_MS
    ) {
      set((state) => ({
        lists: { ...state.lists, [key]: { ...current, accessedAt: Date.now() } }
      }))
      return
    }
    set((s) => ({
      lists: {
        ...s.lists,
        [key]: {
          cwd,
          items: current?.items ?? [],
          loaded: current?.loaded ?? false,
          loadedAt: current?.loadedAt,
          loading: true,
          accessedAt: Date.now()
        }
      }
    }))
    const loading = listAllEngineSessions(cwd, current?.items ?? [])
      .then(({ items, error, warning }) => {
        set((state) => ({
          lists: trimLists(
            {
              ...state.lists,
              [key]: {
                cwd,
                items: shareListingItems(items, state.lists, key),
                error,
                warning,
                loading: false,
                loaded: true,
                loadedAt: Date.now(),
                accessedAt: Date.now()
              }
            },
            state.dormant
          )
        }))
      })
      .catch((error: unknown) => {
        set((state) => ({
          lists: trimLists(
            {
              ...state.lists,
              [key]: {
                cwd,
                items: current?.items ?? [],
                loading: false,
                loaded: true,
                accessedAt: Date.now(),
                error: error instanceof Error ? error.message : String(error)
              }
            },
            state.dormant
          )
        }))
      })
      .finally(() => {
        pendingLists.delete(key)
        const visible =
          key === selectedListKey() || (key === ALL_WORKSPACES && get().dormant.length > 0)
        if (invalidatedLists.delete(key)) {
          if (visible) void get().load(cwd, true)
          else {
            set((state) => {
              const list = state.lists[key]
              return list ? { lists: { ...state.lists, [key]: { ...list, loaded: false } } } : state
            })
          }
        }
      })
    pendingLists.set(key, loading)
    return loading
  },

  reloadLoaded() {
    const key = selectedListKey()
    const current = get().lists[key]
    for (const pendingKey of pendingLists.keys()) invalidatedLists.add(pendingKey)
    set((state) => ({
      lists: Object.fromEntries(
        Object.entries(state.lists).map(([name, list]) => [
          name,
          name === key ? list : { ...list, loaded: false }
        ])
      )
    }))
    if (pendingLists.has(key)) invalidatedLists.add(key)
    else if (current) void get().load(current.cwd, true)
    // Dormant rows from other workspaces remain visible above the selected history.
    if (get().dormant.length && key !== ALL_WORKSPACES) {
      if (pendingLists.has(ALL_WORKSPACES)) invalidatedLists.add(ALL_WORKSPACES)
      else void get().load(null, true)
    }
  },

  setQuery: (query) => set({ query }),
  setRenaming: (renaming) => set({ renaming }),
  openDialog: (dialog) => set({ dialog }),
  focusSearch: () => set((s) => ({ searchFocusNonce: s.searchFocusNonce + 1 })),
  toggleExpanded: (key) =>
    set((state) => ({
      expandedLists: state.expandedLists.includes(key)
        ? state.expandedLists.filter((item) => item !== key)
        : [...state.expandedLists, key]
    }))
}))

async function listAllEngineSessions(
  cwd: string | null,
  cached: SessionListItem[]
): Promise<{ items: SessionListItem[]; error?: string; warning?: string }> {
  const engines: EngineId[] = ['pi', 'prime']
  const results = await Promise.allSettled(
    engines.map((engine) => invoke('sessions:list', { cwd, engine }))
  )
  const items = new Map<string, SessionListItem>()
  const errors: string[] = []
  const warnings: string[] = []
  results.forEach((result, index) => {
    const engine = engines[index]!
    const sessions =
      result.status === 'fulfilled'
        ? result.value.sessions.map((session) => ({ ...session, engine }))
        : cached.filter((session) => normalizeEngineId(session.engine) === engine)
    for (const session of sessions) items.set(normalizePath(session.path), session)
    if (result.status === 'fulfilled' && result.value.warning) {
      warnings.push(`${ENGINE_LABELS[engine]}: ${result.value.warning}`)
    }
    if (result.status === 'rejected') {
      const reason: unknown = result.reason
      errors.push(
        `${ENGINE_LABELS[engine]}: ${reason instanceof Error ? reason.message : String(reason)}`
      )
    }
  })
  return {
    items: [...items.values()].sort((first, second) => second.modifiedAt - first.modifiedAt),
    error: errors.length ? errors.join('\n') : undefined,
    warning: warnings.length ? warnings.join('\n') : undefined
  }
}

function sameBackgroundAgents(
  current: BackgroundAgentInfo[],
  next: BackgroundAgentInfo[]
): boolean {
  return (
    current.length === next.length &&
    current.every((agent, index) => {
      const other = next[index]
      return (
        other !== undefined &&
        agent.id === other.id &&
        agent.engine === other.engine &&
        agent.name === other.name &&
        agent.cwd === other.cwd &&
        agent.sessionPath === other.sessionPath &&
        agent.sessionId === other.sessionId &&
        sameSessionLineage(agent.lineage, other.lineage) &&
        agent.status === other.status &&
        agent.busy === other.busy
      )
    })
  )
}

/**
 * The listing `lists` already hold for the same unchanged session, else `item`. The workspace list and the every-
 * workspace list carry the same sessions, and every file change reloads them; sharing unchanged listings keeps one
 * copy of each session's search text (up to 4,000 characters) instead of one per list and reload.
 */
function sharedListing(item: SessionListItem, lists: Record<string, SessionList>): SessionListItem {
  const known = findListed(lists, item.path)
  return known && sameListing(known, item) ? known : item
}

function shareListingItems(
  items: SessionListItem[],
  lists: Record<string, SessionList>,
  key: string
): SessionListItem[] {
  const shared = items.map((item) => sharedListing(item, lists))
  const current = lists[key]?.items
  return current?.length === shared.length && current.every((item, index) => item === shared[index])
    ? current
    : shared
}

function sameListing(first: SessionListItem, second: SessionListItem): boolean {
  const keys = new Set([...Object.keys(first), ...Object.keys(second)] as Array<
    keyof SessionListItem
  >)
  for (const key of keys) {
    if (first[key] === second[key]) continue
    if (key === 'lineage' && sameSessionLineage(first.lineage, second.lineage)) continue
    if (
      key !== 'subagentRun' ||
      first.subagentRun?.parentPath !== second.subagentRun?.parentPath ||
      first.subagentRun?.runId !== second.subagentRun?.runId
    )
      return false
  }
  return true
}

/** The listing of a session file in any of `lists`. */
export function findListed(
  lists: Record<string, SessionList>,
  path: string
): SessionListItem | undefined {
  const key = normalizePath(path)
  let index = listingIndexes.get(lists)
  if (!index) {
    index = new Map()
    for (const list of Object.values(lists).sort(
      (first, second) => second.accessedAt - first.accessedAt
    )) {
      for (const item of list.items) {
        const pathKey = normalizePath(item.path)
        if (!index.has(pathKey)) index.set(pathKey, item)
      }
    }
    listingIndexes.set(lists, index)
  }
  return index.get(key)
}

// Titles of open sessions fall back to the listing of their file (model.ts).
setListingLookup((path) => (path ? findListed(useSessions.getState().lists, path) : undefined))

/** Drop a dormant session (restore.ts) from the open list without starting it. */
export function dismissDormant(path: string): void {
  const key = normalizePath(path)
  useSessions.setState((state) => ({
    dormant: state.dormant.filter((session) => normalizePath(session.path) !== key)
  }))
}

// ─── Prefs (AppPersistedState.features.sessions) ──────────────────────────────

export function useSessionsPrefs(): Required<SessionsPrefs> {
  const prefs = useApp((s) => s.prefs.features.sessions)
  return {
    pinned: prefs?.pinned ?? [],
    scope: prefs?.scope ?? 'workspace',
    collapsed: prefs?.collapsed ?? [],
    hiddenWorkspaces: prefs?.hiddenWorkspaces ?? []
  }
}

function patchPrefs(patch: Partial<SessionsPrefs>): void {
  const app = useApp.getState()
  app.updateFeaturePrefs('sessions', { ...app.prefs.features.sessions, ...patch })
}

export function setScope(scope: SessionScope): void {
  patchPrefs({ scope })
}

export function togglePinned(path: string): void {
  const pinned = useApp.getState().prefs.features.sessions?.pinned ?? []
  const exists = pinned.some((p) => normalizePath(p) === normalizePath(path))
  patchPrefs({
    pinned: exists
      ? pinned.filter((p) => normalizePath(p) !== normalizePath(path))
      : [path, ...pinned]
  })
}

export function toggleCollapsed(cwd: string): void {
  const collapsed = useApp.getState().prefs.features.sessions?.collapsed ?? []
  const key = normalizePath(cwd)
  patchPrefs({
    collapsed: collapsed.includes(key) ? collapsed.filter((c) => c !== key) : [...collapsed, key]
  })
}

// ─── Live tracking ────────────────────────────────────────────────────────────

let tracking = false

/** Session files change many times a second while agents work; new workspaces are looked for at most this often. */
const WORKSPACE_RESCAN_MS = 5000
let rescanTimer: ReturnType<typeof setTimeout> | null = null

function scheduleWorkspaceRescan(): void {
  rescanTimer ??= setTimeout(() => {
    rescanTimer = null
    void useApp.getState().discoverWorkspaces()
  }, WORKSPACE_RESCAN_MS)
}

/** Make `cwd` the active workspace without starting a session (adds it to recents when new). */
export function focusWorkspace(cwd: string): void {
  const app = useApp.getState()
  const existing = app.prefs.workspaces.find((w) => samePath(w.path, cwd))
  if (existing) {
    if (app.prefs.activeWorkspace !== existing.path) app.update({ activeWorkspace: existing.path })
  } else {
    app.openWorkspace(cwd)
  }
}

/**
 * Reload listings when session files change on disk, mark agents that finished a run while another session was in
 * front as unread, and keep the active workspace on the active session's folder (the sidebar lists one workspace's
 * sessions, so the session in front must belong to it, however it was brought there). Call once.
 */
export function startSessionsTracking(): void {
  if (tracking) return
  tracking = true
  on('sessions:changed', () => {
    useSessions.getState().reloadLoaded()
    scheduleWorkspaceRescan()
  })
  let phases = new Map<string, string>()
  let front = useAgents.getState().activeAgentId
  useAgents.subscribe((state) => {
    if (state.activeAgentId !== front) {
      front = state.activeAgentId
      const cwd = front ? state.agents[front]?.info.cwd : undefined
      if (cwd) focusWorkspace(cwd)
    }
    const next = new Map<string, string>()
    const finished: string[] = []
    for (const id of state.order) {
      const phase = state.agents[id]?.phase ?? 'idle'
      next.set(id, phase)
      if (phases.get(id) === 'running' && phase === 'idle' && id !== state.activeAgentId)
        finished.push(id)
    }
    phases = next
    const unread = useSessions.getState().unread
    const active = state.activeAgentId
    const removedUnread = Object.keys(unread).some((id) => !state.agents[id])
    if (finished.length > 0 || (active && unread[active]) || removedUnread) {
      const updated = { ...unread }
      for (const id of finished) updated[id] = true
      if (active) delete updated[active]
      for (const id of Object.keys(updated)) if (!state.agents[id]) delete updated[id]
      useSessions.setState({ unread: updated })
    }
  })
}
