import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppUpdateInfo } from '@shared/api/updates'
import { env } from '../../env'

/**
 * Vengeance self-update through electron-updater's generic provider. Disabled unless the app is packaged
 * and has a feed: the URL from Settings → General, else the one baked in at build time
 * (`VENGEANCE_UPDATE_FEED` → `resources/app-update.yml`, see scripts/dist.mjs).
 */

/** A feed was baked into this build by electron-builder. */
function hasBakedFeed(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/** Feed source: a configured URL, or `'baked'` for the build's app-update.yml. */
type Feed = string | 'baked'

type AppUpdater = typeof import('electron-updater').autoUpdater

let updater: AppUpdater | null = null
let configuredFeed: string | null = null

export class AppUpdates {
  info: AppUpdateInfo = { status: 'disabled', current: app.getVersion(), message: 'No update feed configured.' }

  constructor(private readonly onChange: () => void) {}

  private set(patch: Partial<AppUpdateInfo>): void {
    this.info = { ...this.info, ...patch }
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
      updater.on('error', (error) => this.set({ status: 'error', message: error.message }))
    }
    updater.autoDownload = autoDownload
    updater.autoInstallOnAppQuit = true
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
    if (!updater || this.info.status !== 'available') return
    this.set({ status: 'downloading', progress: 0 })
    await updater.downloadUpdate()
  }

  install(): void {
    if (updater && this.info.status === 'ready') updater.quitAndInstall()
  }
}
