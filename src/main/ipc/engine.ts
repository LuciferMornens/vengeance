import { isAbsolute, resolve } from 'node:path'
import {
  isEngineId,
  normalizeEngineId,
  type AgentInfo,
  type CreateAgentArgs,
  type EngineId,
  type EngineLocationInfo
} from '@shared/api/engine'
import { appState, engineOverridePath } from '../app-state'
import { env } from '../env'
import { locateEngine } from '../engine/locate'
import type { EngineManager } from '../engine/manager'
import { piConfig } from '../features/settings/pi-modules'
import { engineBackends, PI_CAPABILITIES } from '../engine/backends'
import { invokePrimeSettings } from '../engine/prime/configuration'
import { getPrimeAgentDir, primeEngineInfo } from '../engine/prime/locate'
import { PrimeMockEngineProcess } from '../engine/prime/mock'
import { sanitizeNativeModels } from '../engine/prime/normalize'
import { asRecord } from '../engine/prime/transport'
import {
  listPrimeBackground,
  primeServiceCommand,
  stopPrimeBackground
} from '../engine/prime/daemon'
import { stopPrimeRuns } from '../engine/prime/configuration-cli'
import { disposePrimeAuth } from '../engine/prime/auth'
import { cancelAllPrimeTraces, cancelPrimeTraces, runPrimeTraces } from '../engine/prime/traces'
import type { EngineSettingsRequest, SettingsEventMap } from '@shared/api/settings'
import type { EventMap } from '@shared/ipc'
import { maskAgentInfo, resolveLaunchEnv } from '../features/launch/env-vault'
import { trustPreflight } from '../features/launch/trust'
import { PrimeConfigWatcher } from '../features/settings/prime-config-watcher'
import { samePath } from '../paths'
import { broadcast, handle, invokeRegistered, isRegisteredInvokeChannel, onQuit } from './handle'

function settingsWorkspace(request: EngineSettingsRequest, fallback: string | null): string | null {
  if (request.cwd !== undefined) return request.cwd
  switch (request.channel) {
    case 'settings:snapshot':
    case 'settings:packages':
    case 'settings:resources':
    case 'settings:themes':
    case 'settings:mcp':
    case 'settings:mcp-status':
    case 'settings:mcp-server':
    case 'settings:mcp-remove':
    case 'settings:mcp-update':
    case 'settings:mcp-auth':
    case 'settings:context':
    case 'settings:instruction-file':
    case 'settings:instruction-file-write':
    case 'settings:package-enable':
      return request.args[0]
    case 'settings:set':
    case 'settings:write-raw':
    case 'settings:package-run':
    case 'settings:resource-toggle':
    case 'settings:mcp-save':
      return request.args[0].cwd
    default:
      return fallback
  }
}

async function engineInfo(engine: EngineId = 'pi'): Promise<EngineLocationInfo> {
  const override = engineOverridePath(engine)
  if (engine === 'prime') return primeEngineInfo(override)
  try {
    const location = await locateEngine(override, true)
    let sdkVersion: string | undefined
    try {
      sdkVersion = (await piConfig(override)).VERSION
    } catch {
      sdkVersion = undefined
    }
    return {
      engine,
      capabilities: PI_CAPABILITIES,
      found: true,
      version: location.version,
      packageDir: location.packageDir,
      cliPath: location.cliPath,
      source: location.source,
      nodePath: location.node.path,
      nodeVersion: location.node.version,
      runtime: location.node.isElectron ? 'electron' : 'system-node',
      sdkVersion,
      mock: env.mock
    }
  } catch (error) {
    return {
      engine,
      capabilities: PI_CAPABILITIES,
      found: false,
      error: (error as Error).message,
      mock: env.mock
    }
  }
}

/** Real env values of running agents (to resolve masks the renderer sends back, e.g. when forking). */
function runningEnvs(manager: EngineManager, engine: EngineId): Array<Record<string, string>> {
  return manager
    .list()
    .flatMap((agent) =>
      agent.engine === engine && agent.args.launch?.env ? [agent.args.launch.env] : []
    )
}

/**
 * A pinned `--approve`/`--no-approve` answers the Trust dialog for a folder without a saved decision ("Not now",
 * "Trust once"). Once trust.json holds a decision for the folder, a restart follows that decision instead, whichever
 * view saved it.
 */
