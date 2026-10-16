import { useState } from 'react'
import { ChevronRight, PanelRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useApp } from '../../store/app'
import { listRowClass } from '../../ui'
import { useNow } from './format'
import { openSubagentDetail } from './open'
import { AgentRow, ChildRows, runMenu } from './parts'
import { isUnseenFailure, useSubagentFleet, useSubagentsSlice, type SubagentRunView } from './store'

/** With more active runs than this, "Recent" starts collapsed. */
const RECENT_COLLAPSE_AT = 3

/** 400px fleet overview: active runs (workflow children one level deep), then recent finished runs. */
export function FleetPopover({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const slice = useSubagentsSlice(agentId)
  const { active, recent } = useSubagentFleet(agentId)
  const now = useNow(active.length > 0)
  const [recentOpen, setRecentOpen] = useState(active.length <= RECENT_COLLAPSE_AT)
  const running = active.filter((view) => view.state === 'running').length

  const open = (view: SubagentRunView, intent?: 'steer', childId?: string) => {
    onClose()
    openSubagentDetail(agentId, view.runId, childId, intent)
  }
  const row = (view: SubagentRunView) => (
    <div key={view.runId}>
      <AgentRow
        view={view}
        now={now}
        unseen={slice ? isUnseenFailure(view, slice) : false}
        onOpen={() => open(view)}
        menu={runMenu(agentId, view, (intent) => open(view, intent))}
      />
      {view.kind === 'workflow' && view.children.length > 0 && <ChildRows items={view.children} now={now} onOpen={(child) => open(view, undefined, child.id)} />}
    </div>
  )

  return (
    <div className="flex max-h-[420px] flex-col" data-fleet-popover>
      <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
        <span className="heading text-sm font-semibold text-fg">Agents</span>
        <span className="flex-1" />
        <span className="tabular text-xs text-fg-3">{running > 0 ? `${running} running` : active.length > 0 ? `${active.length} waiting` : 'none running'}</span>
      </div>
      <div className="-mx-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
        {active.map(row)}
        {recent.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={recentOpen}
              onClick={() => setRecentOpen((value) => !value)}
              className="mt-1 flex h-7 w-full items-center gap-1 rounded-md px-2.5 text-xs font-medium text-fg-3 hover:text-fg-2"
            >
              Recent
              <span className="tabular font-normal">· {recent.length}</span>
              <ChevronRight className={cn('ml-auto size-3.5 transition-transform duration-[var(--dur-fast)]', recentOpen && 'rotate-90')} />
            </button>
            {recentOpen && recent.map(row)}
          </>
        )}
      </div>
      <div className="mt-1 shrink-0 border-t border-hairline-soft pt-1">
        <button
          type="button"
          onClick={() => {
            onClose()
            useApp.getState().setInspectorTab('agents')
          }}
          className={cn(listRowClass({ density: 'menu' }), 'text-sm')}
        >
          <PanelRight className="size-4 text-fg-3" />
          Open agents panel
        </button>
      </div>
    </div>
  )
}
