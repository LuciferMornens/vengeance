import { app, BrowserWindow, Menu, session, type RenderProcessGoneDetails } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { SPEED_DEFAULT_ENV } from '@shared/api/speed'
import { appState, engineOverridePath } from './app-state'
import { bridgeExtensionPath } from './engine/bridge'
import { EngineManager } from './engine/manager'
import { env } from './env'
import { maskAgentInfo } from './features/launch/env-vault'
import { accountModelFilter } from './features/settings/account-models'
import { broadcast, handle } from './ipc/handle'
import { registerIpc } from './ipc'
import { createMainWindow, saveWindowBounds, setThemePreference } from './window'

/**
 * Add a Chromium feature to the switch's comma-separated list. appendSwitch alone replaces the value, which would drop
 * features passed on the command line (e.g. `scripts/perf/footprint.mjs --app-args`).
 */
function appendFeature(name: 'enable-features' | 'disable-features', feature: string): void {
  const current = app.commandLine.getSwitchValue(name)
  app.commandLine.appendSwitch(name, current ? `${current},${feature}` : feature)
}

if (env.userDataDir) app.setPath('userData', resolve(env.userDataDir))
// In installed builds Chromium's network service only carries electron-updater's requests (the renderer loads file://
// and main fetches through Node), so it runs inside the browser process instead of a 7 MiB utility process of its
// own. In `npm run dev` it also serves the Vite dev server.
appendFeature('enable-features', 'NetworkServiceInProcess2')
// PartitionAlloc's large per-thread caches hold about 10 MiB of freed memory in a busy renderer; the standard size
// gives it back at the same streaming CPU time and frame times.
appendFeature('disable-features', 'PartitionAllocLargeThreadCacheSize')
// Both are Chromium feature names, which a newer Electron may rename without error: after an Electron upgrade, confirm
// with scripts/perf/footprint.mjs that the app runs 3 processes and the renderer keeps its memory.
// Must equal the installer's appId (its shortcuts carry it): electron-builder.yml for release builds, and
// scripts/dist-qa.mjs for the QA build (product name "Vengeance QA"), which must never group with the real app.
app.setAppUserModelId(app.getName() === 'Vengeance QA' ? 'com.vengeance.qa' : 'com.vengeance.app')
// N12: no application menu outside `npm run dev`, so Electron's default accelerators (Ctrl+R reload, which
// would dispose every engine; Ctrl+Shift+I devtools; Ctrl+W close) never act. Dev keeps the default menu.
if (!env.rendererUrl) Menu.setApplicationMenu(null)

/** A folder passed on the command line (e.g. `Vengeance.exe D:\project`). */
function folderFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const candidate = resolve(arg)
    try {
      if (
        existsSync(candidate) &&
        statSync(candidate).isDirectory() &&
        candidate !== resolve(app.getAppPath())
      )
        return candidate
    } catch {
      // Not a path.
    }
  }
  return null
}

/** Delay before reloading a crashed renderer, by how many crashes came shortly before (a crash loop backs off). */
const RECOVERY_BACKOFF_MS = [0, 2_000, 10_000, 30_000]
/** A crash this long after the previous one starts the backoff over. */
const CRASH_STREAK_RESET_MS = 60_000
/** How long engines outlive a crashed renderer: the reloaded window adopts them (`engine:adopt`) or they stop. */
const ORPHAN_ENGINE_GRACE_MS = 30_000

