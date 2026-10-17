import { lazy, Suspense } from 'react'
import { PanelLeft, Search } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '../../lib/cn'
import { basename, pluralize } from '../../lib/format'
import { spring } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { selectActiveWorkspace, useApp } from '../../store/app'
import { IconButton, Kbd, Mark, Pill, Tooltip } from '../../ui'
import { AboutDialog, openAbout } from '../about'
import { activateAgent, agentTitle, liveState } from '../sessions'
import { useRecoveryNotice } from './recovery'
import { useThemePreferenceSync } from './theme-preference'

const UpdatesPill = lazy(() => import('../updates').then((m) => ({ default: m.UpdatesPill })))

interface ActivitySummary {
  running: number
  waiting: number
  /** Most urgent background agent (waiting beats running). */
  nextId: string | null
  nextTitle: string
}

/** Narrow, shallow-compared summary so streaming frames don't re-render the titlebar. */
function useBackgroundActivity(): ActivitySummary {
  return useAgents(
    useShallow((s) => {
      let running = 0
      let waiting = 0
      let firstWaiting: (typeof s.agents)[string] | undefined
      let firstRunning: (typeof s.agents)[string] | undefined
      for (const agent of Object.values(s.agents)) {
        if (agent.id === s.activeAgentId) continue
        const state = liveState(agent)
        if (state === 'waiting') {
          waiting++
          firstWaiting ??= agent
        } else if (state === 'running') {
          running++
          firstRunning ??= agent
        }
      }
      const next = firstWaiting ?? firstRunning
      return { running, waiting, nextId: next?.id ?? null, nextTitle: next ? agentTitle(next) : '' }
    })
  )
}

/** Agents working (or waiting for input) behind the active one; click jumps to the most urgent. Neutral unless waiting. */
function BackgroundActivity() {
  const { running, waiting, nextId, nextTitle } = useBackgroundActivity()
  return (
    <AnimatePresence initial={false}>
      {nextId && (
        <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.94 }} transition={spring.snappy}>
          <Tooltip content={`Switch to “${nextTitle}”`}>
            <Pill tone={waiting > 0 ? 'warning' : 'neutral'} indicator={waiting > 0 ? 'dot' : 'live'} onClick={() => activateAgent(nextId)}>
              {waiting > 0 ? `${pluralize(waiting, 'session')} need${waiting === 1 ? 's' : ''} input` : `${running} working`}
            </Pill>
          </Tooltip>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/**
 * Custom 40px titlebar (drag region): mark · sidebar toggle · workspace crumb | search pill | activity + updates.
 * The native window controls keep their room (tokens.css `--titlebar-inset-*`): caption buttons on the right
 * (Windows, floating Linux), traffic lights on the left (macOS), where the mark sits as far from them as they sit
 * from the window edge. The session title lives in the session header and the inspector toggle beside the pane it
 * opens. Owns the full-width hairline under the chrome (sheets and the workbench draw no top edge of their own). The
 * first run shows neither the sidebar toggle nor the search pill. Dims while the window is in the background. The
 * mark opens About. The titlebar also hosts window-level effects: the one-time crash-recovery notice and the native
 * theme preference.
 */
export function Titlebar() {
  const workspace = useApp(selectActiveWorkspace)
  const sidebarOpen = useApp((s) => s.prefs.sidebar.open)
  const { toggleSidebar, setPaletteOpen } = useApp.getState()
  const crumb = workspace ? workspace.name || basename(workspace.path) : null
  // First run (no workspace, no session) has no sidebar to toggle.
  const workspaceSet = useApp((s) => s.prefs.activeWorkspace !== null)
  const sessionOpen = useAgents((s) => s.activeAgentId !== null)
  const hasWorkspace = workspaceSet || sessionOpen
  useRecoveryNotice()
  useThemePreferenceSync()

  return (
    <header
      className="drag relative z-[var(--z-titlebar)] grid h-[var(--titlebar-h)] shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-hairline-soft pr-[calc(var(--titlebar-inset-end)+8px)] pl-[max(12px,var(--titlebar-inset-start))]"
    >
      <div className="flex min-w-0 items-center gap-1.5 transition-opacity duration-[var(--dur-panel)] window-blurred:opacity-50">
        <IconButton label="About Vengeance" size="sm" onClick={openAbout} className="-ml-1.5">
          <Mark size={16} className="transition-[filter] duration-[var(--dur-panel)] window-blurred:grayscale" />
        </IconButton>
        {hasWorkspace && (
          <IconButton label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} hotkey="mod+b" size="sm" onClick={() => toggleSidebar()} className="text-fg-3 hover:text-fg">
            <PanelLeft />
          </IconButton>
        )}
        <span className={cn('min-w-0 truncate pl-1 text-sm font-medium', crumb ? 'text-fg-2' : 'text-fg-3')} title={workspace?.path}>
          {crumb ?? 'Vengeance'}
        </span>
      </div>

      {hasWorkspace ? (
        <button
          type="button"
          data-titlebar-search
          onClick={() => setPaletteOpen(true)}
          className={cn(
            'no-drag group flex h-7 w-[min(440px,36vw)] items-center gap-2 rounded-md pr-1.5 pl-2.5 text-sm text-fg-3',
            'bg-[color-mix(in_oklab,var(--surface-2)_65%,transparent)] shadow-[inset_0_0_0_1px_var(--hairline)]',
            'transition-[background-color,color,box-shadow,opacity] duration-[var(--dur-instant)] hover:bg-surface-2 hover:text-fg-2 hover:shadow-[var(--highlight),inset_0_0_0_1px_var(--hairline-strong)]',
            'window-blurred:opacity-60'
          )}
        >
          <Search className="size-3.5 shrink-0 transition-colors group-hover:text-fg-2" />
          <span className="flex-1 truncate text-left">Search or run a command…</span>
          <Kbd combo="mod+k" size="xs" />
        </button>
      ) : (
        // First run: nothing to search yet; keep the grid's center column.
        <span />
      )}

      <div className="flex min-w-0 items-center justify-end gap-1.5 transition-opacity duration-[var(--dur-panel)] window-blurred:opacity-50">
        <BackgroundActivity />
        <Suspense fallback={null}>
          <UpdatesPill />
        </Suspense>
      </div>
      <AboutDialog />
    </header>
  )
}
