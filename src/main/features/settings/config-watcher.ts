import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import type { SettingsChangeArea } from '@shared/api/settings'
import { appState } from '../../app-state'
import { watchTree, type TreeWatcher } from '../../watch-tree'
import { agentDir, projectRoot } from './agent-dir'
import {
  agentDirArea,
  areaOf,
  authSignature,
  INSTRUCTION_FILE,
  watchedConfigFolder
} from './config-areas'
import { engineSavedMcp } from './engine-mcp-saves'
import { lastWrittenText, rememberWrittenText } from './json-file'
import { hadRecentRun, hasActiveRuns } from './pi-cli'
import { rejectedSignIns, rejectedSignInsChange } from './stored-credential'

/**
 * Watches the engine's config on disk (agent dir + the active project's `.pi/` and context files) and
 * reports changes made outside Vengeance — a terminal `pi install`, an edited extension, a hand-edited
 * settings.json — as `settings:changed { external: true }`. Writes Vengeance makes itself are announced
 * by their handlers, so those areas are muted briefly (`noteSelfChange`) and while CLI runs are active.
 * Inside that window, a file Vengeance wrote itself still reports a change when its content differs from
 * that write. The mcp.json saves of the MCP chip's switches are passed over (engine-mcp-saves.ts).
 * Engine-written credentials (N1) are ignored; see config-areas.ts. The Engine's mark of a sign-in the provider refused
 * to renew (stored-credential.ts) is reported as a `live` auth change, which refreshes what the app shows.
 */

const DEBOUNCE_MS = 350
const SELF_MUTE_MS = 1500

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A watch on one config folder (ConfigWatcher.watchDir). */
interface FolderWatch {
  close(): void
}

/** A classified file change; `live` when it only records state an engine already applies. */
interface WatchedChange {
  area: SettingsChangeArea
  live: boolean
}

/** What of auth.json the watcher compares: `authSignature`, and the sign-ins the Engine marked refused. */
interface AuthState {
  providers: string
  rejected: string[]
}

export class ConfigWatcher {
  private agentWatcher: FolderWatch | null = null
  private projectWatchers: FolderWatch[] = []
  private project: string | null = null
  /**
   * Changes waiting for the debounce, per area and folder (null = the agent dir), whether a file's content proved the
   * change came from outside, and whether a CLI run Vengeance started made it.
   */
  private pending = new Map<
    string,
    {
      area: SettingsChangeArea
      cwd: string | null
      outside: boolean
      fromRun: boolean
      live: boolean
    }
  >()
  private flushTimer: NodeJS.Timeout | null = null
  private stopWorkspaceListener: (() => void) | null = null
  private readonly muted = new Map<SettingsChangeArea, number>()
  /** Set by stop(): late timers and watcher events must not re-arm anything during quit. */
  private stopped = false
  /** Last seen `authSignature` of `<agentDir>/auth.json`, and its sign-ins the Engine marked refused. */
  private authState: AuthState | null = null

  /**
   * @param enginesStarting true while an engine process is starting: it may install missing packages
   *   (`npm/`, `git/`), which is not an outside change.
   * @param onChange `fromRun`: settings.json was rewritten by an install or update Vengeance ran (its package list);
   *   that run announces its own change. `live`: the Engine only marked sign-ins the provider refused to renew in
   *   auth.json; it already stopped using them, so nothing needs a restart.
   */
  constructor(
    private readonly onChange: (
      area: SettingsChangeArea,
      projectCwd: string | null,
      fromRun: boolean,
      live: boolean
    ) => void,
    private readonly enginesStarting: () => boolean
  ) {}

  start(): void {
    this.authState = this.readAuthState()
    this.agentWatcher = this.watchDir(agentDir(), true, null, (segments) => {
      const area = agentDirArea(segments)
      return area === 'auth' ? this.authChange() : area
    })
    this.syncProject()
    this.stopWorkspaceListener = appState.onPrefsChange((prefs, previous) => {
      if (prefs.activeWorkspace !== previous.activeWorkspace) this.syncProject()
    })
  }

  stop(): void {
    this.stopped = true
    this.agentWatcher?.close()
    this.agentWatcher = null
    this.closeProject()
    this.stopWorkspaceListener?.()
    this.stopWorkspaceListener = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
  }

  /** Vengeance itself just wrote this area (its handler broadcasts the change). */
  noteSelfChange(area: SettingsChangeArea): void {
    this.muted.set(area, Date.now() + SELF_MUTE_MS)
  }

  /**
   * `authSignature` of auth.json and its refused sign-ins. A missing file holds no credentials, the same as the empty
   * `{}` an engine creates on its first start, so that creation is no sign-in. Null while the file cannot be parsed
   * (mid-write).
   */
  private readAuthState(): AuthState | null {
    const path = join(agentDir(), 'auth.json')
    const text = existsSync(path) ? readText(path) : '{}'
    const providers = authSignature(text)
    const rejected = rejectedSignIns(text)
    return providers === null || rejected === null ? null : { providers, rejected }
  }

