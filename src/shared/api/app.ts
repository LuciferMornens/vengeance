import type { ChatPrefs } from './chat'
import type { ComposerPrefs } from './composer'
import type { EngineId } from './engine'
import type { SessionLineage, SessionsPrefs } from './sessions'
import type { SettingsPrefs } from './settings'
import type { UpdatesPrefs } from './updates'

export type ThemePref = 'dark' | 'light' | 'system'
export type AccentName = 'ember' | 'violet' | 'cyan' | 'lime' | 'rose' | 'mono'
export type Density = 'comfortable' | 'compact'

export interface Workspace {
  /** Backend used for new sessions in this workspace. */
  engine?: EngineId
  /** Absolute folder path (also the identity). */
  path: string
  /** Display name (defaults to folder basename). */
  name: string
  /** epoch ms; 0 for a folder only found through its saved history and never opened. */
  lastOpenedAt: number
  pinned?: boolean
}

export interface PanelPrefs {
  open: boolean
  /** px */
  width: number
}

export interface InspectorPanelPrefs extends PanelPrefs {
  tab: string
}

/** A session open in the sidebar when the app last ran (reopened on the next launch). */
export interface OpenSessionRef {
  /** Backend that owns this session; older records belong to the default engine. */
  engine?: EngineId
  /** Session file. */
  path: string
  /** Working folder its engine ran in. */
  cwd: string
  lineage?: SessionLineage
}

/** Feature-owned persisted prefs; each lane extends its own interface in `shared/api/<feature>.ts`. */
export interface FeaturePrefs {
  chat?: ChatPrefs
  composer?: ComposerPrefs
  sessions?: SessionsPrefs
  settings?: SettingsPrefs
  updates?: UpdatesPrefs
}

/** Persisted app preferences (userData/app-state.json, `prefs` key). */
export interface AppPersistedState {
  version: 1
  theme: ThemePref
  accent: AccentName
  /** UI font scale multiplier (1 = 13.5px UI / 15px prose). */
  fontScale: number
  density: Density
  workspaces: Workspace[]
  activeWorkspace: string | null
  /** Backend for new workspaces and Settings without an active workspace. */
  defaultEngine?: EngineId
  sidebar: PanelPrefs
  inspector: InspectorPanelPrefs
  onboardingCompleted: boolean
  /** Optional user override for the engine location (file or folder). */
  engineOverridePath: string | null
  /** Backend-specific executable overrides; the default engine uses engineOverridePath. */
  engineOverridePaths?: Partial<Record<EngineId, string | null>>
  /** Saved sessions that were open, in sidebar order (SPEC "open tabs"); ephemeral ones are not kept. */
  openSessions: OpenSessionRef[]
  /** Session file of the session in front, when it is one of `openSessions`. */
  activeSession: string | null
  features: FeaturePrefs
}

export const DEFAULT_APP_STATE: AppPersistedState = {
  version: 1,
  theme: 'dark',
  accent: 'ember',
  fontScale: 1,
  density: 'comfortable',
  workspaces: [],
  activeWorkspace: null,
  defaultEngine: 'pi',
  sidebar: { open: true, width: 268 },
  inspector: { open: false, width: 340, tab: 'overview' },
  onboardingCompleted: false,
  engineOverridePath: null,
  openSessions: [],
  activeSession: null,
  features: {}
}

/** Static process/platform facts exposed by the preload as `window.vengeance.platform`. */
export interface PlatformInfo {
  os: 'win32' | 'darwin' | 'linux'
  arch: string
  appVersion: string
  versions: { electron: string; chrome: string; node: string }
  /** `VENGEANCE_MOCK=1`: scripted mock engine instead of pi. */
  mock: boolean
  /** `VENGEANCE_TEST=1`: exposes `window.__vengeanceTest`. */
  test: boolean
  /** Window material actually in use: Mica (translucent) or a solid background. */
  material: 'mica' | 'solid'
  /** Where native window controls sit: right (Windows, floating Linux), left (macOS traffic lights), none (tiling Linux). */
  windowControls: 'right' | 'left' | 'none'
  /**
   * Width reserved on the right of the titlebar for native caption buttons (px): 138 on Windows, an estimate on
   * floating Linux, 0 on macOS and tiling Linux. The Window Controls Overlay geometry is exact where it reports one.
   */
  captionButtonsWidth: number
  /** Width (px) the titlebar must leave free at its left edge (macOS traffic lights); 0 elsewhere. */
  titlebarInsetLeft: number
  titlebarHeight: number
}

export interface AppInvokeMap {
  'app:get-state': [result: AppPersistedState]
  /** Shallow-merges top-level keys (and `features.<name>` one level deep), persists, returns the new state. */
  'app:set-state': [patch: Partial<AppPersistedState>, result: AppPersistedState]
  /** True once after main reloaded this window because its renderer crashed (the one-time recovery notice). */
  'app:take-recovery-notice': [result: boolean]
}

export interface AppEventMap {
  /** A second app instance was launched with a folder argument. */
  'app:open-folder': { path: string }
}
