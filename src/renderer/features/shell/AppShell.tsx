import { memo, Suspense, useEffect, useLayoutEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { MessagesSquare, SquarePen } from 'lucide-react'
import { invoke, on, platform } from '../../lib/ipc'
import { useHotkey } from '../../lib/keybindings'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { duration, ease } from '../../lib/motion'
import { useWindowFocused } from '../../lib/window-focus'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, EmptyState, Sheet, Shimmer } from '../../ui'
import { Composer } from '../composer'
import { SessionHeader, Transcript } from '../chat'
import { TranscriptBoundary } from '../chat/TranscriptBoundary'
import { restoreOpenSessions, SessionSidebar } from '../sessions'
// Boot-time side effects of the lazily loaded settings feature: palette actions + settings change listeners.
import '../settings/actions'
import '../settings/store'
import { adoptEngines } from './adopt-engines'
import { registerCoreActions } from './core-actions'
import { EngineErrorState } from './EngineErrorState'
import { EngineUpgradeNotice } from './EngineUpgradeNotice'
import { fitPanels, useWindowWidth } from './panel-layout'
import { SidePanel } from './SidePanel'
import { Titlebar } from './Titlebar'
import { newSession, openWorkspace, useEngineSpawns } from './workspace'

// Heavy, rarely visible surfaces load on demand (kept out of the main chunk) and show once their chunk is there,
// without a Suspense fallback (see lazyWithPreload). Onboarding shows only on a first run.
const onboardingPanel = lazyWithPreload(() => import('../onboarding').then((m) => m.Onboarding))
const Onboarding = onboardingPanel.Component
const settingsSheet = lazyWithPreload(() => import('../settings').then((m) => m.SettingsSheet))
const SettingsSheet = settingsSheet.Component
const inspectorPanel = lazyWithPreload(() => import('../inspector').then((m) => m.Inspector))
const Inspector = inspectorPanel.Component

/** Keep <html> attributes, CSS scale and native window chrome in sync with prefs. */
function useAppearance(): void {
  const theme = useApp((s) => s.prefs.theme)
  const accent = useApp((s) => s.prefs.accent)
  const density = useApp((s) => s.prefs.density)
  const fontScale = useApp((s) => s.prefs.fontScale)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      const root = document.documentElement
      root.dataset.theme = resolved
      root.dataset.accent = accent
      root.dataset.density = density
      root.dataset.material = platform.material
      root.style.setProperty('--font-scale', String(fontScale))
      void invoke('win:set-theme', resolved)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, accent, density, fontScale])
}

/**
 * Set once the boot session has been requested. Module-level (not a ref) so StrictMode's second effect run, which
 * happens before the async spawn lands in `order`, never starts a second engine.
 */
let bootSessionRequested = false

/**
 * Take over the engines that survived a renderer crash, then reopen the sessions that were open at the last quit (an
 * adopted session is activated, not opened twice); with neither, a fresh session in the active workspace. Tests start
 * without one: their profiles only have sessions to reopen when a suite kept one across launches.
 */
async function bootSession(): Promise<void> {
  const activationRevision = useAgents.getState().activationRevision
  const adopted = await adoptEngines(activationRevision)
  if ((await restoreOpenSessions(activationRevision)) || adopted > 0) return
  if (useAgents.getState().activationRevision !== activationRevision) return
  const { activeWorkspace } = useApp.getState().prefs
  if (activeWorkspace && !platform.test) {
    await newSession({ cwd: activeWorkspace }, { activationRevision })
  }
}

/** Default flow: boot the sessions (see bootSession); react to folders opened from outside. */
function useWorkspaceBoot(): void {
  const ready = useApp((s) => s.ready)
  useEffect(() => {
    if (!ready) return
    if (useApp.getState().workspaceDiscovery === 'idle') {
      void useApp.getState().discoverWorkspaces()
    }
    if (!bootSessionRequested && useAgents.getState().order.length === 0) {
      bootSessionRequested = true
      void bootSession()
    }
    return on('app:open-folder', ({ path }) => void openWorkspace(path))
  }, [ready])
}

/** Toast clearance is set on the toaster, not <html>: a custom property on the root restyles every element. */
function setToastInset(name: '--toast-inset-right' | '--toast-inset-bottom', value: string): void {
  for (const toaster of document.querySelectorAll<HTMLElement>('[data-toaster]'))
    toaster.style.setProperty(name, value)
}

/** Toasts keep clear of the inspector; full sheets reset the offset (they cover the panes). */
function useToastInsetRight(inspectorWidth: number): void {
  useEffect(() => setToastInset('--toast-inset-right', `${inspectorWidth}px`), [inspectorWidth])
}

