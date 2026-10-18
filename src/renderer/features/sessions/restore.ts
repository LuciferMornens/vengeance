import type { OpenSessionRef } from '@shared/api/app'
import { normalizeEngineId } from '@shared/api/engine'
import { invoke } from '../../lib/ipc'
import { normalizePath } from '../../lib/paths'
import { useAgents, type AgentsStore } from '../../store/agents'
import { useApp } from '../../store/app'
import { openSessionFile } from './actions'
import { agentSessionFile } from './model'
import { useSessions } from './store'

/** Saved sessions of the open agents, in sidebar order (ephemeral sessions have no file and are not kept). */
function runningSessions(state: AgentsStore): OpenSessionRef[] {
  return state.order.flatMap((id) => {
    const agent = state.agents[id]
    const path = agent && !agent.info.args.noSession ? agentSessionFile(agent) : undefined
    return agent && path
      ? [{ path, cwd: agent.info.cwd, engine: agent.info.engine, lineage: agent.info.lineage }]
      : []
  })
}

let persisted = ''

/**
 * Write `openSessions` / `activeSession` when they change: the running sessions, then the dormant ones. Sent to main
 * right away (not debounced), which flushes it on quit. A dormant session that got opened another way stops being
 * dormant here.
 */
function persistOpenSessions(): void {
  const agents = useAgents.getState()
  const running = runningSessions(agents)
  const runningPaths = new Set(running.map(sessionKey))
  const { dormant } = useSessions.getState()
  const stillDormant = dormant.filter((session) => !runningPaths.has(sessionKey(session)))
  if (stillDormant.length !== dormant.length) useSessions.setState({ dormant: stillDormant })

  const active = agents.activeAgentId ? agents.agents[agents.activeAgentId] : undefined
  const activePath = active ? agentSessionFile(active) : undefined
  const activeSession =
    running.find((session) => session.path === activePath)?.path ??
    stillDormant.find((session) => session.path === useApp.getState().prefs.activeSession)?.path ??
    null
  const openSessions = [...running, ...stillDormant]
  const snapshot = JSON.stringify({ openSessions, activeSession })
  if (snapshot === persisted) return
  persisted = snapshot
  useApp.setState((state) => ({ prefs: { ...state.prefs, openSessions, activeSession } }))
  void invoke('app:set-state', { openSessions, activeSession })
}

function sessionKey(session: OpenSessionRef): string {
  return `${normalizeEngineId(session.engine)}:${normalizePath(session.path)}`
}

function startPersisting(): void {
  const { openSessions, activeSession } = useApp.getState().prefs
  persisted = JSON.stringify({ openSessions, activeSession })
  useAgents.subscribe((state, previous) => {
    if (
      state.activeAgentId === previous.activeAgentId &&
      state.order === previous.order &&
      state.agents === previous.agents
    )
      return
    const changed =
      state.activeAgentId !== previous.activeAgentId ||
      state.order !== previous.order ||
      state.order.some((id) => {
        const agent = state.agents[id]
        const before = previous.agents[id]
        if (agent === before) return false
        return (
          agent?.info.cwd !== before?.info.cwd ||
          agent?.info.engine !== before?.info.engine ||
          agent?.info.lineage !== before?.info.lineage ||
          agent?.info.args.noSession !== before?.info.args.noSession ||
          (agent && agentSessionFile(agent)) !== (before && agentSessionFile(before))
        )
      })
    if (changed) persistOpenSessions()
  })
  useSessions.subscribe((state, previous) => {
    if (state.dormant !== previous.dormant) persistOpenSessions()
  })
  persistOpenSessions()
}

/**
 * Boot, like a browser restoring its tabs: resume the session that was in front when the app quit, and bring the other
 * sessions that were open back as dormant rows that start their engine only when clicked. From then on the saved list
 * follows every open, close and switch. Resolves true when tabs were restored, including tabs waiting
 * for recovery, so boot does not create an unrelated session over their recovery dialog. Call once.
 */
export async function restoreOpenSessions(
  activationRevision = useAgents.getState().activationRevision
): Promise<boolean> {
  const { openSessions, activeSession } = useApp.getState().prefs
  const front = openSessions.find((session) => session.path === activeSession) ?? openSessions[0]
  // A failed resume must remain recoverable; persistence removes rows once an agent owns them.
  const dormant = openSessions
  useSessions.setState({ dormant })
  // Discovery registers project-specific session roots before the combined metadata listing.
  if (dormant.length) {
    void invoke('sessions:workspaces')
      .catch(() => undefined)
      .then(() => useSessions.getState().load(null))
  }
  try {
    if (!front) return false
    await openSessionFile(front.path, {
      cwd: front.cwd,
      engine: front.engine,
      activationRevision
    })
    return true
  } finally {
    startPersisting()
  }
}

/** Resume a dormant session (it leaves the dormant rows once its agent is open). */
export function resumeDormant(session: OpenSessionRef, activationRevision?: number): void {
  void openSessionFile(session.path, {
    cwd: session.cwd,
    engine: session.engine,
    activationRevision
  })
}
