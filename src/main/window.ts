import { BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { release } from 'node:os'
import { join } from 'node:path'
import type { PlatformInfo, ThemePref } from '@shared/api/app'
import type { WindowTheme } from '@shared/api/system'
import icon from '../../resources/icon.png?asset'
import { appState, type WindowBounds } from './app-state'
import { env } from './env'
import { broadcast } from './ipc/handle'

export const TITLEBAR_HEIGHT = 40
/** Windows 11 caption buttons (min/max/close) are 46px each at 100% scale. */
const CAPTION_BUTTONS_WIDTH = 138

const THEME_COLORS: Record<WindowTheme, { background: string; symbols: string; overlay: string }> = {
  dark: { background: '#0B0B0E', symbols: '#C9C9D3', overlay: '#00000000' },
  light: { background: '#F4F2EE', symbols: '#3A3A44', overlay: '#00000000' }
}

/** Mica needs Windows 11 22H2 (build 22621) or newer. */
function micaSupported(): boolean {
  if (process.platform !== 'win32' || env.noMica) return false
  const build = Number(release().split('.')[2] ?? 0)
  return build >= 22621
}

function visibleBounds(saved: WindowBounds | undefined): WindowBounds {
  const fallback: WindowBounds = { width: 1440, height: 900, maximized: false }
  if (!saved || saved.x === undefined || saved.y === undefined) return { ...fallback, ...(saved ? { width: saved.width, height: saved.height, maximized: saved.maximized } : {}) }
  const onScreen = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(saved.x! + saved.width, workArea.x + workArea.width) - Math.max(saved.x!, workArea.x)
    const overlapY = Math.min(saved.y! + saved.height, workArea.y + workArea.height) - Math.max(saved.y!, workArea.y)
    return overlapX > 120 && overlapY > 80
  })
  return onScreen ? saved : { ...fallback, width: saved.width, height: saved.height, maximized: saved.maximized }
}

export function platformInfo(material: PlatformInfo['material'], appVersion: string): PlatformInfo {
  return {
    os: process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux',
    arch: process.arch,
    appVersion,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    mock: env.mock,
    test: env.test,
    material,
    captionButtonsWidth: process.platform === 'darwin' ? 0 : CAPTION_BUTTONS_WIDTH,
    titlebarHeight: TITLEBAR_HEIGHT
  }
}

/**
 * The "System" theme keeps nativeTheme on 'system' so later Windows theme changes still reach the renderer
 * (prefers-color-scheme) and Mica; an explicit theme pins it, so Mica matches Bone on a dark Windows too.
 * Set from the saved prefs at startup, then by the renderer (`win:set-theme-preference`) the moment it changes:
 * the prefs write is debounced and would arrive after the renderer's `win:set-theme`.
 */
let themePreference: ThemePref = 'dark'

export function setThemePreference(preference: ThemePref): void {
  themePreference = preference
  nativeTheme.themeSource = preference
}

function applyNativeThemeSource(theme: WindowTheme): void {
  nativeTheme.themeSource = themePreference === 'system' ? 'system' : theme
}

/** The theme the window opens in, resolved before the renderer loads so the first frame never flashes. */
function startupTheme(): WindowTheme {
  if (themePreference === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return themePreference === 'light' ? 'light' : 'dark'
}

/** Persist the window's normal bounds and maximized state right away. */
export function saveWindowBounds(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  appState.setWindowBounds({ ...window.getNormalBounds(), maximized: window.isMaximized() })
}

export function createMainWindow(appVersion: string): BrowserWindow {
  const mica = micaSupported()
  const bounds = visibleBounds(appState.getWindowBounds())
  setThemePreference(appState.getPrefs().theme)
  const theme = startupTheme()
  const colors = THEME_COLORS[theme]
  const platform = platformInfo(mica ? 'mica' : 'solid', appVersion)

  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Vengeance',
    icon,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.overlay, symbolColor: colors.symbols, height: TITLEBAR_HEIGHT },
    backgroundColor: mica ? '#00000000' : colors.background,
    ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Developer tools only in `npm run dev` (N12).
      devTools: !!env.rendererUrl,
      additionalArguments: [`--vengeance-platform=${encodeURIComponent(JSON.stringify(platform))}`]
    }
  })

  if (bounds.maximized) window.maximize()
  window.once('ready-to-show', () => window.show())

  let saveTimer: NodeJS.Timeout | null = null
  const saveBoundsSoon = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowBounds(window), 400)
  }
  window.on('resize', saveBoundsSoon)
  window.on('move', saveBoundsSoon)
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowBounds(window)
  })
  window.on('maximize', () => broadcast('win:maximized-changed', { maximized: true }))
  window.on('unmaximize', () => broadcast('win:maximized-changed', { maximized: false }))
  window.on('focus', () => broadcast('win:focus-changed', { focused: true }))
  window.on('blur', () => broadcast('win:focus-changed', { focused: false }))

  // Desktop app: never navigate the main frame; open web links in the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (env.rendererUrl) void window.loadURL(env.rendererUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  return window
}

/** Match native caption buttons and the window background to the renderer theme. */
export function applyWindowTheme(window: BrowserWindow, theme: WindowTheme): void {
  const colors = THEME_COLORS[theme]
  applyNativeThemeSource(theme)
  if (process.platform !== 'darwin') {
    window.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbols, height: TITLEBAR_HEIGHT })
  }
  if (!micaSupported()) window.setBackgroundColor(colors.background)
}
