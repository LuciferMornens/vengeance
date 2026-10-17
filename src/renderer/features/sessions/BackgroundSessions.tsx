import { Fragment, useEffect, useRef } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { BackgroundAgentInfo } from '@shared/api/engine'
import { basename } from '../../lib/format'
import { normalizePath } from '../../lib/paths'
import { useWindowFocused } from '../../lib/window-focus'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { IconButton } from '../../ui'
import { resumeBackgroundAgent } from './actions'
import { LiveDot } from './LiveDot'
import { agentSessionFile, matchesQuery } from './model'
import { SectionHeader } from './SessionListParts'
import { useSessions, useSessionsPrefs } from './store'
import { inWorkspaceView } from './workspace-view'
import { primeBackgroundFamilyNode, type PrimeSessionFamilies } from './prime-family-model'
import { PrimeFamilyChildren, primeFamilyMatches } from './PrimeSessionFamilies'
import { BackgroundSessionStop } from './BackgroundSessionStop'

const BACKGROUND_REFRESH_MS = 5_000

function residentTitle(agent: BackgroundAgentInfo): string {
  return agent.name?.trim() || basename(agent.cwd) || 'Background session'
}

export function BackgroundSessions({ families }: { families: PrimeSessionFamilies }) {
  const agents = useSessions((state) => state.background)
  const error = useSessions((state) => state.backgroundError)
  const loading = useSessions((state) => state.backgroundLoading)
  const query = useSessions((state) => state.query)
  const sidebarOpen = useApp((state) => state.prefs.sidebar.open)
  const focused = useWindowFocused()
  const anyBusy = agents.some((agent) => agent.busy)
  const activeWorkspace = useApp((state) => state.prefs.activeWorkspace)
  const workspaces = useApp((state) => state.prefs.workspaces)
  const { scope } = useSessionsPrefs()
  const openPaths = useAgents(
    useShallow((state) =>
      state.order.flatMap((id) => {
        const agent = state.agents[id]
        const path = agent ? agentSessionFile(agent) : undefined
        return agent && path ? [`${agent.info.engine}:${normalizePath(path)}`] : []
      })
    )
  )
  const attachedIds = useAgents(
    useShallow((state) =>
      state.order.flatMap((id) => {
        const agent = state.agents[id]
        const nativeId = agent?.info.nativeAgentId ?? agent?.info.args.nativeAgentId
        return agent && nativeId ? [`${agent.info.engine}:${nativeId}`] : []
      })
    )
  )
  const listed = useRef(false)
  const openPathsKey = [...openPaths, ...attachedIds].join('|')

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void useSessions.getState().loadBackground()
    }
    // Each poll wakes main and every Engine 2 daemon. A background window polls only while listed work is running
    // (so its live dot settles when the work ends) and loads the list once; focusing the window refreshes at once
    // (this effect re-runs), leaving it does not.
    const polling = focused || anyBusy
    if (polling || !listed.current) refresh()
    listed.current = true
    if (!sidebarOpen || !polling) return
    const interval = setInterval(refresh, BACKGROUND_REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [sidebarOpen, openPathsKey, focused, anyBusy])

  const open = new Set(openPaths)
  const inView = (cwd: string) => inWorkspaceView(cwd, { scope, activeWorkspace, workspaces })
  const visible = agents.filter(
    (agent) =>
      !primeBackgroundFamilyNode(families, agent)?.child &&
      inView(agent.cwd) &&
      (!agent.sessionPath || !open.has(`${agent.engine}:${normalizePath(agent.sessionPath)}`)) &&
      (!!agent.sessionPath || !attachedIds.includes(`${agent.engine}:${agent.id}`)) &&
      (matchesQuery(query, residentTitle(agent), agent.cwd, agent.status) ||
        primeFamilyMatches(primeBackgroundFamilyNode(families, agent), query))
  )

  if (visible.length === 0 && !error) return null
  return (
    <section aria-label="Background sessions">
      <SectionHeader label="Background sessions" count={visible.length}>
        <IconButton
          label="Refresh background sessions"
          size="xs"
          disabled={loading}
          onClick={() => void useSessions.getState().loadBackground()}
        >
          <RefreshCw />
        </IconButton>
      </SectionHeader>
      {visible.map((agent) => (
        <Fragment
          key={`${agent.engine}:${agent.sessionPath ? normalizePath(agent.sessionPath) : agent.id}`}
        >
          <div className="group mx-2 flex items-center gap-1 rounded-md hover:bg-hover">
            <button
              type="button"
              aria-label={`Resume ${residentTitle(agent)}`}
              title={agent.cwd}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left disabled:opacity-60"
              onClick={() => void resumeBackgroundAgent(agent)}
            >
              <LiveDot state={agent.busy ? 'running' : 'idle'} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-fg-2">
                  {residentTitle(agent)}
                </span>
                <span className="truncate text-xs text-fg-3">
                  {agent.busy
                    ? 'Working in background'
                    : agent.status === 'idle'
                      ? 'Idle'
                      : agent.status}{' '}
                  · {basename(agent.cwd)}
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-fg-3" />
            </button>
            <BackgroundSessionStop
              resident={agent}
              title={residentTitle(agent)}
              className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
          <PrimeFamilyChildren
            parent={primeBackgroundFamilyNode(families, agent)}
            query={query}
            inView={inView}
          />
        </Fragment>
      ))}
      {error && (
        <p role="status" className="px-4 py-2 text-xs text-fg-3">
          Could not refresh background sessions. {error}
        </p>
      )}
    </section>
  )
}