const singleInstance = env.test || app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let quitting = false
  let recoveryNoticePending = false
  let crashStreak = 0
  let lastCrashAt = 0
  /** Set while engines wait for the reloaded renderer to adopt them; firing stops them. */
  let orphanShutdown: NodeJS.Timeout | null = null

  const manager = new EngineManager(
    {
      onEvent: (agentId, event) => broadcast('engine:event', { agentId, event }),
      onStatus: (agentId, status, info) =>
        broadcast('engine:status', { agentId, status, info: maskAgentInfo(info) }),
      onExit: (exit) => broadcast('engine:exit', exit)
    },
    {
      mock: env.mock,
      engineOverridePath,
      bridgeExtensionPath: () => bridgeExtensionPath(app.isPackaged, process.resourcesPath),
      bridgeEnv: () => {
        const settings = appState.getPrefs().features.settings
        return {
          VENGEANCE_NATIVE_COMPACTION: settings?.nativeCompaction === false ? 'off' : 'on',
          [SPEED_DEFAULT_ENV]: settings?.speedDefault ?? 'standard'
        }
      },
      offeredModel: accountModelFilter
    }
  )

  const cancelOrphanShutdown = (): void => {
    if (orphanShutdown) clearTimeout(orphanShutdown)
    orphanShutdown = null
  }

  /**
   * A crashed renderer is reloaded (with backoff in a crash loop) while its engines keep running, so a run in
   * progress is not lost: the reloaded window adopts them, or they stop after a grace period. The new renderer shows
   * a one-time notice.
   */
  const recoverRenderer = (window: BrowserWindow, details: RenderProcessGoneDetails): void => {
    cancelOrphanShutdown()
    if (details.reason === 'clean-exit' || quitting) {
      void manager.disposeAll()
      return
    }
    const now = Date.now()
    crashStreak = now - lastCrashAt < CRASH_STREAK_RESET_MS ? crashStreak + 1 : 0
    lastCrashAt = now
    const delay = RECOVERY_BACKOFF_MS[Math.min(crashStreak, RECOVERY_BACKOFF_MS.length - 1)]
    console.error(
      `[vengeance] renderer gone (${details.reason}, exit code ${details.exitCode}); reloading in ${delay} ms`
    )
    setTimeout(() => {
      if (window.isDestroyed() || quitting) return
      recoveryNoticePending = true
      orphanShutdown = setTimeout(() => {
        orphanShutdown = null
        void manager.disposeAll()
      }, ORPHAN_ENGINE_GRACE_MS)
      window.webContents.reload()
    }, delay)
  }

  /** Copy buttons need clipboard writes; everything else (camera, notifications, geolocation…) is denied. */
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

  app.on('second-instance', (_event, argv) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const folder = folderFromArgv(argv)
    if (folder) broadcast('app:open-folder', { path: folder })
  })

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission))
    )
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    )
    registerIpc({ manager, engineOverridePath })
    handle('app:take-recovery-notice', () => {
      const pending = recoveryNoticePending
      recoveryNoticePending = false
      return pending
    })
    handle('engine:adopt', () => {
      if (!orphanShutdown) return []
      cancelOrphanShutdown()
      return manager.list().map(maskAgentInfo)
    })
    handle('win:set-theme-preference', (preference) => setThemePreference(preference))
    mainWindow = createMainWindow(app.getVersion())
    const window = mainWindow
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    // A reloaded renderer forgets its agents; never leave their engines running headless. The reload after a
    // renderer crash is the exception: its engines wait for adoption (recoverRenderer).
    const contents = mainWindow.webContents
    let loaded = false
    contents.on('did-finish-load', () => {
      loaded = true
    })
    contents.on('did-start-loading', () => {
      if (loaded && !orphanShutdown) void manager.disposeAll()
    })
    contents.on('render-process-gone', (_event, details) => recoverRenderer(window, details))
    const folder = folderFromArgv(process.argv)
    if (folder)
      mainWindow.webContents.once('did-finish-load', () =>
        broadcast('app:open-folder', { path: folder })
      )
  })

  app.on('before-quit', (event) => {
    // Never throw while quitting: an uncaught error here shows Electron's native error dialog.
    try {
      // The window's own bounds save is debounced; a quit right after a move or resize must not lose it.
      if (mainWindow) saveWindowBounds(mainWindow)
      appState.flush()
    } catch (error) {
      console.error('[vengeance] could not persist app state on quit:', error)
    }
    if (quitting) return
    // Orderly engine shutdown: close each pi's stdin, kill stragglers after the grace period.
    event.preventDefault()
    quitting = true
    void manager.disposeAll().finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
