/**
 * Updates feature contract: engine (pi) version, installed packages, and the Vengeance app itself.
 * Handlers live in src/main/ipc/updates.ts (+ src/main/features/updates/**).
 */
import type { ProcessDoneEvent, ProcessLogEvent } from './settings'
import type { EngineId } from './engine'

export type AutoUpdateMode = 'off' | 'notify' | 'automatic'
export type EngineUpdateChannel = 'stable' | 'nightly'

export interface EngineUpdateInfo {
  managedByApp?: boolean
  channel?: EngineUpdateChannel
  rollbackVersion?: string
  current: string
  latest?: string
  available: boolean
  /** Release note from the engine's latest-version endpoint. */
  note?: string
  changelogUrl: string
}

export interface PackageUpdateInfo {
  source: string
  /** Technical name (npm package name or git repo path), used for registry lookups and links. */
  name: string
  /** Human label for the UI (`friendlyExtensionName`). */
  displayName: string
  kind: 'npm' | 'git'
  scope: 'user' | 'project'
  current?: string
  /** npm: latest version; git: undefined (new commits). */
  latest?: string
  changelogUrl?: string
}

export type AppUpdateStatus =
  'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface AppUpdateInfo {
  status: AppUpdateStatus
  current: string
  latest?: string
  /** 0–100 while downloading. */
  progress?: number
  /** Why updates are disabled, or the last error. */
  message?: string
}

/** `models` = refresh the engine's model catalogs (`pi update --models`). */
export type UpdateTarget = 'engine' | 'packages' | 'package' | 'all' | 'models' | 'rollback'

/** Why background checks are paused. */
export type OfflineReason = 'setting' | 'environment' | 'network'

export interface UpdatesState {
  engineId?: EngineId
  checking: boolean
  /** epoch ms of the last completed check. */
  lastChecked: number | null
  offline: boolean
  offlineReason?: OfflineReason
  engine: EngineUpdateInfo | null
  packages: PackageUpdateInfo[]
  app: AppUpdateInfo
  /** In-flight update run (streamed through `updates:log`). */
  running: { runId: string; target: UpdateTarget; source?: string } | null
  /** Engine + package + app updates available. */
  count: number
  error?: string
}

export interface RunUpdateArgs {
  engine?: EngineId
  target: UpdateTarget
  /** Package source for `target: 'package'`. */
  source?: string
  /** Reinstall the engine even when it is current (`--force`; engine/all targets). */
  force?: boolean
}

/** The installed engine's CHANGELOG.md (shipped inside the package). */
export interface EngineChangelog {
  version: string
  path: string
  markdown: string
}

export interface UpdatesInvokeMap {
  'updates:state': [engine: EngineId | undefined, result: UpdatesState]
  'updates:check': [engine: EngineId | undefined, result: UpdatesState]
  'updates:set-channel': [engine: EngineId, channel: EngineUpdateChannel, result: UpdatesState]
  /** Toggle UpdatesPrefs.offline in main so checks pause/resume immediately. */
  'updates:set-offline': [offline: boolean, result: UpdatesState]
  /** Start `pi update …` (streamed); returns the run id. */
  'updates:run': [args: RunUpdateArgs, result: string]
  /** Quit and install a downloaded Vengeance update. */
  'updates:app-install': [result: void]
  /** Download an available Vengeance update (notify mode). */
  'updates:app-download': [result: void]
  'updates:changelog': [engine: EngineId | undefined, result: EngineChangelog]
}

export interface UpdatesEventMap {
  'updates:state': UpdatesState
  'updates:log': ProcessLogEvent
  'updates:done': ProcessDoneEvent & { target: UpdateTarget }
  /** Engine and/or packages changed on disk: restart idle engines, re-query capabilities. */
  'updates:applied': { engineId?: EngineId; engine: boolean; packages: boolean; automatic: boolean }
  /** The installed engine version changed outside Vengeance (e.g. `pi update` in a terminal). */
  'updates:engine-changed': { engineId?: EngineId; from?: string; to: string }
}

export interface UpdatesPrefs {
  /** Default: notify. */
  mode?: AutoUpdateMode
  /** Background check interval in hours (default 6). */
  intervalHours?: number
  /** Generic electron-updater feed for Vengeance itself; app updates are disabled when empty. */
  feedUrl?: string
  /**
   * Work offline: pauses every background check. Launch code should also start engines with
   * `--offline` (LaunchOptions.offline) while this is on.
   */
  offline?: boolean
}

export const DEFAULT_UPDATE_INTERVAL_HOURS = 6
