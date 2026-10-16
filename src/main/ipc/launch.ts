import type { IpcContext } from './context'
import { handle } from './handle'
import { appState } from '../app-state'
import { revealWorkspaceEnv } from '../features/launch/env-vault'
import { discoverExtensionFlags } from '../features/launch/flags'
import { setProjectTrust, trustPreflight } from '../features/launch/trust'
import { isEngineId } from '@shared/api/engine'
import type { TrustPreflight } from '@shared/api/launch'
import { primeEngineInfo } from '../engine/prime/locate'

function primeTrustPreflight(cwd: string): TrustPreflight {
  return {
    cwd,
    requiresTrust: false,
    resources: [],
    saved: null,
    savedPath: null,
    defaultTrust: 'always',
    engineDefault: true,
    needsDecision: false
  }
}

/** Launch options + project trust: trust preflight/decisions, extension-flag discovery, env reveal. */
export function registerLaunchIpc(context: IpcContext): void {
  handle('engine:trust-preflight', (engine, cwd) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    return engine === 'pi'
      ? trustPreflight(context.engineOverridePath('pi'), cwd)
      : primeTrustPreflight(cwd)
  })
  handle('engine:set-trust', (engine, cwd, decision) => {
    if (engine !== 'pi') throw new Error('This engine does not use project trust decisions')
    return setProjectTrust(context.engineOverridePath('pi'), cwd, decision)
  })
  handle('engine:extension-flags', async (engine, request) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (engine === 'pi') return discoverExtensionFlags(context.engineOverridePath('pi'), request)
    const details = await primeEngineInfo(context.engineOverridePath('prime'))
    return {
      flags: [],
      builtinTools: [],
      engineVersion: details.version ?? '',
      trusted: true,
      fetchedAt: Date.now()
    }
  })
  handle('engine:reveal-env', (engine, cwd, key) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    return revealWorkspaceEnv(appState.getPrefs(), cwd, key, engine)
  })
  handle('launch:trust-preflight', (cwd) => trustPreflight(context.engineOverridePath(), cwd))
  handle('launch:set-trust', (cwd, decision) =>
    setProjectTrust(context.engineOverridePath(), cwd, decision)
  )
  handle('launch:extension-flags', (request) =>
    discoverExtensionFlags(context.engineOverridePath(), request)
  )
  handle('launch:reveal-env', (cwd, key) => revealWorkspaceEnv(appState.getPrefs(), cwd, key))
}
