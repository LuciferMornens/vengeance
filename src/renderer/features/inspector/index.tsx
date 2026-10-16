/** Inspector feature: right panel with Overview, Agents, Branches, Tools, Files, Timeline and Extensions tabs. */
import {
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type KeyboardEvent
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Activity,
  Bot,
  Files as FilesIcon,
  Gauge,
  ListTree,
  Puzzle,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { spring } from '../../lib/motion'
import type { AgentState } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, IconButton, Tooltip } from '../../ui'
import { openPrimeControls } from '../engines/prime-controls'
import { useEngineCapabilities } from '../engines/registry'
import { useAgentsTabAlert } from '../subagents'
import { fileActivity, toolActivity } from './activity'
import { Branches } from './Branches'
import { Extensions } from './Extensions'
import { Files } from './Files'
import { Overview } from './Overview'
import { TabEmpty } from './parts'
import { Timeline } from './Timeline'
import { Tools } from './Tools'

type TabId = 'overview' | 'agents' | 'branches' | 'tools' | 'files' | 'timeline' | 'extensions'

const agentsPanel = lazyWithPreload(() =>
  import('../subagents/AgentsPanel').then((m) => m.AgentsPanel)
)
const AgentsPanel = agentsPanel.Component

interface TabDef {
  id: TabId
  label: string
  icon: typeof Gauge
  View: ComponentType<{ agent: AgentState }>
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: Gauge, View: Overview },
  { id: 'agents', label: 'Agents', icon: Bot, View: AgentsPanel },
  { id: 'branches', label: 'Branches', icon: ListTree, View: Branches },
  { id: 'tools', label: 'Tools', icon: SlidersHorizontal, View: Tools },
  { id: 'files', label: 'Files', icon: FilesIcon, View: Files },
  { id: 'timeline', label: 'Timeline', icon: Activity, View: Timeline },
  { id: 'extensions', label: 'Extensions', icon: Puzzle, View: Extensions }
]

/** Room for one labelled tab (icon, longest label, gap): all labels show once every tab fits. */
const LABELLED_TAB_WIDTH = 92

/** A count badge, or (without `text`) a 6px dot that shows in every layout. */
type Badges = Partial<Record<TabId, { text?: string; tone: 'neutral' | 'warning' | 'danger' }>>

const NO_BADGES: Badges = {}

/**
 * Tab badges; recomputed only when committed messages or tool executions change (never per streamed token), and not
 * at all while the panel is hidden.
 */
function useBadges(agent: AgentState | undefined, visible: boolean): Badges {
  const entries = agent?.entries
  const tools = agent?.tools
  const extensionErrors = agent?.extensionErrors.length ?? 0
  const cwd = agent?.info.cwd
  const agents = useAgentsTabAlert(agent?.id)
  return useMemo(() => {
    if (!visible || !entries || !tools || cwd === undefined) return NO_BADGES
    const activity = toolActivity({ entries, streaming: null, tools })
    const files = fileActivity(cwd, activity).length
    const toolErrors = activity.filter((a) => a.isError).length
    return {
      files: files ? { text: String(files), tone: 'neutral' } : undefined,
      timeline: toolErrors ? { text: String(toolErrors), tone: 'danger' } : undefined,
      extensions: extensionErrors ? { text: String(extensionErrors), tone: 'danger' } : undefined,
      agents: agents ? { tone: agents } : undefined
    }
  }, [visible, entries, tools, extensionErrors, cwd, agents])
}

const DOT_TONE = { neutral: 'bg-fg-3', warning: 'bg-warning', danger: 'bg-danger' } as const
const BADGE_WORD = { neutral: 'new', warning: 'needs you', danger: 'failed' } as const

const selectTab = (next: TabId) => useApp.getState().setInspectorTab(next)