  /**
   * `auth` when the provider set changed or a refused sign-in was replaced, a `live` one when the Engine only marked
   * sign-ins refused; token refreshes by running engines are ignored.
   */
  private authChange(): WatchedChange | null {
    const next = this.readAuthState()
    // Mid-write reads fail to parse: keep the last state and wait for the next event.
    if (next === null) return null
    const previous = this.authState
    this.authState = next
    if (next.providers !== previous?.providers) return { area: 'auth', live: false }
    const marks = rejectedSignInsChange(previous.rejected, next.rejected)
    // A cleared mark is a new sign-in: open sessions that stopped offering the provider list it again after a restart.
    return marks ? { area: 'auth', live: marks === 'added' } : null
  }

  /**
   * Watch `dir`, with its config subfolders when `subfolders`. A watch the system refuses or ends (Linux: ENOSPC once
   * fs.inotify.max_user_watches is used up) is logged, and the folder, while it exists, falls back to its top level,
   * which holds the config files. A removed folder is re-armed by syncProject.
   */
  private watchDir(
    dir: string,
    subfolders: boolean,
    cwd: string | null,
    classify: (segments: string[]) => SettingsChangeArea | WatchedChange | null
  ): FolderWatch | null {
    if (!existsSync(dir)) return null
    const listener = (_event: string, filename: string | null): void => {
      if (!filename) return
      const classified = classify(filename.split(/[\\/]+/).filter(Boolean))
      const change = typeof classified === 'string' ? { area: classified, live: false } : classified
      if (!change) return
      // Resolving packages creates empty folders (npm/, git/, extensions/); only files change resources.
      const resourceArea = change.area === 'packages' || change.area === 'resources'
      if (resourceArea && isDirectory(join(dir, filename))) return
      this.queue(change, cwd, join(dir, filename))
    }
    let current: TreeWatcher | null = null
    const lost = (tree: boolean, error: Error): void => {
      if (this.stopped || !existsSync(dir)) return
      console.warn(
        tree
          ? `[vengeance] cannot watch ${dir} with its subfolders (${error.message}); watching its top level`
          : `[vengeance] cannot watch ${dir} (${error.message})`
      )
      if (tree) arm(false)
    }
    const arm = (tree: boolean): void => {
      try {
        const watcher = tree
          ? watchTree(dir, watchedConfigFolder, listener)
          : watch(dir, { persistent: false }, listener)
        current = watcher
        watcher.on('error', (error) => {
          watcher.close()
          if (current !== watcher) return
          current = null
          lost(tree, error)
        })
      } catch (error) {
        lost(tree, error as Error)
      }
    }
    arm(subfolders)
    return {
      close: () => {
        current?.close()
        current = null
      }
    }
  }

  private closeProject(): void {
    for (const watcher of this.projectWatchers) watcher.close()
    this.projectWatchers = []
  }

  /** (Re-)arm project watchers when the active workspace changes or its `.pi` folder appears. */
  private syncProject(force = false): void {
    if (this.stopped) return
    const cwd = appState.getPrefs().activeWorkspace
    const root = cwd ? projectRoot(cwd) : null
    if (!force && root === this.project) return
    this.closeProject()
    this.project = root
    if (!root || !cwd) return
    const rootWatcher = this.watchDir(root, false, cwd, (segments) => {
      const [name] = segments
      if (name === '.pi') {
        // Created or removed: re-arm the recursive watcher on next tick.
        setTimeout(() => this.syncProject(true), 0)
        return 'settings'
      }
      return segments.length === 1 && INSTRUCTION_FILE.test(name!) ? 'instructions' : null
    })
    const configWatcher = this.watchDir(join(root, '.pi'), true, cwd, areaOf)
    this.projectWatchers = [rootWatcher, configWatcher].filter((w): w is FolderWatch => w !== null)
  }

  private isMuted(area: SettingsChangeArea): boolean {
    return (this.muted.get(area) ?? 0) > Date.now()
  }

  private queue({ area, live }: WatchedChange, cwd: string | null, path: string): void {
    if (this.stopped) return
    if (area === 'mcp' && engineSavedMcp(SELF_MUTE_MS)) return
    const written = lastWrittenText(path)
    const differsFromWrite = written !== undefined && readText(path) !== written
    if (area === 'instructions' && written !== undefined) {
      if (!differsFromWrite) return
      rememberWrittenText(path, undefined)
    }
    const outsideEdit = area === 'instructions' || differsFromWrite
    if (!outsideEdit && this.isMuted(area)) return
    if ((area === 'packages' || area === 'resources') && hasActiveRuns()) return
    if (area === 'packages' && this.enginesStarting()) return
    const key = `${area}|${cwd ?? ''}`
    const queued = this.pending.get(key)
    const fromRun = area === 'settings' && hadRecentRun(SELF_MUTE_MS) && (queued?.fromRun ?? true)
    this.pending.set(key, {
      area,
      cwd,
      outside: outsideEdit || queued?.outside === true,
      fromRun,
      // A sign-in or sign-out in the same burst is a real change.
      live: live && (queued?.live ?? true)
    })
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const changes = [...this.pending.values()]
      this.pending.clear()
      for (const change of changes)
        if (change.outside || !this.isMuted(change.area))
          this.onChange(change.area, change.cwd, change.fromRun, change.live)
    }, DEBOUNCE_MS)
  }
}
