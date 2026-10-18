import type {
  EngineSettingsRequest,
  EngineSettingsResult,
  SettingsChangeArea,
  SettingsChannel,
  SettingsEventMap
} from '@shared/api/settings'
import {
  cancelPrimeLogin,
  checkPrimeAuth,
  logoutPrimeProvider,
  primeModelCatalog,
  readPrimeModels,
  respondPrimeLogin,
  startPrimeLogin,
  validatePrimeModels,
  writePrimeModels
} from './auth'
import { cancelPrimeRun } from './configuration-cli'
import { primeDefaultSystemPrompt } from './system-prompt'
import {
  openPrimePath,
  primeContextOverview,
  primeKeybindings,
  primeLogTail,
  primeSettingsSnapshot,
  readPrimeInstruction,
  setPrimeSetting,
  validatePrimeSettings,
  writePrimeInstruction,
  writePrimeKeybindings,
  writePrimeSettings
} from './configuration-context'
import {
  primeMcpAuth,
  primeMcpOverview,
  primeMcpServer,
  primeMcpStatus,
  removePrimeMcpServer,
  savePrimeMcpServer,
  updatePrimeMcpServer
} from './mcp'
import {
  listPrimePackages,
  listPrimeResources,
  runPrimePackageAction,
  setPrimePackageEnabled,
  togglePrimeResource
} from './resources'

export interface PrimeSettingsContext {
  overridePath?: string | null
  cwd?: string | null
  nativeCommand?: (
    type: string,
    payload?: Record<string, unknown>,
    cwd?: string | null
  ) => Promise<Record<string, unknown>>
  broadcast?: <Channel extends keyof SettingsEventMap>(
    channel: Channel,
    payload: SettingsEventMap[Channel]
  ) => void
}

export function invokePrimeSettings<Channel extends SettingsChannel>(
  request: EngineSettingsRequest<Channel>,
  context: PrimeSettingsContext = {}
): Promise<EngineSettingsResult<Channel>> {
  // The discriminated dispatcher enforces the channel's argument and result pairing below.
  return dispatchPrimeSettings(request as unknown as EngineSettingsRequest, context) as Promise<
    EngineSettingsResult<Channel>
  >
}

async function changedProject(request: EngineSettingsRequest): Promise<string | null> {
  switch (request.channel) {
    case 'settings:set':
    case 'settings:write-raw':
    case 'settings:mcp-save':
      return request.args[0].scope === 'project' ? request.args[0].cwd : null
    case 'settings:package-enable':
      return request.args[1].scope === 'project' ? request.args[0] : null
    case 'settings:resource-toggle':
      return request.args[0].item.scope === 'project' ? request.args[0].cwd : null
    case 'settings:mcp-remove':
      return request.args[2] ? request.args[0] : null
    case 'settings:mcp-update': {
      const [cwd, name, patch] = request.args
      if (patch.projectOverride) return cwd
      const server = (await primeMcpOverview(cwd)).servers.find((entry) => entry.name === name)
      return server?.scope === 'project' ? cwd : null
    }
    case 'settings:instruction-file-write':
      return request.args[1].scope === 'project' ? request.args[0] : null
    default:
      return null
  }
}

async function dispatchPrimeSettings(
  request: EngineSettingsRequest,
  context: PrimeSettingsContext = {}
): Promise<unknown> {
  if (request.engine !== 'prime')
    throw new Error('This settings request targets a different engine.')
  const changed = async <Result>(
    area: SettingsChangeArea,
    operation: () => Promise<Result>
  ): Promise<Result> => {
    const cwd = await changedProject(request)
    const result = await operation()
    context.broadcast?.('settings:changed', {
      area,
      ...(request.channel === 'settings:instruction-file-write' ? { apply: 'new-sessions' } : {}),
      ...(cwd ? { project: { cwd, trusted: true } } : {})
    })
    return result
  }

  switch (request.channel) {
    case 'settings:snapshot':
      return primeSettingsSnapshot(...request.args)
    case 'settings:prewarm':
    case 'settings:release':
      return
    case 'settings:set':
      return changed('settings', () => setPrimeSetting(...request.args, context.overridePath))
    case 'settings:validate':
      return validatePrimeSettings(request.args[0])
    case 'settings:write-raw':
      return changed('settings', () => writePrimeSettings(...request.args, context.overridePath))
    case 'settings:set-trust':
    case 'settings:trust-entry':
      throw new Error('Engine 2 does not expose per-project trust decisions.')
    case 'settings:trust-list':
      return []
    case 'settings:catalog':
    case 'settings:extension-providers':
      return primeModelCatalog(context)
    case 'settings:auth-login':
      return startPrimeLogin(request.args[0], context)
    case 'settings:auth-respond':
      return respondPrimeLogin(...request.args)
    case 'settings:auth-cancel':
      return cancelPrimeLogin(...request.args)
    case 'settings:auth-logout':
      await changed('auth', () => logoutPrimeProvider(...request.args))
      return primeModelCatalog(context)
    case 'settings:auth-check':
      return checkPrimeAuth(request.args[0], context)
    case 'settings:models-json':
      return readPrimeModels()
    case 'settings:models-json-validate':
      return validatePrimeModels(...request.args)
    case 'settings:models-json-write':
      return changed('models', () => writePrimeModels(...request.args))
    case 'settings:packages':
      return listPrimePackages(request.args[0], context)
    case 'settings:package-run':
      return runPrimePackageAction(request.args[0], context)
    case 'settings:package-enable':
      return changed('packages', () => setPrimePackageEnabled(...request.args, context))
    case 'settings:resources':
      return listPrimeResources(request.args[0], context)
    case 'settings:resource-toggle':
      return changed('resources', () => togglePrimeResource(request.args[0], context))
    case 'settings:themes': {
      const groups = await listPrimeResources(request.args[0], context)
      return [
        ...new Set(
          groups
            .flatMap((group) => group.items)
            .filter((item) => item.type === 'themes' && item.enabled)
            .map((item) => item.displayName)
        )
      ].sort()
    }
    case 'settings:mcp':
      return primeMcpOverview(...request.args)
    case 'settings:mcp-status':
      return primeMcpStatus(request.args[0], context)
    case 'settings:mcp-server':
      return primeMcpServer(...request.args)
    case 'settings:mcp-save':
      return changed('mcp', () => savePrimeMcpServer(...request.args))
    case 'settings:mcp-remove':
      return changed('mcp', () => removePrimeMcpServer(...request.args))
    case 'settings:mcp-update':
      return changed('mcp', () => updatePrimeMcpServer(...request.args))
    case 'settings:mcp-codemode':
      throw new Error('Engine 2 manages MCP tool availability through each server’s tool filters.')
    case 'settings:mcp-log':
      return primeLogTail(...request.args)
    case 'settings:mcp-auth':
      return primeMcpAuth(...request.args, context)
    case 'settings:context':
      return primeContextOverview(...request.args)
    case 'settings:system-prompt-default':
      return primeDefaultSystemPrompt()
    case 'settings:instruction-file':
      return readPrimeInstruction(...request.args)
    case 'settings:instruction-file-write':
      return changed('instructions', () => writePrimeInstruction(...request.args))
    case 'settings:keybindings':
      return primeKeybindings()
    case 'settings:keybindings-write':
      return changed('keybindings', () => writePrimeKeybindings(...request.args))
    case 'settings:open-path':
      return openPrimePath(request.args[0], context.cwd)
    case 'settings:cancel-run':
      return cancelPrimeRun(...request.args)
  }
}
