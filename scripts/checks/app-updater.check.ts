import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { AppUpdates, resolveAutoUpdater, type AppUpdaterHost } from '../../src/main/features/updates/app-updater'
import { check } from './harness'

class FakeUpdater extends EventEmitter {
  logger: unknown = console
  autoDownload = false
  autoInstallOnAppQuit = false
  forceDevUpdateConfig = false
  feeds: Array<{ provider: string; url: string }> = []
  checks = 0
  downloadError: Error | null = null
  setFeedURL(feed: { provider: string; url: string }): void {
    this.feeds.push(feed)
  }
  async checkForUpdates(): Promise<{ downloadPromise?: Promise<void> } | null> {
    this.checks++
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.3.1' })
    return { downloadPromise: Promise.reject(new Error('background download failed')) }
  }
  async downloadUpdate(): Promise<void> {
    if (this.downloadError) throw this.downloadError
    this.emit('download-progress', { percent: 47.6 })
    this.emit('update-downloaded', { version: '0.3.1' })
  }
  quitAndInstall(): void {}
}

const host: AppUpdaterHost = {
  isPackaged: true,
  getVersion: () => '0.3.0',
  hasSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},
  requestSingleInstanceLock: () => true
}

/** Node's native import('electron-updater') exposes the lazy CJS getter only under `default`. */
function nativeNamespace(fake: FakeUpdater): Parameters<typeof resolveAutoUpdater>[0] {
  const cjsExports = {}
  Object.defineProperty(cjsExports, 'autoUpdater', { enumerable: true, get: () => fake })
  return { default: cjsExports }
}

function appUpdates(fake: FakeUpdater, onLoad = () => {}): AppUpdates {
  return new AppUpdates(host, () => {}, async () => {
    onLoad()
    return resolveAutoUpdater(nativeNamespace(fake))
  })
}

await check('app-updater: the installed electron-updater exposes autoUpdater where the resolver looks', async () => {
  // A non-literal specifier keeps esbuild from bundling it, so this is Node's own CJS interop.
  const specifier = 'electron-updater'
  const mod = (await import(specifier)) as { default?: object }
  // `in` reads no getter, so the updater (which needs Electron) is not constructed.
  assert.ok('autoUpdater' in mod || 'autoUpdater' in (mod.default ?? {}))
})

await check('app-updater: resolves autoUpdater from the namespace or the CJS default export', () => {
  const fake = new FakeUpdater()
  const namespace = nativeNamespace(fake)
  assert.equal((namespace as { autoUpdater?: unknown }).autoUpdater, undefined)
  assert.equal(resolveAutoUpdater(namespace), fake as unknown)
  assert.equal(resolveAutoUpdater({ autoUpdater: fake as never }), fake as unknown)
  assert.throws(() => resolveAutoUpdater({}), /did not export autoUpdater/)
})

await check('app-updater: concurrent checks load and configure the updater once', async () => {
  const fake = new FakeUpdater()
  let loads = 0
  const updates = appUpdates(fake, () => loads++)
  await Promise.all([
    updates.check('https://updates.example/feed', true),
    updates.check('https://updates.example/feed', true)
  ])
  assert.equal(loads, 1)
  assert.equal(fake.logger, null)
  assert.equal(fake.listenerCount('checking-for-update'), 1)
  assert.deepEqual(fake.feeds, [{ provider: 'generic', url: 'https://updates.example/feed' }])
  assert.equal(updates.info.status, 'available')
  assert.equal(updates.info.latest, '0.3.1')
  assert.equal(updates.info.releaseUrl, 'https://github.com/LuciferMornens/vengeance/releases/tag/v0.3.1')
})

await check('app-updater: a downloaded update is not checked again', async () => {
  const fake = new FakeUpdater()
  const updates = appUpdates(fake)
  await updates.check('https://updates.example/feed', false)
  fake.emit('update-downloaded', { version: '0.3.1' })
  await updates.check('https://updates.example/feed', false)
  assert.equal(fake.checks, 1)
  assert.equal(updates.info.status, 'ready')
})

await check('app-updater: a failed download shows the error', async () => {
  const fake = new FakeUpdater()
  const updates = appUpdates(fake)
  await updates.check('https://updates.example/feed', false)
  fake.downloadError = new Error('download failed')
  await updates.download()
  // Only Windows and AppImage builds download in the app; the others keep the release-page link.
  if (updates.info.installMode === 'self') {
    assert.equal(updates.info.status, 'error')
    assert.equal(updates.info.message, 'download failed')
  } else {
    assert.equal(updates.info.status, 'available')
  }
})
