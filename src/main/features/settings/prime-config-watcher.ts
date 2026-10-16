import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { SettingsChangeArea, SettingsEventMap } from '@shared/api/settings'
import { primeProjectDir } from '../../engine/prime/configuration-store'
import { getPrimeAgentDir } from '../../engine/prime/locate'
import { authSignature } from './config-areas'

const WATCH_RETRY_MS = 2_000
const CHANGE_DEBOUNCE_MS = 350
const RESOURCE_SELF_MUTE_MS = 1_500
const CONFIG_AREAS: SettingsChangeArea[] = [
  'settings',
  'auth',
  'models',
  'keybindings',
  'mcp',
  'instructions'
]

interface WatchedRoot {
  path: string
  cwd: string | null
  workspaceRoot: boolean
  signatures: Map<SettingsChangeArea, string | null>
  resourcesMutedUntil: number
  directory?: string
  watcher?: FSWatcher
}

function changedArea(path: string): SettingsChangeArea | null {
  const segments = path.split(sep)
  const name = segments[0]?.toLowerCase()
  if (name === 'settings.json') return 'settings'
  if (name === 'auth.json') return 'auth'
  if (name === 'models.json') return 'models'
  if (name === 'keybindings.json') return 'keybindings'
  if (name === 'mcp.json') return 'mcp'
  if (name && ['skills', 'prompts', 'themes'].includes(name)) return 'resources'
  if (name && ['agents.md', 'claude.md', 'system.md', 'append_system.md'].includes(name)) {
    return 'instructions'
  }
  return null
}

function isWorkspaceInstruction(path: string): boolean {
  return ['agents.md', 'claude.md'].includes(path.toLowerCase())
}

function rootKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function areaSignature(root: WatchedRoot, area: SettingsChangeArea): string | null {
  try {
    if (root.workspaceRoot && area !== 'instructions') return ''
    if (area === 'auth') {
      const path = join(root.path, 'auth.json')
      return authSignature(existsSync(path) ? readFileSync(path, 'utf8') : '{}')
    }
    const signature = createHash('sha256')
    if (existsSync(root.path)) {
      const entries = readdirSync(root.path, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      )
      for (const entry of entries) {
        const path = join(root.path, entry.name)
        const name = entry.name
        if (root.workspaceRoot && !isWorkspaceInstruction(name)) continue
        if (changedArea(name) !== area) continue
        if (entry.isFile()) {
          signature.update(JSON.stringify(name))
          signature.update(createHash('sha256').update(readFileSync(path)).digest())
        }
      }
    }
    return signature.digest('hex')
  } catch {
    // A partial write or replacement is retried on the next filesystem event.
    return null
  }
}

export class PrimeConfigWatcher {
  private readonly roots = new Map<string, WatchedRoot>()
  private readonly pending = new Map<WatchedRoot, Set<SettingsChangeArea>>()
  /** Armed only while a watcher failed; nothing polls a healthy watcher set. */
  private retryTimer: NodeJS.Timeout | undefined
  private flushTimer: NodeJS.Timeout | undefined
  private stopped = true

  constructor(
    private readonly onChange: (event: SettingsEventMap['settings:changed']) => void,
    private readonly workspaces: () => Array<string | null>
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.sync()
  }

  noteSelfChange(area: SettingsChangeArea, cwd: string | null = null): void {
    if (this.stopped) return
    // Capture the completed write, so an outside edit immediately afterwards still differs.
    for (const root of this.roots.values()) {
      if ((root.cwd ? rootKey(root.cwd) : null) !== (cwd ? rootKey(cwd) : null)) continue
      if (area === 'resources') {
        root.resourcesMutedUntil = Date.now() + RESOURCE_SELF_MUTE_MS
        this.pending.get(root)?.delete(area)
        continue
      }
      const signature = areaSignature(root, area)
      if (signature !== null) root.signatures.set(area, signature)
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.flushTimer)
    for (const root of this.roots.values()) root.watcher?.close()
    this.roots.clear()
    this.pending.clear()
    this.retryTimer = undefined
    this.flushTimer = undefined
  }

