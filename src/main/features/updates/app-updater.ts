import { app } from 'electron'
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

/** A feed was baked into this build by electron-builder. */
function hasBakedFeed(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/** The Linux package type electron-builder records in `resources/package-type` (deb, rpm, pacman). */
function linuxPackageType(): AppUpdateInfo['packageType'] {
  if (process.platform !== 'linux' || !app.isPackaged) return undefined
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

let updater: AppUpdater | null = null
let configuredFeed: string | null = null
/** Released for the AppImage that replaces this one (install); taken back if the install fails. */
let singleInstanceLockReleased = false

export class AppUpdates {
  info: AppUpdateInfo = {
    status: 'disabled',
    current: app.getVersion(),
    message: 'No update feed configured.',
    installMode: INSTALL_MODE,
    packageType: linuxPackageType()
  }

  constructor(private readonly onChange: () => void) {}

  private set(patch: Partial<AppUpdateInfo>): void {
    const info = { ...this.info, ...patch }
    this.info = { ...info, releaseUrl: info.latest ? `${RELEASE_PAGE}${info.latest}` : undefined }
    this.onChange()
  }

  private async load(feed: Feed, autoDownload: boolean): Promise<AppUpdater | null> {
    if (!updater) {
      updater = (await import('electron-updater')).autoUpdater
      updater.logger = null
      updater.on('checking-for-update', () => this.set({ status: 'checking', message: undefined }))
      updater.on('update-available', (info) => this.set({ status: 'available', latest: info.version }))
      updater.on('update-not-available', () => this.set({ status: 'idle', latest: undefined }))
      updater.on('download-progress', (progress) => this.set({ status: 'downloading', progress: Math.round(progress.percent) }))
      updater.on('update-downloaded', (info) => this.set({ status: 'ready', latest: info.version, progress: 100 }))
      updater.on('error', (error) => {
        if (singleInstanceLockReleased) singleInstanceLockReleased = !app.requestSingleInstanceLock()
        this.set({ status: 'error', message: error.message })
      })
    }
    updater.autoDownload = INSTALL_MODE === 'self' && autoDownload
    updater.autoInstallOnAppQuit = INSTALL_MODE === 'self'
    // Outside an AppImage (a tar.gz install) Linux's AppImageUpdater stays idle unless forced; it only checks then.
    updater.forceDevUpdateConfig = process.platform === 'linux' && INSTALL_MODE === 'manual'
    if (feed !== 'baked' && configuredFeed !== feed) {
      updater.setFeedURL({ provider: 'generic', url: feed })
      configuredFeed = feed
    }
    return updater
  }

  async check(feedUrl: string | undefined, autoDownload: boolean): Promise<void> {
    // After setFeedURL the updater no longer reads app-update.yml, so the baked feed only applies until then.
    const feed: Feed | undefined = feedUrl || (configuredFeed === null && hasBakedFeed() ? 'baked' : undefined)
    if (!feed) return this.set({ status: 'disabled', latest: undefined, message: 'No update feed configured.' })
    if (env.mock) return this.set({ status: 'idle', message: undefined })
    if (!app.isPackaged) return this.set({ status: 'disabled', message: 'Self-update is available in installed builds.' })
    try {
      const instance = await this.load(feed, autoDownload)
      await instance?.checkForUpdates()
    } catch (error) {
      this.set({ status: 'error', message: (error as Error).message })
    }
  }

  async download(): Promise<void> {
    if (!updater || this.info.status !== 'available' || INSTALL_MODE !== 'self') return
    this.set({ status: 'downloading', progress: 0 })
    await updater.downloadUpdate()
  }

  install(): void {
    if (!updater || this.info.status !== 'ready') return
    // The new AppImage starts while this one is still quitting, and must not find the lock taken.
    if (process.env.APPIMAGE && app.hasSingleInstanceLock()) {
      app.releaseSingleInstanceLock()
      singleInstanceLockReleased = true
    }
    updater.quitAndInstall()
  }
}
