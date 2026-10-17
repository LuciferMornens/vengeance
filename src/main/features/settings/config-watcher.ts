import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { SettingsChangeArea } from '@shared/api/settings'
import { appState } from '../../app-state'
import { agentDir, projectRoot } from './agent-dir'
import { agentDirArea, areaOf, authSignature, INSTRUCTION_FILE } from './config-areas'
import { lastWrittenText } from './json-file'
import { hadRecentRun, hasActiveRuns } from './pi-cli'

/**
 * Watches the engine's config on disk (agent dir + the active project's `.pi/` and context files) and
 * reports changes made outside Vengeance — a terminal `pi install`, an edited extension, a hand-edited
 * settings.json — as `settings:changed { external: true }`. Writes Vengeance makes itself are announced
 * by their handlers, so those areas are muted briefly (`noteSelfChange`) and while CLI runs are active.
 * Inside that window, a file Vengeance wrote itself still reports a change when its content differs from
 * that write.
 * Engine-written credentials (N1) are ignored; see config-areas.ts.
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

export class ConfigWatcher {
  private agentWatcher: FSWatcher | null = null
  private projectWatchers: FSWatcher[] = []
  private project: string | null = null
  /**
   * Changes waiting for the debounce, per area and folder (null = the agent dir), whether a file's content proved the
   * change came from outside, and whether a CLI run Vengeance started made it.
   */
  private pending = new Map<
    string,
    { area: SettingsChangeArea; cwd: string | null; outside: boolean; fromRun: boolean }
  >()
  private flushTimer: NodeJS.Timeout | null = null
  private stopWorkspaceListener: (() => void) | null = null
  private readonly muted = new Map<SettingsChangeArea, number>()
  /** Set by stop(): late timers and watcher events must not re-arm anything during quit. */
  private stopped = false
  /** Last seen `authSignature` of `<agentDir>/auth.json`. */
  private authState: string | null = null

  /**
   * @param enginesStarting true while an engine process is starting: it may install missing packages
   *   (`npm/`, `git/`), which is not an outside change.
   * @param onChange `fromRun`: settings.json was rewritten by an install or update Vengeance ran (its package list);
   *   that run announces its own change.
   */
  constructor(
    private readonly onChange: (
      area: SettingsChangeArea,
      projectCwd: string | null,
      fromRun: boolean
    ) => void,
    private readonly enginesStarting: () => boolean
  ) {}

  start(): void {
    this.authState = this.readAuthSignature()
    this.agentWatcher = this.watchDir(agentDir(), true, null, (segments) => {
      const area = agentDirArea(segments)
      return area === 'auth' ? this.authArea() : area
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
   * `authSignature` of auth.json. A missing file holds no credentials, the same as the empty `{}` an engine creates
   * on its first start, so that creation is no sign-in. Null while the file cannot be parsed (mid-write).
   */
  private readAuthSignature(): string | null {
    const path = join(agentDir(), 'auth.json')
    return authSignature(existsSync(path) ? readText(path) : '{}')
  }

  /** `auth` only when the provider set changed; token refreshes by running engines are ignored. */
  private authArea(): SettingsChangeArea | null {
    const next = this.readAuthSignature()
    // Mid-write reads fail to parse: keep the last state and wait for the next event.
    if (next === null) return null
    if (next === this.authState) return null
    this.authState = next
    return 'auth'
  }

  private watchDir(
    dir: string,
    recursive: boolean,
    cwd: string | null,
    classify: (segments: string[]) => SettingsChangeArea | null
  ): FSWatcher | null {
    if (!existsSync(dir)) return null
    try {
      const watcher = watch(dir, { recursive, persistent: false }, (_event, filename) => {
        if (!filename) return
        const area = classify(filename.split(/[\\/]+/).filter(Boolean))
        // Resolving packages creates empty folders (npm/, git/, extensions/); only files change resources.
        if ((area === 'packages' || area === 'resources') && isDirectory(join(dir, filename))) return
        if (area) this.queue(area, cwd, join(dir, filename))
      })
      watcher.on('error', () => watcher.close())
      return watcher
    } catch {
      return null
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
    this.projectWatchers = [rootWatcher, configWatcher].filter((w): w is FSWatcher => w !== null)
  }

  private isMuted(area: SettingsChangeArea): boolean {
    return (this.muted.get(area) ?? 0) > Date.now()
  }

  private queue(area: SettingsChangeArea, cwd: string | null, path: string): void {
    if (this.stopped) return
    const written = lastWrittenText(path)
    const outsideEdit = written !== undefined && readText(path) !== written
    if (!outsideEdit && this.isMuted(area)) return
    if ((area === 'packages' || area === 'resources') && hasActiveRuns()) return
    if (area === 'packages' && this.enginesStarting()) return
    const key = `${area}|${cwd ?? ''}`
    const queued = this.pending.get(key)
    const fromRun = area === 'settings' && hadRecentRun(SELF_MUTE_MS) && (queued?.fromRun ?? true)
    this.pending.set(key, { area, cwd, outside: outsideEdit || queued?.outside === true, fromRun })
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const changes = [...this.pending.values()]
      this.pending.clear()
      for (const change of changes)
        if (change.outside || !this.isMuted(change.area))
          this.onChange(change.area, change.cwd, change.fromRun)
    }, DEBOUNCE_MS)
  }
}