/** One shell owner mirrors the active composer's height for toast clearance. */
function useToastInsetBottom(agentId: string | null, enabled: boolean): void {
  useLayoutEffect(() => {
    const pane = Array.from(document.querySelectorAll<HTMLDivElement>('[data-session-pane]')).find(
      (element) => element.dataset.agentId === agentId
    )
    if (!pane || !enabled) {
      setToastInset('--toast-inset-bottom', '0px')
      return
    }
    // 8px on top of the toast's own 16px: toasts float 24px above the composer (and anything docked on it).
    const sync = () =>
      setToastInset(
        '--toast-inset-bottom',
        `calc(${getComputedStyle(pane).getPropertyValue('--composer-h').trim() || '0px'} + 8px)`
      )
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(pane, { attributes: true, attributeFilter: ['style'] })
    return () => {
      observer.disconnect()
      setToastInset('--toast-inset-bottom', '0px')
    }
  }, [agentId, enabled])
}

/** The crashed-engine card; subscribes to the whole agent only in this (non-streaming) state. */
function CrashedPane({ agentId }: { agentId: string }) {
  const agent = useAgents((s) => s.agents[agentId])
  return agent ? <EngineErrorState agent={agent} /> : null
}

/**
 * Center slot. Selects only what picks the view (agent present, status, first-message-pending), never the whole
 * agent, so streaming frames don't re-render the session pane from here.
 */
function CenterPane() {
  const agentId = useAgents((s) => s.activeAgentId)
  const hasAgent = useAgents((s) => !!agentId && !!s.agents[agentId])
  const status = useAgents((s) => (agentId ? s.agents[agentId]?.status : undefined))
  const empty = useAgents((s) => (agentId ? (s.agents[agentId]?.entries.length ?? 0) === 0 : true))
  const workspace = useApp((s) => s.prefs.activeWorkspace)
  const spawning = useEngineSpawns((s) => s.pending > 0)
  const firstRun = !workspace && !agentId
  const onboardingLoaded = onboardingPanel.useLoaded(firstRun)

  if (firstRun) {
    return onboardingLoaded ? (
      <Suspense fallback={<div className="flex-1" />}>
        <Onboarding />
      </Suspense>
    ) : (
      <div className="flex-1" />
    )
  }
  if (!hasAgent && !spawning) {
    return (
      <EmptyState
        className="flex-1"
        icon={<MessagesSquare />}
        title="No session open"
        description="Pick a session from the sidebar to resume it, or start a new one in this workspace."
        action={
          <Button variant="primary" leading={<SquarePen />} onClick={() => void newSession()}>
            New session
          </Button>
        }
      />
    )
  }
  if (!agentId || !hasAgent) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm">
        <Shimmer>Starting session…</Shimmer>
      </div>
    )
  }
  return (
    <motion.div
      key={agentId}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: duration.panel, ease: ease.out } }}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {status === 'crashed' ? (
        <CrashedPane agentId={agentId} />
      ) : (
        <SessionPane agentId={agentId} starting={status === 'starting' && empty} />
      )}
    </motion.div>
  )
}

/** Session layout: header, transcript, floating composer. Hosts `--composer-h` (default in globals.css). */
const SessionPane = memo(function SessionPane({
  agentId,
  starting
}: {
  agentId: string
  starting: boolean
}) {
  return (
    <div
      data-session-pane
      data-agent-id={agentId}
      className="@container/pane relative flex min-h-0 flex-1 flex-col"
    >
      <SessionHeader agentId={agentId} />
      <EngineUpgradeNotice agentId={agentId} />
      {starting ? (
        <div className="flex flex-1 items-center justify-center text-sm">
          <Shimmer>Starting engine…</Shimmer>
        </div>
      ) : (
        <TranscriptBoundary key={agentId} agentId={agentId}>
          <Transcript agentId={agentId} />
        </TranscriptBoundary>
      )}
      <Composer agentId={agentId} />
    </div>
  )
})

const SIDEBAR_LIMITS = { minWidth: 208, maxWidth: 420, defaultWidth: 268 }
// 304px: the tab bar's seven tabs fit, the active one labelled when there is room.
const INSPECTOR_LIMITS = { minWidth: 304, maxWidth: 560, defaultWidth: 340 }

