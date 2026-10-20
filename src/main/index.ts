import { app, BrowserWindow, Menu, session, type RenderProcessGoneDetails } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPEED_DEFAULT_ENV } from '@shared/api/speed'
import { appState, engineOverridePath } from './app-state'
import { bridgeExtensionPath } from './engine/bridge'
import { EngineManager } from './engine/manager'
import { env } from './env'
import { maskAgentInfo } from './features/launch/env-vault'
import { trustPreflight } from './features/launch/trust'
import {
  ConversationPromptStore,
  piConversationPromptSources
} from './features/sessions/conversation-prompts'
import { accountModelFilter } from './features/settings/account-models'
import { prepareAgentDir, spawnAgentDir } from './features/settings/agent-dir'
import { broadcast, handle } from './ipc/handle'
import { registerIpc } from './ipc'
import { physicalPath } from './paths'
import { resolveShellEnvironment } from './shell-env'
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
/**
 * The macOS menu bar: the standard app, Edit and Window menus. Edit carries the system editing shortcuts (Cmd+C, Cmd+V,
 * Cmd+Z…), which macOS text fields only get from a menu; nothing reloads, opens developer tools or closes the window.
 */
function macApplicationMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ])
}

// N12: outside `npm run dev` no menu carries Electron's default accelerators (Ctrl+R reload, which would dispose
// every engine; Ctrl+Shift+I devtools; Ctrl+W close): Windows and Linux get none, macOS the one above. Dev keeps the
// default menu.
if (!env.rendererUrl)
  Menu.setApplicationMenu(process.platform === 'darwin' ? macApplicationMenu() : null)
if (process.platform === 'darwin') {
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion() })
}

// Chromium picks the Linux secret store by desktop: libsecret on GNOME and its relatives, KWallet on KDE, and plain
// text anywhere else. Other sessions (Hyprland, sway, MATE…) usually run a Secret Service such as gnome-keyring or
// KeePassXC, so they ask libsecret; `--password-store` on the command line still decides.
const SECRET_STORE_DESKTOP = /gnome|unity|cinnamon|xfce|kde|pantheon|ukui|deepin/i
if (
  process.platform === 'linux' &&
  !app.commandLine.hasSwitch('password-store') &&
  !SECRET_STORE_DESKTOP.test(
    process.env.ORIGINAL_XDG_CURRENT_DESKTOP ?? process.env.XDG_CURRENT_DESKTOP ?? ''
  )
) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}
// Under Wayland, input methods (fcitx5, IBus) reach Chromium only through the compositor's text-input protocol, and
// version 3 is the one GNOME, KDE, Hyprland and sway all offer. X11 sessions ignore both switches; a command line that
// already enables the IME keeps its own choice.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('enable-wayland-ime')) {
  app.commandLine.appendSwitch('enable-wayland-ime')
  app.commandLine.appendSwitch('wayland-text-input-version', '3')
}

/**
 * `arg` names an existing folder (a path, or a file:// URL as Linux launchers pass) other than the app itself; a linked
 * folder opens as its target, which is the workspace pi records for it (paths.ts physicalPath). A relative path is
 * relative to `cwd`, the folder the command ran in.
 */
function folderFromArgument(arg: string, cwd = process.cwd()): string | null {
  try {
    const candidate = resolve(cwd, arg.startsWith('file://') ? fileURLToPath(arg) : arg)
    if (
      existsSync(candidate) &&
      statSync(candidate).isDirectory() &&
      candidate !== resolve(app.getAppPath())
    )
      return physicalPath(candidate)
  } catch {
    // Not a path.
  }
  return null
}

/** A folder passed on the command line (e.g. `Vengeance.exe D:\project`). */
function folderFromArgv(argv: string[], cwd?: string): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    const folder = folderFromArgument(arg, cwd)
    if (folder) return folder
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
  // Read while the app starts: every child process waits for it on macOS and Linux (shell-env.ts).
  resolveShellEnvironment()
  let mainWindow: BrowserWindow | null = null
  /** The renderer finished loading once; later loads are reloads. */
  let rendererLoaded = false
  /** Folders to open once the renderer has loaded (command line, macOS `open-file`). */
  const pendingFolders: string[] = []
  let quitting = false
  let recoveryNoticePending = false
  let crashStreak = 0
  let lastCrashAt = 0
  /** Set while engines wait for the reloaded renderer to adopt them; firing stops them. */
  let orphanShutdown: NodeJS.Timeout | null = null

  const openFolder = (folder: string): void => {
    if (rendererLoaded) broadcast('app:open-folder', { path: folder })
    else pendingFolders.push(folder)
  }

  // Finder and the Dock hand over folders dropped on the app; the first may arrive before the app is ready.
  app.on('open-file', (event, path) => {
    event.preventDefault()
    const folder = folderFromArgument(path)
    if (!folder) return
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
    openFolder(folder)
  })

  const conversationPrompts = new ConversationPromptStore(app.getPath('userData'))
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
      offeredModel: accountModelFilter,
      piPromptSources: (args) => {
        // The spawn finds APPEND_SYSTEM.md and project trust in the agent dir its launch env names.
        // Without the Engine's trust store, only the global APPEND_SYSTEM.md is certain to load.
        const dir = spawnAgentDir(args.cwd, args.launch?.env)
        return piConversationPromptSources(conversationPrompts, args, dir, (cwd) =>
          trustPreflight(engineOverridePath('pi'), cwd, dir).then(
            (trust) => trust.engineDefault,
            () => false
          )
        )
      }
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

  // A second launch hands over its command line, which names folders relative to where it ran.
  app.on('second-instance', (_event, argv, workingDirectory) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    const folder = folderFromArgv(argv, workingDirectory)
    if (folder) openFolder(folder)
  })

  void app.whenReady().then(async () => {
    if (env.mock) await prepareAgentDir()
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission))
    )
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission)
    )
    registerIpc({ manager, engineOverridePath, conversationPrompts })
    conversationPrompts
      .collectGarbage()
      .catch((error: unknown) =>
        console.error('[vengeance] unused conversation instructions could not be removed:', error)
      )
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
    contents.on('did-finish-load', () => {
      rendererLoaded = true
      for (const folder of pendingFolders.splice(0)) broadcast('app:open-folder', { path: folder })
    })
    contents.on('did-start-loading', () => {
      if (rendererLoaded && !orphanShutdown) void manager.disposeAll()
    })
    contents.on('render-process-gone', (_event, details) => recoverRenderer(window, details))
    const folder = folderFromArgv(process.argv)
    if (folder) pendingFolders.push(folder)
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
