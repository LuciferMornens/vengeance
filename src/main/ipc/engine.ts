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
import {
  appliedPrompt,
  assertInPlaceSwitch,
  carriedPrompt,
  ConversationPromptOwners,
  piSessionReplacement,
  primeSessionReplacement,
  savedSessionFile,
  unwrittenPrompt,
  withConversationPrompt,
  type PromptSave,
  type SessionReplacement
} from '../engine/conversation-prompt-owner'
import type { EngineManager } from '../engine/manager'
import { piConfig } from '../features/settings/pi-modules'
import { engineBackends, PI_CAPABILITIES } from '../engine/backends'
import { invokePrimeSettings } from '../engine/prime/configuration'
import { getPrimeAgentDir, primeEngineInfo } from '../engine/prime/locate'
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
import { savesMcpSwitch, whileEngineSavesMcp } from '../features/settings/engine-mcp-saves'
import {
  parseConversationPrompt,
  type ConversationPromptStore
} from '../features/sessions/conversation-prompts'
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

/**
 * Save or forget a session file's instructions. What the write records already took effect, so a failed
 * one is logged: only a later reopen of that file differs.
 */
async function savePrompt(
  prompts: ConversationPromptStore,
  save: PromptSave | undefined
): Promise<void> {
  if (!save) return
  await prompts.set(save.engine, save.sessionFile, save.prompt).catch((error: unknown) => {
    console.error('[vengeance] conversation instructions could not be saved:', error)
  })
}

