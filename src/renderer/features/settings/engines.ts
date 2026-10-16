import type { CreateAgentArgs, EngineId } from '@shared/api/engine'
import type { SettingsScope, SettingsSnapshot } from '@shared/api/settings'
import type { SettingDef } from '@shared/api/settings-schema'
import { rpc } from '../../lib/engine'
import { normalizePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast } from '../../ui'
import { agentSessionFile } from '../sessions/model'
import { settingsInvokeForFolder } from './ipc'
import { changedSettings, restartsAfterOutsideEdit } from './values'

/**
 * Applying engine config changes to open agents. Running pi processes read settings, resources and
 * packages at startup, so most changes need a restart (sessions resume from their file). Restarts never
 * interrupt a run: busy agents restart once they settle.
 */

/** Agents waiting to restart, with the args patch to restart them with (see engine:restart). */
const pendingRestart = new Map<string, Partial<CreateAgentArgs>>()
let unsubscribe: (() => void) | null = null

function restartWhenIdle(): void {
  const store = useAgents.getState()
  for (const [id, patch] of [...pendingRestart]) {
    const agent = store.agents[id]
    if (!agent) {
      pendingRestart.delete(id)
      continue
    }
    if (
      agent.phase === 'idle' &&
      agent.status !== 'starting' &&
      !agent.compaction &&
      !Object.values(agent.bash).some((run) => run.running)
    ) {
      pendingRestart.delete(id)
      void store.restartAgent(id, patch).catch((error: unknown) => {
        toast({
          id: `settings-restart-error-${id}`,
          level: 'error',
          title: 'Could not restart session',
          description: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }
  if (pendingRestart.size === 0 && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

/**
 * Restart these agents in place now (idle) or after they settle (busy); `patch` replaces stored launch args.
 * Agents without a session file (`--no-session`) are skipped: a restart can only resume from the file, so it would
 * silently empty their conversation. A toast says which sessions keep the previous engine.
 */
export function restartAgentsWhenIdle(agentIds: string[], patch?: Partial<CreateAgentArgs>): void {
  const { agents } = useAgents.getState()
  const ephemeral = agentIds.filter((id) => agents[id] && !agentSessionFile(agents[id]))
  if (ephemeral.length > 0) {
    toast({
      id: 'restart-skipped-unsaved',
      level: 'info',
      title:
        ephemeral.length === 1
          ? 'An unsaved session kept its engine'
          : `${ephemeral.length} unsaved sessions kept their engine`,
      description:
        'Sessions without a session file can’t resume after a restart, so they keep running as they are. New sessions pick up the change.',
      duration: 9000
    })
  }
  // A later plain restart keeps an earlier patch (e.g. a new trust decision) for agents still waiting.
  for (const id of agentIds)
    if (!ephemeral.includes(id)) pendingRestart.set(id, { ...pendingRestart.get(id), ...patch })
  restartWhenIdle()
  if (pendingRestart.size > 0 && !unsubscribe) unsubscribe = useAgents.subscribe(restartWhenIdle)
}

/** Restart every open agent now (idle) or after it settles (busy). */
export function restartEngines(engine?: EngineId): void {
  restartAgentsWhenIdle(agentsForEngine(engine))
}

/** Re-query capabilities of every open agent without restarting it (never drops a live stream; the store also hides the bridge's internal commands). */
export function refreshAgents(engine?: EngineId): void {
  const store = useAgents.getState()
  for (const id of agentsForEngine(engine)) {
    if (store.agents[id]?.status === 'ready')
      void store.refreshCapabilities(id).catch(() => undefined)
  }
}

/** Ready agents (optionally only those offering `command`), for config actions that run in open sessions. */
export function readyAgentIds(command?: string, engine: EngineId = 'pi'): string[] {
  const { order, agents } = useAgents.getState()
  return order.filter((id) => {
    const agent = agents[id]
    return (
      agent?.info.engine === engine &&
      agent.status === 'ready' &&
      (!command || agent.commands.some((c) => c.name === command))
    )
  })
}

/** The open agents a config change concerns (e.g. one folder's after a trust decision) and the launch-args patch to restart them with. */
export interface RestartScope {
  agentIds: string[]
  patch: Partial<CreateAgentArgs>
}

export function agentsForEngine(engine?: EngineId, cwd?: string | null): string[] {
  const { order, agents } = useAgents.getState()
  const folder = cwd ? normalizePath(cwd) : null
  return order.filter((agentId) => {
    const agent = agents[agentId]
    if (!agent || (engine && agent.info.engine !== engine)) return false
    return !folder || normalizePath(agent.info.cwd) === folder
  })
}

/**
 * After a config write: honor the restart policy (ask → toast, always → restart, never → nothing) for every open
 * agent, or only those in `scope`. `none` = the change only affects the terminal UI.
 */
export function afterEngineConfigChange(
  effect: 'restart' | 'none',
  scope?: RestartScope,
  engine: EngineId = 'pi'
): void {
  if (effect === 'none') return
  refreshAgents(engine)
  const matching = new Set(agentsForEngine(engine))
  const agentIds = scope ? scope.agentIds.filter((agentId) => matching.has(agentId)) : [...matching]
  if (agentIds.length === 0) return
  const policy = useApp.getState().prefs.features.settings?.restartPolicy ?? 'ask'
  if (policy === 'never') return
  const restart = () => restartAgentsWhenIdle(agentIds, scope?.patch)
  if (policy === 'always') {
    restart()
    return
  }
  toast({
    // A folder's offer must not replace a pending offer for every session.
    id: `settings-restart-${engine}${scope ? `-${[...agentIds].sort().join(',')}` : ''}`,
    level: 'info',
    title: 'Restart to apply',
    description: scope
      ? 'Open sessions in this folder update after a restart.'
      : 'Open sessions update after a restart.',
    duration: 9000,
    action: { label: 'Restart engines', onClick: restart }
  })
}

/**
 * settings.json changed outside Vengeance (an editor, the terminal): open engines get the changed live settings over
 * RPC and the restart policy for the rest. A file that no longer parses changes nothing until it is fixed.
 */
export async function applyOutsideSettingsEdit(
  previous: SettingsSnapshot,
  next: SettingsSnapshot,
  engine: EngineId = 'pi',
  scope: SettingsScope = 'global'
): Promise<void> {
  if (scope === 'global' ? next.global.error : next.project?.error) return
  const sameFolder =
    previous.project &&
    next.project &&
    normalizePath(previous.project.cwd) === normalizePath(next.project.cwd)
  const comparablePrevious = sameFolder
    ? { ...previous, project: { ...previous.project!, cwd: next.project!.cwd } }
    : previous
  const changed = changedSettings(comparablePrevious, next, engine, scope)
  if (changed.length === 0) return
  const live = new Set(changed.flatMap((def) => (def.live ? [def.live] : [])))
  for (const setting of live) await applyLiveSetting(setting, next, engine, scope)
  if (changed.some(restartsAfterOutsideEdit)) {
    const affected =
      scope === 'project'
        ? { agentIds: agentsForEngine(engine, next.project?.cwd), patch: {} }
        : undefined
    afterEngineConfigChange('restart', affected, engine)
  } else refreshAgents(engine)
}

/** Settings with an RPC equivalent apply to running agents instantly. */
export async function applyLiveSetting(
  live: NonNullable<SettingDef['live']>,
  snapshot: SettingsSnapshot,
  engine: EngineId = 'pi',
  scope: SettingsScope = 'global'
): Promise<void> {
  if (engine !== 'pi') return
  const read = (current: SettingsSnapshot, path: string[], fallback: unknown) => {
    let project: unknown = current.project?.data
    let global: unknown = current.global.data
    for (const part of path) {
      project =
        project && typeof project === 'object'
          ? (project as Record<string, unknown>)[part]
          : undefined
      global =
        global && typeof global === 'object' ? (global as Record<string, unknown>)[part] : undefined
    }
    // Engines load project settings only for trusted folders.
    return (current.project?.trust.effective ? (project ?? global) : global) ?? fallback
  }
  const store = useAgents.getState()
  const ready = agentsForEngine(engine, scope === 'project' ? snapshot.project?.cwd : null).filter(
    (id) => store.agents[id]?.status === 'ready'
  )
  const snapshots = new Map<string, Promise<SettingsSnapshot>>()
  if (snapshot.project) snapshots.set(snapshot.project.cwd, Promise.resolve(snapshot))
  const applied = await Promise.allSettled(
    ready.map(async (id) => {
      const cwd = store.agents[id]!.info.cwd
      let request = snapshots.get(cwd)
      if (!request) {
        request = settingsInvokeForFolder(engine, cwd, 'settings:snapshot', cwd)
        snapshots.set(cwd, request)
      }
      const current = await request
      switch (live) {
        case 'steeringMode':
          return rpc(id, {
            type: 'set_steering_mode',
            mode:
              read(current, ['steeringMode'], 'one-at-a-time') === 'all' ? 'all' : 'one-at-a-time'
          })
        case 'followUpMode':
          return rpc(id, {
            type: 'set_follow_up_mode',
            mode:
              read(current, ['followUpMode'], 'one-at-a-time') === 'all' ? 'all' : 'one-at-a-time'
          })
        case 'autoCompaction':
          return rpc(id, {
            type: 'set_auto_compaction',
            enabled: read(current, ['compaction', 'enabled'], true) !== false
          })
        case 'autoRetry':
          return rpc(id, {
            type: 'set_auto_retry',
            enabled: read(current, ['retry', 'enabled'], true) !== false
          })
      }
    })
  )
  if (applied.some((result) => result.status === 'fulfilled'))
    toast({
      id: 'settings-live',
      level: 'success',
      title: 'Applied to open sessions',
      duration: 2200
    })
}
