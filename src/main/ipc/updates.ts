import type { IpcContext } from './context'
import { broadcast, handle, onQuit } from './handle'
import { cancelAllRuns } from '../features/settings/pi-cli'
import { UpdatesService, type UpdatesServiceHooks } from '../features/updates/updates-service'
import { PrimeUpdatesService } from '../features/updates/prime-updates'
import { appState } from '../app-state'
import type { EngineId } from '@shared/api/engine'

/** Updates feature: background checks, `pi update` runs, the engine changelog, Vengeance self-update. */
export function registerUpdatesIpc(context: IpcContext): void {
  const broadcastUpdate: UpdatesServiceHooks['broadcast'] = broadcast
  const service = new UpdatesService(context.manager, () => context.engineOverridePath(), {
    broadcast(channel, payload) {
      broadcastUpdate(channel, payload)
      if (channel === 'updates:state') broadcast('updates:state', prime.getState())
    }
  })
  const prime = new PrimeUpdatesService(
    () => context.engineOverridePath('prime'),
    () => service.getState().app,
    { broadcast }
  )
  const selected = (engine?: EngineId) => {
    const prefs = appState.getPrefs()
    const backend =
      engine ??
      prefs.workspaces.find((workspace) => workspace.path === prefs.activeWorkspace)?.engine ??
      'pi'
    if (backend !== 'pi' && backend !== 'prime') throw new Error('Unknown engine.')
    return backend === 'prime' ? prime : service
  }
  service.start()
  prime.start()
  // D3: never leave `pi install|update` (or MCP sign-in) processes running after the app is gone.
  onQuit('before-quit', cancelAllRuns)
  onQuit('before-quit', () => prime.stop())
  onQuit('will-quit', () => service.stop())

  handle('updates:state', (engine) => {
    const checker = selected(engine)
    return checker.load()
  })
  handle('updates:check', async (engine) => {
    const checker = selected(engine)
    if (checker !== prime) return checker.check()
    await Promise.all([prime.check(), service.checkApp()])
    return prime.getState()
  })
  handle('updates:set-channel', (engine, channel) => {
    if (engine !== 'prime') throw new Error('Release channels are available for Engine 2.')
    return prime.setChannel(channel)
  })
  handle('updates:set-offline', (offline) => {
    service.setOffline(offline)
    return selected().getState()
  })
  handle('updates:run', (args) => selected(args.engine).run(args))
  handle('updates:changelog', (engine) => selected(engine).changelog())
  handle('updates:app-download', () => service.downloadApp())
  handle('updates:app-install', () => service.installApp())
}