/** AgentInfo leaves main with launch env values masked (N17). */
export function registerEngineIpc(manager: EngineManager, prompts: ConversationPromptStore): void {
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
    const { PrimeMockEngineProcess } = await import('../engine/prime/mock')
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

  const owners = new ConversationPromptOwners(prompts)

  handle('engine:create', async (args, agentId) => {
    if (args.engine !== undefined && !isEngineId(args.engine)) {
      throw new Error('Choose a supported engine')
    }
    const engine = normalizeEngineId(args.engine)
    const resolved = resolveLaunchEnv(
      withConversationPrompt({ ...args, engine }, engine, prompts),
      appState.getPrefs(),
      runningEnvs(manager, engine)
    )
    const created = await manager.create(resolved, agentId)
    owners.started(created, resolved.sessionPath)
    if (created.engine === 'prime') configWatcher.sync()
    await savePrompt(prompts, carriedPrompt(created, resolved.conversationPrompt, args.sessionPath))
    return maskAgentInfo(created)
  })
  /**
   * Run a session command that can move the process to another file. A fork or clone in place keeps the
   * process, and so its instructions, for the derived file.
   */
  const replaceSession = async <Result>(
    agentId: string,
    replacement: SessionReplacement,
    run: () => Promise<Result>
  ): Promise<Result> => {
    const before = replacement ? manager.get(agentId) : undefined
    if (before && replacement?.kind === 'switch') {
      assertInPlaceSwitch(before, prompts, replacement.target)
    }
    try {
      return await run()
    } finally {
      // Also after a failure: the engine may have moved before a follow-up read failed.
      const after = before ? manager.get(agentId) : undefined
      if (before && after) {
        owners.replaced(after)
        if (replacement?.kind === 'derive') {
          await savePrompt(
            prompts,
            carriedPrompt(after, before.args.conversationPrompt, savedSessionFile(before))
          )
        }
      }
    }
  }
  handle('engine:command', (agentId, command) =>
    replaceSession(agentId, piSessionReplacement(command), () => manager.command(agentId, command))
  )
  handle('engine:ui-response', (agentId, response) => manager.respondUi(agentId, response))
  handle('engine:dispose', async (agentId) => {
    const closed = manager.get(agentId)
    await manager.dispose(agentId)
    owners.closed(agentId)
    if (closed?.engine === 'prime') configWatcher.sync()
    // Mock sessions are not files.
    if (closed && !env.mock) {
      await savePrompt(prompts, await unwrittenPrompt(closed, manager.list(), prompts))
    }
  })
  handle('engine:list', () => manager.list().map(maskAgentInfo))
  handle('engine:restart', async (agentId, requested) => {
    const current = manager.get(agentId)
    if (current && requested?.engine !== undefined && requested.engine !== current.engine) {
      throw new Error('Choose a different engine when creating a new session')
    }
    let patch = current ? await dropStaleTrustPin(current, requested) : requested
    const changesPrompt = !!patch && Object.hasOwn(patch, 'conversationPrompt')
    if (patch && changesPrompt) {
      patch = { ...patch, conversationPrompt: parseConversationPrompt(patch.conversationPrompt) }
      // A change the store cannot save is refused before the restart applies it.
      if (!current?.args.noSession) prompts.assertReadable()
    }
    const own = current?.args.launch?.env
    const resolved =
      patch?.launch && current
        ? resolveLaunchEnv(
            { cwd: current.cwd, ...patch, engine: current.engine },
            appState.getPrefs(),
            [...(own ? [own] : []), ...runningEnvs(manager, current.engine)]
          )
        : patch
    const restarted = await manager.restart(
      agentId,
      resolved,
      current && !changesPrompt ? owners.instructionsFor(current) : undefined,
      (successor) => savePrompt(prompts, appliedPrompt(successor))
    )
    owners.started(restarted, restarted.args.sessionPath)
    return maskAgentInfo(restarted)
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
    // The conversation keeps its instructions on the other engine, saved for its new native file.
    const given = parseConversationPrompt(args.conversationPrompt)
    const resolved = resolveLaunchEnv(
      { ...args, conversationPrompt: given },
      appState.getPrefs(),
      runningEnvs(manager, args.engine)
    )
    const switched = await manager.switchEngine(
      agentId,
      resolved,
      given === undefined ? owners.instructionsFor(current) : undefined
    )
    owners.started(switched)
    configWatcher.sync()
    await savePrompt(prompts, carriedPrompt(switched, switched.args.conversationPrompt, undefined))
    return maskAgentInfo(switched)
  })
  handle('engine:conversation-prompt', (engine, sessionPath) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (typeof sessionPath !== 'string' || !isAbsolute(sessionPath)) {
      throw new Error('Choose a saved session file')
    }
    return prompts.get(engine, sessionPath) ?? null
  })
  handle('engine:stderr', (agentId) => manager.stderr(agentId))
  handle('engine:info', () => engineInfo())
  handle('engine:backends', () => engineBackends())
  handle('engine:background-list', (engine) => {
    if (!isEngineId(engine)) throw new Error('Choose a supported engine')
    if (engine === 'pi' || env.mock) return []
    return listPrimeBackground({ executablePath: engineOverridePath('prime') })
  })
  handle('engine:background-stop', async (engine, selector) => {
    if (engine !== 'prime') throw new Error('This engine does not keep background sessions')
    if (env.mock) return
    await stopPrimeBackground(selector, { executablePath: engineOverridePath('prime') })
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
    if (request.engine === 'pi' || request.channel === 'settings:release') {
      return invokeRegistered(request.channel, request.args, event)
    }
    const cwd = settingsWorkspace(request, appState.getPrefs().activeWorkspace)
    return invokePrimeSettings(request, {
      overridePath: engineOverridePath('prime'),
      cwd,
      nativeCommand: nativeSettingsCommand,
      broadcast: broadcastPrimeSettings
    })
  })
  handle('prime:command', (agentId, type, payload) =>
    replaceSession(agentId, primeSessionReplacement(type, payload), () =>
      manager.nativeCommand(agentId, type, payload)
    )
  )
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
  handle('engine:bridge', (agentId, request, options) => {
    const bridge = () => manager.bridge(agentId, request, options)
    if (manager.get(agentId)?.engine !== 'pi' || !savesMcpSwitch(request)) return bridge()
    // The Engine saves the switch to mcp.json for a change already live in this conversation:
    // Settings shows it, and open sessions are not offered a restart for it.
    return whileEngineSavesMcp(bridge).finally(() =>
      broadcast('settings:changed', { area: 'mcp', engine: 'pi', apply: 'new-sessions' })
    )
  })
  handle('engine:subagents-inspect', (agentId, request) =>
    manager.inspectSubagent(agentId, request)
  )
  handle('mock:play', (agentId, args) => manager.mockPlay(agentId, args))
}
