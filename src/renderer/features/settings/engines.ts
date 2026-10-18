import type { CreateAgentArgs, EngineId } from '@shared/api/engine'
import type { SettingsScope, SettingsSnapshot } from '@shared/api/settings'
import type { SettingDef } from '@shared/api/settings-schema'
import { rpc } from '../../lib/engine'
import { normalizePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import type { AgentState } from '../../store/agent-state'
import { useApp } from '../../store/app'
import { toast } from '../../ui'
import { agentSessionFile } from '../sessions/model'
import { settingsInvokeForFolder } from './ipc'
import {
  changedSettings,
  getAt,
  liveSetting,
  restartsAfterOutsideEdit,
  type SettingChange
} from './values'

/**
 * Applying engine config changes to open agents. Running pi processes read settings, resources and
 * packages at startup, so most changes need a restart (sessions resume from their file). Restarts never
 * interrupt a run: busy agents restart once they settle.
 */

/** Agents waiting to restart, with the args patch to restart them with (see engine:restart). */
const pendingRestart = new Map<string, Partial<CreateAgentArgs>>()
const restartingAgents = new Set<string>()
const restartRetries = new Map<string, { failures: number; after: number }>()
const INITIAL_RESTART_RETRY_MS = 250
const MAX_RESTART_RETRY_MS = 2000
const RETRYABLE_RESTART_REFUSALS = [
  'Wait for the current session operation to finish before restarting',
  'Wait until this session finishes its active work before restarting',
  'Wait for Engine 2 side questions to finish before restarting its runtime',
  'Wait until every Engine 2 resident reconnects before restarting its runtime',
  'Wait for Engine 2 background services to finish, then restart again.',
  'Finish this session’s extension dialog before restarting',
  'This engine is already restarting',
  'This engine is already changing'
]
let unsubscribe: (() => void) | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function canRestartAgent(agent: AgentState): boolean {
  const queued = agent.queue.steering.length + agent.queue.followUp.length
  return (
    agent.phase === 'idle' &&
    agent.status !== 'starting' &&
    agent.status !== 'stopping' &&
    !agent.compaction &&
    agent.ext.dialogs.length === 0 &&
    (agent.info.engine !== 'pi' || queued === 0) &&
    !Object.values(agent.bash).some((run) => run.running)
  )
}

function syncRestartWatch(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  if (pendingRestart.size > 0) {
    if (!unsubscribe) unsubscribe = useAgents.subscribe(restartWhenIdle)
    const { agents } = useAgents.getState()
    const deadlines = [...restartRetries].flatMap(([id, retry]) => {
      const agent = agents[id]
      return agent && canRestartAgent(agent) && !restartingAgents.has(id) ? [retry.after] : []
    })
    if (deadlines.length) {
      retryTimer = setTimeout(
        () => {
          retryTimer = null
          restartWhenIdle()
        },
        Math.max(0, Math.min(...deadlines) - Date.now())
      )
    }
    return
  }
  unsubscribe?.()
  unsubscribe = null
}

function restartWhenIdle(): void {
  const store = useAgents.getState()
  for (const [id, patch] of [...pendingRestart]) {
    const agent = store.agents[id]
    if (!agent) {
      pendingRestart.delete(id)
      restartRetries.delete(id)
      continue
    }
    if (restartingAgents.has(id)) continue
    if ((restartRetries.get(id)?.after ?? 0) > Date.now()) continue
    if (canRestartAgent(agent)) {
      restartingAgents.add(id)
      void store
        .restartAgent(id, patch)
        .then(() => {
          restartRetries.delete(id)
          if (pendingRestart.get(id) === patch) pendingRestart.delete(id)
        })
        .catch((error: unknown) => {
          if (!pendingRestart.has(id)) return
          const description = error instanceof Error ? error.message : String(error)
          const waitingForSibling =
            /Engine 2 restarts its shared runtime\. Wait until .+ finishes, then restart again\./.test(
              description
            )
          if (
            waitingForSibling ||
            RETRYABLE_RESTART_REFUSALS.some((refusal) => description.includes(refusal))
          ) {
            const failures = restartRetries.get(id)?.failures ?? 0
            const delay = Math.min(INITIAL_RESTART_RETRY_MS * 2 ** failures, MAX_RESTART_RETRY_MS)
            restartRetries.set(id, { failures: failures + 1, after: Date.now() + delay })
            return
          }
          restartRetries.delete(id)
          if (pendingRestart.get(id) === patch) pendingRestart.delete(id)
          toast({
            id: `settings-restart-error-${id}`,
            level: 'error',
            title: 'Could not restart session',
            description
          })
        })
        .finally(() => {
          restartingAgents.delete(id)
          restartWhenIdle()
        })
    }
  }
  syncRestartWatch()
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
  for (const id of agentIds) {
    if (ephemeral.includes(id)) continue
    pendingRestart.set(id, { ...pendingRestart.get(id), ...patch })
    restartRetries.delete(id)
  }
  restartWhenIdle()
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
 * agent, or only those in `scope`. `none` = the change only affects the terminal UI. `reason` names what changed, so
 * an offer that follows a change made elsewhere (a terminal install, an edited file) says where it came from.
 */
export function afterEngineConfigChange(
  effect: 'restart' | 'none',
  scope?: RestartScope,
  engine: EngineId = 'pi',
  reason?: string
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
    description: [
      reason,
      scope
        ? 'Open sessions in this folder update after a restart.'
        : 'Open sessions update after a restart.'
    ]
      .filter(Boolean)
      .join(' '),
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
  const live = new Set(changed.flatMap((def) => liveSetting(def, engine, scope) ?? []))
  for (const setting of live) await applyLiveSetting(setting, next, engine, scope)
  const restarts = changed.filter((def) => restartsAfterOutsideEdit(def, engine, scope))
  if (restarts.length > 0) {
    const affected =
      scope === 'project'
        ? { agentIds: agentsForEngine(engine, next.project?.cwd), patch: {} }
        : undefined
    afterEngineConfigChange('restart', affected, engine, outsideEditReason(restarts))
  } else refreshAgents(engine)
}

/** "Theme, Quiet startup and 2 more changed outside Vengeance." */
function outsideEditReason(changed: SettingChange[]): string {
  const labels = changed.map((def) => def.label)
  const named = labels.length > 3 ? [...labels.slice(0, 2), `${labels.length - 2} more`] : labels
  const list =
    named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : named[0]
  return `${list} changed outside Vengeance.`
}

const LIVE_PATHS: Record<NonNullable<SettingDef['live']>, string[]> = {
  steeringMode: ['steeringMode'],
  followUpMode: ['followUpMode'],
  autoCompaction: ['compaction', 'enabled'],
  autoRetry: ['retry', 'enabled']
}

/** Settings with an RPC equivalent apply to running agents instantly. */
export async function applyLiveSetting(
  live: NonNullable<SettingDef['live']>,
  snapshot: SettingsSnapshot,
  engine: EngineId = 'pi',
  scope: SettingsScope = 'global'
): Promise<void> {
  const path = LIVE_PATHS[live]
  // Engines load project settings only for trusted folders; Engine 2 saves an inherited value as null.
  const projectValue = (current: SettingsSnapshot) =>
    (current.project?.trust.effective ? getAt(current.project.data, path) : undefined) ?? undefined
  const read = (current: SettingsSnapshot, fallback: unknown) =>
    projectValue(current) ?? getAt(current.global.data, path) ?? fallback
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
      // Engine 2 saves what it applies as the global value: a folder with its own value keeps it.
      if (engine === 'prime' && projectValue(current) !== undefined) return false
      switch (live) {
        case 'steeringMode':
          return rpc(id, {
            type: 'set_steering_mode',
            mode: read(current, 'one-at-a-time') === 'all' ? 'all' : 'one-at-a-time'
          })
        case 'followUpMode':
          return rpc(id, {
            type: 'set_follow_up_mode',
            mode: read(current, 'one-at-a-time') === 'all' ? 'all' : 'one-at-a-time'
          })
        case 'autoCompaction':
          return rpc(id, { type: 'set_auto_compaction', enabled: read(current, true) !== false })
        case 'autoRetry':
          return rpc(id, { type: 'set_auto_retry', enabled: read(current, true) !== false })
      }
    })
  )
  if (applied.some((result) => result.status === 'fulfilled' && result.value !== false))
    toast({
      id: 'settings-live',
      level: 'success',
      title: 'Applied to open sessions',
      duration: 2200
    })
}
