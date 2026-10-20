import { useEffect, useState } from 'react'
import type { EngineId } from '@shared/api/engine'
import type { ProviderInfo } from '@shared/api/settings'
import { on } from '../../lib/ipc'
import { useApp } from '../../store/app'
import { settingsInvokeForFolder } from '../settings/ipc'
import { useSettings } from '../settings/store'

/** The Engine's providers from the latest catalog a picker read for itself. */
let lastEngineProviders: ProviderInfo[] | undefined

/** The settings catalog's providers for picker headings, loading the catalog once when a picker first needs it. */
export function useCatalogProviders(
  engine?: EngineId,
  cwd?: string | null
): ProviderInfo[] | undefined {
  const selectedEngine = useSettings((state) => state.engine)
  const requestedEngine = engine ?? selectedEngine
  const activeFolder = useApp((state) => state.prefs.activeWorkspace)
  const requestedFolder = cwd === undefined ? activeFolder : cwd
  const providers = useSettings((state) =>
    cwd === undefined && state.engine === requestedEngine ? state.catalog?.providers : undefined
  )
  const [catalog, setCatalog] = useState<{
    engine: EngineId
    cwd: string | null
    providers: ProviderInfo[]
  } | null>(null)
  useEffect(() => {
    if (providers) return
    let alive = true
    const load = () => {
      void settingsInvokeForFolder(requestedEngine, requestedFolder, 'settings:catalog')
        .then((result) => {
          if (requestedEngine === 'pi') lastEngineProviders = result.providers
          if (alive)
            setCatalog({
              engine: requestedEngine,
              cwd: requestedFolder,
              providers: result.providers
            })
        })
        .catch(() => undefined)
    }
    load()
    const unsubscribe = on('settings:changed', (event) => {
      if (
        (event.engine ?? 'pi') === requestedEngine &&
        (event.area === 'auth' || event.area === 'models')
      )
        load()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [requestedEngine, requestedFolder, providers])
  return (
    providers ??
    (catalog?.engine === requestedEngine && catalog.cwd === requestedFolder
      ? catalog.providers
      : undefined)
  )
}

/**
 * The Engine's providers as far as the app already read them, for code outside React: the Settings store's catalog
 * when it holds the Engine's, else the latest one a picker read. Undefined before either was read.
 */
export function knownEngineProviders(): ProviderInfo[] | undefined {
  const state = useSettings.getState()
  return state.engine === 'pi' && state.catalog ? state.catalog.providers : lastEngineProviders
}
