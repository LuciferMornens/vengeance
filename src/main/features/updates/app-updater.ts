import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppInstallMode, AppUpdateInfo } from '@shared/api/updates'
import { env } from '../../env'

/**
 * Vengeance self-update through electron-updater's generic provider. Disabled unless the app is packaged
 * and has a feed: the URL from Settings → General, else the one baked in at build time
 * (`VENGEANCE_UPDATE_FEED` → `resources/app-update.yml`, see scripts/dist.mjs). Builds that cannot replace
 * themselves only check (installMode).
 */

const RELEASE_PAGE = 'https://github.com/LuciferMornens/vengeance/releases/tag/v'

/**
 * The Windows installer and a Linux AppImage (the AppImage runtime sets APPIMAGE) replace themselves. macOS builds
 * carry no Developer ID signature, which Squirrel.Mac requires, and a deb, rpm or pacman install belongs to the
 * system's package manager, as a tar.gz install does to the user.
 */
const INSTALL_MODE: AppInstallMode =
  process.platform === 'win32' || (process.platform === 'linux' && !!process.env.APPIMAGE) ? 'self' : 'manual'

export interface AppUpdaterHost {
  readonly isPackaged: boolean
  getVersion(): string
  hasSingleInstanceLock(): boolean
  releaseSingleInstanceLock(): void
  requestSingleInstanceLock(): boolean
}

/** A feed was baked into this build by electron-builder. */
function hasBakedFeed(isPackaged: boolean): boolean {
  return (
    isPackaged &&
    typeof process.resourcesPath === 'string' &&
    existsSync(join(process.resourcesPath, 'app-update.yml'))
  )
}

/** The Linux package type electron-builder records in `resources/package-type` (deb, rpm, pacman). */
function linuxPackageType(isPackaged: boolean): AppUpdateInfo['packageType'] {
  if (process.platform !== 'linux' || !isPackaged || typeof process.resourcesPath !== 'string')
    return undefined
  try {
    const type = readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim()
    return type === 'deb' || type === 'rpm' || type === 'pacman' ? type : undefined
  } catch {
    return undefined
  }
}

/** Feed source: a configured URL, or `'baked'` for the build's app-update.yml. */
type Feed = string | 'baked'

type AppUpdater = typeof import('electron-updater').autoUpdater
type ElectronUpdaterModule = {
  autoUpdater?: AppUpdater
  default?: { autoUpdater?: AppUpdater }
}

/**
 * electron-updater is a CommonJS package that defines `exports.autoUpdater` with a lazy getter
 * `cjs-module-lexer` cannot see statically, so Node's native `import('electron-updater')` exposes it
 * only on `default` while CJS/bundled imports expose it on the namespace.
 */
export function resolveAutoUpdater(mod: ElectronUpdaterModule): AppUpdater {
  const instance = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!instance) throw new Error('electron-updater did not export autoUpdater.')
  return instance
}

export class AppUpdates {
  info: AppUpdateInfo

  private updater: AppUpdater | null = null
  private loadingUpdater: Promise<AppUpdater> | null = null
  private configuredFeed: string | null = null
  /** Released for the AppImage that replaces this one (install); taken back if the install fails. */
  private singleInstanceLockReleased = false

  constructor(
    private readonly host: AppUpdaterHost,
    private readonly onChange: () => void,
    private readonly loadUpdater: () => Promise<AppUpdater> = async () =>
      resolveAutoUpdater(await import('electron-updater'))
  ) {
    this.info = {
      status: 'disabled',
      current: this.host.getVersion(),
      message: 'No update feed configured.',
      installMode: INSTALL_MODE,
      packageType: linuxPackageType(this.host.isPackaged)
    }
  }

  private set(patch: Partial<AppUpdateInfo>): void {
    const info = { ...this.info, ...patch }
    this.info = { ...info, releaseUrl: info.latest ? `${RELEASE_PAGE}${info.latest}` : undefined }
    this.onChange()
  }

  private async load(feed: Feed, autoDownload: boolean): Promise<AppUpdater> {
    // One shared load, so concurrent checks register the listeners once; a failed load is retried.
    this.loadingUpdater ??= this.loadUpdater()
      .then((instance) => {
        instance.logger = null
        instance.on('checking-for-update', () =>
          this.set({ status: 'checking', message: undefined })
        )
        instance.on('update-available', (info) =>
          this.set({ status: 'available', latest: info.version })
        )
        instance.on('update-not-available', () =>
          this.set({ status: 'idle', latest: undefined })
        )
        instance.on('download-progress', (progress) =>
          this.set({ status: 'downloading', progress: Math.round(progress.percent) })
        )
        instance.on('update-downloaded', (info) =>
          this.set({ status: 'ready', latest: info.version, progress: 100 })
        )
        instance.on('error', (error) => {
          if (this.singleInstanceLockReleased) {
            this.singleInstanceLockReleased = !this.host.requestSingleInstanceLock()
          }
          this.set({ status: 'error', message: error.message })
        })
        return instance
      })
      .catch((error: unknown) => {
        this.loadingUpdater = null
        throw error
      })
    const updater = (this.updater = await this.loadingUpdater)
    updater.autoDownload = INSTALL_MODE === 'self' && autoDownload
    updater.autoInstallOnAppQuit = INSTALL_MODE === 'self'
    // Outside an AppImage (a tar.gz install) Linux's AppImageUpdater stays idle unless forced; it only checks then.
    updater.forceDevUpdateConfig = process.platform === 'linux' && INSTALL_MODE === 'manual'
    if (feed !== 'baked' && this.configuredFeed !== feed) {
      updater.setFeedURL({ provider: 'generic', url: feed })
      this.configuredFeed = feed
    }
    return updater
  }

  async check(feedUrl: string | undefined, autoDownload: boolean): Promise<void> {
    if (this.info.status === 'downloading' || this.info.status === 'ready') return
    // After setFeedURL the updater no longer reads app-update.yml, so the baked feed only applies until then.
    const feed: Feed | undefined =
      feedUrl || (this.configuredFeed === null && hasBakedFeed(this.host.isPackaged) ? 'baked' : undefined)
    if (!feed) {
      return this.set({
        status: 'disabled',
        latest: undefined,
        message: 'No update feed configured.'
      })
    }
    if (env.mock) return this.set({ status: 'idle', message: undefined })
    if (!this.host.isPackaged) {
      return this.set({
        status: 'disabled',
        message: 'Self-update is available in installed builds.'
      })
    }
    try {
      const instance = await this.load(feed, autoDownload)
      const result = await instance.checkForUpdates()
      result?.downloadPromise?.catch(() => undefined)
    } catch (error) {
      this.set({ status: 'error', message: (error as Error).message })
    }
  }

  async download(): Promise<void> {
    if (!this.updater || this.info.status !== 'available' || INSTALL_MODE !== 'self') return
    this.set({ status: 'downloading', progress: 0 })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.set({ status: 'error', message: (error as Error).message })
    }
  }

  install(): void {
    if (!this.updater || this.info.status !== 'ready') return
    // The new AppImage starts while this one is still quitting, and must not find the lock taken.
    if (process.env.APPIMAGE && this.host.hasSingleInstanceLock()) {
      this.host.releaseSingleInstanceLock()
      this.singleInstanceLockReleased = true
    }
    this.updater.quitAndInstall()
  }
}