/** The full app frame. Feature components are mounted into their slots here. */
export function AppShell() {
  useAppearance()
  useWorkspaceBoot()
  // Chrome dims while the window is in the background, as native window controls do. Tiling compositors draw none
  // and move focus with the pointer, where the dim would only flicker.
  const dimmed = !useWindowFocused() && platform.windowControls !== 'none'
  useEffect(() => registerCoreActions(), [])

  const sidebar = useApp((s) => s.prefs.sidebar)
  const inspector = useApp((s) => s.prefs.inspector)
  const settingsOpen = useApp((s) => s.ui.settingsOpen)
  const { update, toggleSidebar, toggleInspector, openSettings, closeSettings, setPaletteOpen } =
    useApp.getState()
  const activeAgentId = useAgents((s) => s.activeAgentId)
  const activeStatus = useAgents((state) =>
    activeAgentId ? state.agents[activeAgentId]?.status : undefined
  )
  useToastInsetBottom(activeAgentId, !settingsOpen && activeStatus !== 'crashed')
  // First run (no workspace, no session): onboarding gets the whole window.
  const hasWorkspace = useApp((s) => s.prefs.activeWorkspace !== null) || activeAgentId !== null
  const sidebarOpen = sidebar.open && hasWorkspace
  const inspectorOpen = inspector.open && hasWorkspace
  const windowWidth = useWindowWidth()
  const layout = fitPanels(
    windowWidth.width,
    { open: sidebarOpen, width: sidebar.width, ...SIDEBAR_LIMITS },
    { open: inspectorOpen, width: inspector.width, ...INSPECTOR_LIMITS }
  )
  const inspectorDocked = inspectorOpen && !layout.inspectorOverlay
  useToastInsetRight(inspectorDocked && !settingsOpen ? layout.inspector.width : 0)
  // The inspector mounts on first open (and stays mounted so closing animates with its content).
  const [inspectorMounted, setInspectorMounted] = useState(inspectorOpen)
  if (inspectorOpen && !inspectorMounted) setInspectorMounted(true)
  const inspectorLoaded = inspectorPanel.useLoaded(inspectorMounted)
  // The sheet opens once its chunk is loaded (a few ms on the first open), fully rendered.
  const settingsLoaded = settingsSheet.useLoaded(settingsOpen)

  useHotkey('mod+k', () => setPaletteOpen(!useApp.getState().ui.paletteOpen))
  useHotkey('mod+b', () => toggleSidebar())
  useHotkey('mod+i', () => toggleInspector())
  useHotkey('mod+n', () => void newSession())
  useHotkey('mod+comma', () => openSettings())

  return (
    <div className="flex h-full flex-col" data-window-blurred={dimmed ? '' : undefined}>
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <SidePanel
          side="left"
          open={sidebarOpen}
          width={layout.sidebar.width}
          minWidth={SIDEBAR_LIMITS.minWidth}
          maxWidth={layout.sidebar.maxWidth}
          defaultWidth={Math.min(SIDEBAR_LIMITS.defaultWidth, layout.sidebar.maxWidth)}
          instant={windowWidth.resizing}
          label="Resize sidebar"
          className="transition-opacity duration-[var(--dur-panel)] window-blurred:opacity-80"
          onWidthChange={(width) =>
            update({ sidebar: { ...useApp.getState().prefs.sidebar, width } })
          }
        >
          <SessionSidebar />
        </SidePanel>
        {/* Workbench: one raised surface for the center pane + inspector, so corners and header hairlines never shift. Its top edge is the titlebar's hairline. */}
        <div
          data-sidebar-open={sidebarOpen || undefined}
          className="relative flex min-w-0 flex-1 overflow-hidden bg-[color-mix(in_oklab,var(--surface-1)_88%,transparent)] shadow-[-1px_0_0_var(--hairline-soft)] transition-[border-radius] duration-[var(--dur-panel)] data-[sidebar-open]:rounded-tl-card"
        >
          <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <CenterPane />
            <AnimatePresence>
              {inspectorOpen && layout.inspectorOverlay && (
                <motion.button
                  type="button"
                  aria-label="Hide inspector"
                  tabIndex={-1}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: duration.panel, ease: ease.out }}
                  onClick={() => toggleInspector()}
                  className="absolute inset-0 z-20 cursor-default bg-[color-mix(in_oklab,var(--overlay)_55%,transparent)]"
                />
              )}
            </AnimatePresence>
          </main>
          <SidePanel
            side="right"
            open={inspectorOpen}
            width={layout.inspector.width}
            minWidth={INSPECTOR_LIMITS.minWidth}
            maxWidth={layout.inspector.maxWidth}
            defaultWidth={Math.min(INSPECTOR_LIMITS.defaultWidth, layout.inspector.maxWidth)}
            overlay={layout.inspectorOverlay}
            instant={windowWidth.resizing}
            label="Resize inspector"
            className={
              layout.inspectorOverlay
                ? 'bg-surface-1 shadow-[inset_1px_0_0_var(--hairline),-24px_0_48px_-16px_rgba(0,0,0,0.55)]'
                : 'shadow-[inset_1px_0_0_var(--hairline-soft)]'
            }
            onWidthChange={(width) =>
              update({ inspector: { ...useApp.getState().prefs.inspector, width } })
            }
          >
            {inspectorMounted && inspectorLoaded && (
              <Suspense fallback={null}>
                <Inspector agentId={activeAgentId} width={layout.inspector.width} />
              </Suspense>
            )}
          </SidePanel>
        </div>
      </div>
      <Sheet
        open={settingsOpen && settingsLoaded}
        onOpenChange={(open) => (open ? openSettings() : closeSettings())}
        title="Settings"
      >
        <Suspense fallback={null}>
          <SettingsSheet />
        </Suspense>
      </Sheet>
    </div>
  )
}