const TabBar = memo(function TabBar({
  tab,
  tabs,
  onChange,
  badges,
  wide
}: {
  tab: TabId
  tabs: TabDef[]
  onChange: (tab: TabId) => void
  badges: Badges
  wide: boolean
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const index = tabs.findIndex((t) => t.id === tab)
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!
    onChange(next.id)
    refs.current[tabs.indexOf(next)]?.focus()
  }
  return (
    <div
      role="tablist"
      aria-label="Inspector"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-1 items-center gap-0.5"
    >
      {tabs.map((t, i) => {
        const active = t.id === tab
        const badge = badges[t.id]
        const button = (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={
              badge && !active && !wide
                ? `${t.label} (${badge.text ?? BADGE_WORD[badge.tone]})`
                : t.label
            }
            data-tab={t.id}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors duration-[var(--dur-fast)] [&>svg]:size-3.5',
              active ? 'text-fg' : 'text-fg-3 hover:bg-hover hover:text-fg-2'
            )}
          >
            {active && (
              <motion.span
                layoutId="inspector-tab"
                transition={spring.snappy}
                className="absolute inset-0 rounded-md bg-surface-3 shadow-elev-1"
              />
            )}
            <t.icon className="relative" />
            {(active || wide) && (
              <motion.span
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="relative"
              >
                {t.label}
              </motion.span>
            )}
            {badge &&
              (badge.text === undefined ? (
                <span
                  aria-hidden
                  data-tab-dot={badge.tone}
                  className={cn('relative size-1.5 rounded-full', DOT_TONE[badge.tone])}
                />
              ) : active || wide ? (
                <span
                  className={cn(
                    'tabular relative min-w-[16px] rounded-full px-1 text-center text-2xs leading-4 font-semibold',
                    badge.tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-hover text-fg-3'
                  )}
                >
                  {badge.text}
                </span>
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1 right-1 size-1.5 rounded-full shadow-[0_0_0_2px_var(--surface-1)]',
                    DOT_TONE[badge.tone]
                  )}
                />
              ))}
          </button>
        )
        return active || wide ? (
          button
        ) : (
          <Tooltip key={t.id} content={t.label}>
            {button}
          </Tooltip>
        )
      })}
    </div>
  )
})

/** `width` is the panel's drawn width, which the shell may narrow below the saved preference. */
export function Inspector({ agentId, width }: { agentId: string | null; width: number }) {
  const agent = useAgents((s) => (agentId ? s.agents[agentId] : undefined))
  const stored = useApp((s) => s.prefs.inspector.tab)
  const open = useApp((s) => s.prefs.inspector.open)
  const engine = agent?.info.engine ?? 'pi'
  const capabilities = useEngineCapabilities(engine)
  const tabs = useMemo(
    () =>
      TABS.filter((item) => {
        if (item.id === 'agents') return engine === 'pi' && capabilities?.subagents !== false
        if (item.id === 'tools') return engine === 'pi'
        if (item.id === 'extensions') return engine === 'pi' && capabilities?.extensionUi !== false
        if (item.id === 'branches') return capabilities?.sessions.tree !== false
        return true
      }),
    [engine, capabilities]
  )
  const tab: TabId = tabs.some((item) => item.id === stored) ? (stored as TabId) : 'overview'
  const badges = useBadges(agent, open)
  // Slide direction follows tab order (committed tab is updated after render).
  const previous = useRef(tab)
  const direction =
    tabs.findIndex((t) => t.id === tab) >= tabs.findIndex((t) => t.id === previous.current) ? 1 : -1
  useEffect(() => {
    previous.current = tab
  }, [tab])
  const View = tabs.find((t) => t.id === tab)!.View
  // The Agents tab's panel shows once its chunk is loaded (see lazyWithPreload).
  const agentsLoaded = agentsPanel.useLoaded(tab === 'agents')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[var(--pane-header-h)] shrink-0 items-center gap-1 border-b border-hairline-soft pr-2 pl-3">
        <TabBar
          tab={tab}
          tabs={tabs}
          onChange={selectTab}
          badges={badges}
          wide={width >= tabs.length * LABELLED_TAB_WIDTH}
        />
        {/* The session header toggles the inspector; without a session there is no header, so offer a close here. */}
        {!agent && (
          <IconButton
            label="Close inspector"
            hotkey="mod+i"
            size="xs"
            onClick={() => useApp.getState().toggleInspector(false)}
          >
            <X />
          </IconButton>
        )}
      </div>
      {agent && engine === 'prime' && (
        <div className="flex shrink-0 border-b border-hairline-soft px-3 py-2">
          <Button
            size="sm"
            variant="ghost"
            leading={<SlidersHorizontal />}
            onClick={() => openPrimeControls(agent.id, 'subagents')}
          >
            Engine controls
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {!agent ? (
          <TabEmpty icon={<Gauge />} title="No session">
            Open a session to see its stats, branches, tools, files and activity.
          </TabEmpty>
        ) : (
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={`${agent.id}:${tab}`}
              role="tabpanel"
              aria-label={tabs.find((t) => t.id === tab)!.label}
              custom={direction}
              variants={{
                enter: (d: number) => ({ opacity: 0, x: d * 14 }),
                center: { opacity: 1, x: 0 },
                exit: (d: number) => ({ opacity: 0, x: d * -10 })
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={spring.smooth}
              className="absolute inset-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
            >
              <Suspense fallback={null}>
                {(tab !== 'agents' || agentsLoaded) && <View agent={agent} />}
              </Suspense>
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
