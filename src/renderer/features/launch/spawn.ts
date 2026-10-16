import { normalizeEngineId, type CreateAgentArgs, type EngineId } from '@shared/api/engine'
import type { TrustChoice, TrustPreflight } from '@shared/api/launch'
import { basename } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { normalizePath, samePath } from '../../lib/paths'
import { useAgents, type AgentsStore } from '../../store/agents'
import { useApp, workspaceEngine } from '../../store/app'
import { toast } from '../../ui'
import { restartAgentsWhenIdle } from '../settings/engines'
import { mergeLaunchOptions, normalizeLaunchOptions } from './options'
import { getWorkspaceLaunchDefaults, launchFlagsKey, requestTrustChoice, useLaunch } from './store'

export interface PrepareLaunchOptions {
  /** Merge the workspace's saved launch defaults under `args.launch` (default true). */
  workspaceDefaults?: boolean
}

/** Open agents whose workspace is `folder` or inside it (a saved trust decision covers subfolders too). */
export function agentsInFolder(
  folder: string,
  { order, agents }: Pick<AgentsStore, 'order' | 'agents'> = useAgents.getState(),
  engine: EngineId = workspaceEngine(folder)
): string[] {
  const root = normalizePath(folder)
  return order.filter((id) => {
    const agent = agents[id]
    if (normalizeEngineId(agent?.info.engine) !== engine) return false
    const cwd = agent?.info.cwd
    if (!cwd) return false
    const key = normalizePath(cwd)
    return key === root || key.startsWith(`${root}\\`) || key.startsWith(`${root}/`)
  })
}

/** Trust decisions in progress per folder, so parallel spawns share one dialog. */
const pendingTrust = new Map<string, Promise<boolean | undefined>>()

function forgetFlags(cwd: string, engine: EngineId): void {
  useLaunch.setState((s) => {
    const flags = { ...s.flags }
    delete flags[launchFlagsKey(cwd, engine)]
    return { flags }
  })
}

async function applyTrustChoice(
  preflight: TrustPreflight,
  choice: TrustChoice,
  engine: EngineId
): Promise<boolean> {
  const trusted = choice === 'trust-remember' || choice === 'trust-once'
  if (choice === 'trust-remember' || choice === 'distrust-remember') {
    try {
      await invoke('engine:set-trust', engine, preflight.cwd, trusted)
      forgetFlags(preflight.cwd, engine)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not save the trust decision',
        description: (error as Error).message
      })
    }
  }
  return trusted
}

/**
 * Resolve project trust before an engine starts in `cwd`. Returns the `approve` value to spawn with:
 * undefined when the engine's own resolution already matches (no resources, saved decision, or a
 * non-"ask" default); otherwise the user's answer from the Trust dialog ("Not now"/Esc → false).
 */
export function resolveSpawnTrust(
  cwd: string,
  engine: EngineId = workspaceEngine(cwd)
): Promise<boolean | undefined> {
  const key = `${engine}:${normalizePath(cwd)}`
  const existing = pendingTrust.get(key)
  if (existing) return existing
  const pending = (async () => {
    let preflight: TrustPreflight
    try {
      preflight = await invoke('engine:trust-preflight', engine, cwd)
    } catch {
      // Engine missing or SDK unavailable: the spawn itself reports the real error.
      return undefined
    }
    if (!preflight.needsDecision) return undefined
    const choice = await requestTrustChoice(preflight, 'decide', engine)
    return applyTrustChoice(preflight, choice ?? 'not-now', engine)
  })().finally(() => pendingTrust.delete(key))
  pendingTrust.set(key, pending)
  return pending
}

/**
 * Final CreateAgentArgs for a spawn: workspace launch defaults merged in, `--offline` added while the
 * "Work offline" setting is on (`PI_OFFLINE` needs nothing: the engine inherits the environment), and
 * project trust resolved.
 */
export async function prepareLaunch(
  args: CreateAgentArgs,
  options: PrepareLaunchOptions = {}
): Promise<CreateAgentArgs> {
  const engine = args.engine ?? workspaceEngine(args.cwd)
  const merged =
    options.workspaceDefaults === false
      ? normalizeLaunchOptions(args.launch, engine)
      : mergeLaunchOptions(getWorkspaceLaunchDefaults(args.cwd, engine), args.launch, engine)
  const offline = engine === 'pi' && !!useApp.getState().prefs.features.updates?.offline
  const launch = offline ? { ...merged, offline: true } : merged
  const approve =
    engine === 'pi' ? (args.approve ?? (await resolveSpawnTrust(args.cwd, engine))) : undefined
  return { ...args, engine, approve, launch }
}

/**
 * Re-open the trust decision for a workspace (palette / `/trust`). Applies to sessions started afterwards and,
 * when the user asks for it, restarts the folder's open sessions in place (busy ones after they settle). The
 * restart drops any pinned `--approve`/`--no-approve` so the engine reads the decision just saved.
 */
export async function manageWorkspaceTrust(cwd: string, requestedEngine?: EngineId): Promise<void> {
  const agents = useAgents.getState()
  const active = agents.activeAgentId ? agents.agents[agents.activeAgentId] : undefined
  const engine =
    requestedEngine ??
    (samePath(active?.info.cwd, cwd)
      ? normalizeEngineId(active?.info.engine)
      : workspaceEngine(cwd))
  if (engine !== 'pi') {
    toast({ level: 'info', title: 'This engine does not use project trust decisions.' })
    return
  }
  let preflight: TrustPreflight
  try {
    preflight = await invoke('engine:trust-preflight', engine, cwd)
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not read project trust',
      description: (error as Error).message
    })
    return
  }
  const answer = await requestTrustChoice(preflight, 'manage', engine)
  if (!answer) return
  const decision = answer.choice === 'forget' ? null : answer.choice === 'trust-remember'
  try {
    await invoke('engine:set-trust', engine, cwd, decision)
    forgetFlags(cwd, engine)
    const restart =
      decision !== null && answer.restartOpen
        ? agentsInFolder(cwd, useAgents.getState(), engine)
        : []
    if (restart.length > 0) restartAgentsWhenIdle(restart, { approve: undefined })
    const name = basename(cwd)
    const title =
      decision === null
        ? `${name} will ask again`
        : decision
          ? `${name} is trusted`
          : `${name} is not trusted`
    const description =
      restart.length > 0
        ? 'Open sessions here restart with it; running ones once they finish.'
        : 'Applies to new sessions in this folder.'
    toast({ level: 'success', title, description })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not save the trust decision',
      description: (error as Error).message
    })
  }
}