async function dropStaleTrustPin(
  agent: AgentInfo,
  patch: Partial<CreateAgentArgs> | undefined
): Promise<Partial<CreateAgentArgs> | undefined> {
  if (agent.engine === 'prime') return patch
  if (agent.args.approve === undefined || (patch && 'approve' in patch)) return patch
  try {
    const { saved } = await trustPreflight(appState.getPrefs().engineOverridePath, agent.cwd)
    return saved === null ? patch : { ...patch, approve: undefined }
  } catch {
    // Without the engine's trust store the pin is the best answer there is.
    return patch
  }
}

/** AgentInfo leaves main with launch env values masked (N17). */
export function registerEngineIpc(manager: EngineManager): void {
  const configWatcher = new PrimeConfigWatcher(
    (event) => broadcast('settings:changed', event),
    () => [
      appState.getPrefs().activeWorkspace,
      ...manager
        .list()
        .filter((agent) => agent.engine === 'prime')
        .map((agent) => agent.cwd)
    ]
  )
  configWatcher.start()
  const stopWorkspaceListener = appState.onPrefsChange((prefs, previous) => {
    if (prefs.activeWorkspace !== previous.activeWorkspace) configWatcher.sync()
  })
  onQuit('before-quit', () => {
    stopWorkspaceListener()
    configWatcher.stop()
    stopPrimeRuns()
    disposePrimeAuth()
    cancelAllPrimeTraces()
  })

  const nativeSettingsCommand = async (
    type: string,
    payload: Record<string, unknown> = {},
    cwd: string | null = null
  ): Promise<Record<string, unknown>> => {
    const running = manager
      .list()
      .find(
        (agent) =>
          agent.engine === 'prime' && agent.status === 'ready' && cwd && samePath(agent.cwd, cwd)
      )
    if (running) return asRecord(await manager.nativeCommand(running.agentId, type, payload))
    const workspace = cwd ?? getPrimeAgentDir()
    if (!env.mock) {
      return sanitizeNativeModels(
        await primeServiceCommand(type, payload, workspace, {
          executablePath: engineOverridePath('prime')
        })
      )
    }
    const service = new PrimeMockEngineProcess({ engine: 'prime', cwd: workspace, noSession: true })
    try {
      await service.start()
      return sanitizeNativeModels(asRecord(await service.nativeCommand(type, payload)))
    } finally {
      await service.stop()
    }
  }

  const broadcastPrimeSettings = <Channel extends keyof SettingsEventMap>(
    channel: Channel,
    payload: SettingsEventMap[Channel]
  ): void => {
    if (channel === 'settings:changed' && 'area' in payload) {
      configWatcher.noteSelfChange(payload.area, payload.project?.cwd ?? null)
    }
    // Feature event keys retain their payload relationship at the shared event-map boundary.
    broadcast(channel, { ...payload, engine: 'prime' } as EventMap[Channel])
  }

  handle('engine:create', async (args, agentId) => {
    if (args.engine !== undefined && !isEngineId(args.engine)) {
      throw new Error('Choose a supported engine')
    }
    const engine = normalizeEngineId(args.engine)
    const resolved = resolveLaunchEnv(
      { ...args, engine },
      appState.getPrefs(),
      runningEnvs(manager, engine)
    )
    const created = await manager.create(resolved, agentId)
    if (created.engine === 'prime') configWatcher.sync()
    return maskAgentInfo(created)
  })
  handle('engine:command', (agentId, command) => manager.command(agentId, command))
  handle('engine:ui-response', (agentId, response) => manager.respondUi(agentId, response))
  handle('engine:dispose', async (agentId) => {
    const engine = manager.get(agentId)?.engine
    await manager.dispose(agentId)
    if (engine === 'prime') configWatcher.sync()
  })
  handle('engine:list', () => manager.list().map(maskAgentInfo))
  handle('engine:restart', async (agentId, requested) => {
    const current = manager.get(agentId)
    if (current && requested?.engine !== undefined && requested.engine !== current.engine) {
      throw new Error('Choose a different engine when creating a new session')
    }
    const patch = current ? await dropStaleTrustPin(current, requested) : requested
    const own = current?.args.launch?.env
    const resolved =
      patch?.launch && current
        ? resolveLaunchEnv(
            { cwd: current.cwd, ...patch, engine: current.engine },
            appState.getPrefs(),
            [...(own ? [own] : []), ...runningEnvs(manager, current.engine)]
          )
        : patch
    return maskAgentInfo(await manager.restart(agentId, resolved))
  })
  handle('engine:switch', async (agentId, args) => {
    const current = manager.get(agentId)
    if (!current) throw new Error('This session is no longer open')
    if (!args || !isEngineId(args.engine) || args.engine === current.engine) {
      throw new Error('Choose a different engine for this session')
    }
    if (typeof args.cwd !== 'string' || !isAbsolute(args.cwd) || !samePath(args.cwd, current.cwd)) {
      throw new Error('Engine switching must keep the current workspace')
    }
    if (args.engine === 'pi' && args.approve === undefined) {
      const trust = await trustPreflight(engineOverridePath('pi'), current.cwd)
      if (trust.needsDecision) throw new Error('Choose project trust before switching to Engine')
    }
    const resolved = resolveLaunchEnv(args, appState.getPrefs(), runningEnvs(manager, args.engine))
    const switched = await manager.switchEngine(agentId, resolved)
    configWatcher.sync()
    return maskAgentInfo(switched)
  })
  handle('engine:stderr', (agentId) => manager.stderr(agentId))
  handle('engine:info', () => engineInfo())
  handle('engine:backends', () => engineBackends())
  handle('engine:background-list', (engine) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (engine === 'pi' || env.mock) return []
    return listPrimeBackground({ executablePath: engineOverridePath('prime') })
  })
  handle('engine:background-stop', async (engine, nativeAgentId) => {
    if (engine !== 'prime') throw new Error('This engine does not keep background sessions')
    if (env.mock) return
    await stopPrimeBackground(nativeAgentId, { executablePath: engineOverridePath('prime') })
  })
  handle('engine:describe', (engine) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    return engineInfo(engine)
  })
  handle('engine:settings', async (request, event) => {
    if (
      !request ||
      !isEngineId(request.engine) ||
      typeof request.channel !== 'string' ||
      !request.channel.startsWith('settings:') ||
      !isRegisteredInvokeChannel(request.channel) ||
      !Array.isArray(request.args)
    ) {
      throw new Error('Invalid engine settings request')
    }
    if (request.engine === 'pi') return invokeRegistered(request.channel, request.args, event)
    const cwd = settingsWorkspace(request, appState.getPrefs().activeWorkspace)
    return invokePrimeSettings(request, {
      overridePath: engineOverridePath('prime'),
      cwd,
      nativeCommand: nativeSettingsCommand,
      broadcast: broadcastPrimeSettings
    })
  })
  handle('prime:command', (agentId, type, payload) => manager.nativeCommand(agentId, type, payload))
  handle('engine:traces', async (args) => {
    const actions = [
      'status',
      'on',
      'off',
      'preview',
      'preview-content',
      'upload',
      'upload-current',
      'upload-all'
    ]
    if (!args || !actions.includes(args.action)) throw new Error('Choose a supported trace action')
    const agent = args.agentId ? manager.get(args.agentId) : undefined
    if (args.agentId && !agent) throw new Error('This session is no longer open')
    if (agent && agent.engine !== 'prime')
      throw new Error('Trace controls are only available for Engine 2 sessions')
    const cwd = agent?.cwd ?? args.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Choose a workspace folder')
    const sessionDir = agent?.args.sessionDir ?? agent?.args.launch?.env?.PRIME_AGENT_SESSION_DIR
    const result = await runPrimeTraces(
      { ...args, cwd },
      agent?.sessionFile,
      sessionDir ? resolve(cwd, sessionDir) : undefined,
      (progress) => broadcast('engine:traces-progress', progress)
    )
    if (args.action === 'on' || args.action === 'off') {
      broadcastPrimeSettings('settings:changed', {
        area: 'settings',
        project: { cwd, trusted: true }
      })
    }
    return result
  })
  handle('engine:traces-cancel', (cwd) => {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Choose a workspace folder')
    cancelPrimeTraces(cwd)
  })
  handle('engine:bridge', (agentId, request, options) => manager.bridge(agentId, request, options))
  handle('engine:subagents-inspect', (agentId, request) =>
    manager.inspectSubagent(agentId, request)
  )
  handle('mock:play', (agentId, args) => manager.mockPlay(agentId, args))
}