  /** Re-read the workspace list: call when the active workspace or the set of Engine 2 sessions changes. */
  sync(): void {
    if (this.stopped) return
    const wanted = new Set<string>()
    const addRoot = (path: string, cwd: string | null, workspaceRoot = false): void => {
      const absolute = resolve(path)
      const key = rootKey(absolute)
      wanted.add(key)
      if (this.roots.has(key)) return
      const root: WatchedRoot = {
        path: absolute,
        cwd,
        workspaceRoot,
        signatures: new Map(),
        resourcesMutedUntil: 0
      }
      for (const area of CONFIG_AREAS) root.signatures.set(area, areaSignature(root, area))
      this.roots.set(key, root)
    }
    addRoot(getPrimeAgentDir(), null)
    for (const cwd of this.workspaces()) {
      if (!cwd) continue
      addRoot(primeProjectDir(cwd), cwd)
      addRoot(cwd, cwd, true)
    }
    for (const [key, root] of this.roots) {
      if (wanted.has(key)) continue
      root.watcher?.close()
      this.pending.delete(root)
      this.roots.delete(key)
    }
    for (const root of this.roots.values()) this.syncRoot(root)
  }

  private syncRoot(root: WatchedRoot): void {
    let directory = root.path
    while (!existsSync(directory) && dirname(directory) !== directory) {
      directory = dirname(directory)
    }
    if (root.watcher && root.directory === directory) return
    root.watcher?.close()
    root.directory = directory
    try {
      const watcher = watch(
        directory,
        { recursive: directory === root.path && !root.workspaceRoot, persistent: false },
        (event, filename) => {
          if (this.stopped || root.watcher !== watcher) return
          // A removed directory keeps reporting renames on Windows: move to the nearest existing ancestor.
          const removed = event === 'rename' && !existsSync(directory)
          if (removed || directory !== root.path || filename === null) {
            this.sync()
            return
          }
          const path = relative(root.path, join(directory, filename.toString()))
          if (root.workspaceRoot && !isWorkspaceInstruction(path)) return
          const area = changedArea(path)
          if (area) this.queue(root, area)
        }
      )
      root.watcher = watcher
      watcher.on('error', () => {
        watcher.close()
        if (root.watcher !== watcher) return
        root.watcher = undefined
        this.retryLater()
      })
      // Missing directories may be created with their files before a watcher can attach.
      for (const area of CONFIG_AREAS) this.queue(root, area)
    } catch {
      root.watcher = undefined
      this.retryLater()
    }
  }

  private retryLater(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.sync()
    }, WATCH_RETRY_MS)
    this.retryTimer.unref()
  }

  private queue(root: WatchedRoot, area: SettingsChangeArea): void {
    if (this.stopped) return
    const areas = this.pending.get(root) ?? new Set<SettingsChangeArea>()
    areas.add(area)
    this.pending.set(root, areas)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flush(), CHANGE_DEBOUNCE_MS)
  }

  private flush(): void {
    this.flushTimer = undefined
    if (this.stopped) return
    // Drops the roots of sessions that ended without engine:dispose (renderer crash or reload: disposeAll).
    this.sync()
    const pending = [...this.pending]
    this.pending.clear()
    for (const [root, areas] of pending) {
      for (const area of areas) {
        if (this.stopped) return
        if (area === 'resources') {
          if (Date.now() < root.resourcesMutedUntil) continue
        } else {
          const next = areaSignature(root, area)
          if (next === null || next === root.signatures.get(area)) continue
          root.signatures.set(area, next)
        }
        this.onChange({
          engine: 'prime',
          area,
          external: true,
          ...(root.cwd ? { project: { cwd: root.cwd, trusted: true } } : {})
        })
      }
    }
  }
}
