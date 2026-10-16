import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronsUpDown, FolderPlus, Layers, RefreshCw, Search, X } from 'lucide-react'
import type { Workspace } from '@shared/api/app'
import { normalizeEngineId } from '@shared/api/engine'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '../../lib/cn'
import { basename } from '../../lib/format'
import { normalizePath, samePath } from '../../lib/paths'
import { useAgents } from '../../store/agents'
import { selectActiveWorkspace, useApp } from '../../store/app'
import { Avatar, Badge, Input, ListRow, listRowClass, Popover, Skeleton } from '../../ui'
import { chooseWorkspace } from '../shell/workspace'
import { EnginePicker } from '../engines/EnginePicker'
import { switchWorkspace } from './actions'
import { liveState, matchesQuery } from './model'
import { setScope, useSessions, useSessionsPrefs } from './store'
import { WindowedList } from './WindowedList'

interface WorkspaceActivity {
  running: number
  waiting: number
  finished: number
}

const NO_ACTIVITY: WorkspaceActivity = { running: 0, waiting: 0, finished: 0 }

/**
 * Open sessions per workspace (normalized path) that are working, waiting for input, or finished unseen: the sidebar
 * lists only the active workspace's sessions, so the switcher says where the rest stand. Recomputed only when a live
 * state, an unread mark or a folder changes.
 */
function useActivityByWorkspace(): Map<string, WorkspaceActivity> {
  const unread = useSessions((s) => s.unread)
  const states = useAgents(
    useShallow((s) =>
      s.order.flatMap((id) => {
        const agent = s.agents[id]
        return agent ? [`${liveState(agent)}|${id}|${normalizePath(agent.info.cwd)}`] : []
      })
    )
  )
  const activity = new Map<string, WorkspaceActivity>()
  for (const entry of states) {
    const [state, id, key] = entry.split('|') as [string, string, string]
    const counts = { ...(activity.get(key) ?? NO_ACTIVITY) }
    if (state === 'waiting') counts.waiting++
    else if (state === 'running') counts.running++
    else if (unread[id]) counts.finished++
    activity.set(key, counts)
  }
  return activity
}

function ActivityBadge({ activity }: { activity: WorkspaceActivity }) {
  if (activity.waiting > 0) {
    return (
      <Badge tone="warning" dot aria-label={`${activity.waiting} need input`}>
        {activity.waiting}
      </Badge>
    )
  }
  if (activity.running > 0) {
    return (
      <Badge dot aria-label={`${activity.running} working`}>
        {activity.running}
      </Badge>
    )
  }
  if (activity.finished > 0) {
    return (
      <Badge tone="info" dot aria-label={`${activity.finished} finished`}>
        {activity.finished}
      </Badge>
    )
  }
  return null
}

function WorkspaceItem({
  workspace,
  active,
  activity,
  onPick,
  onRemove
}: {
  workspace: Workspace
  active: boolean
  activity: WorkspaceActivity
  onPick: () => void
  onRemove: () => void
}) {
  const name = workspace.name || basename(workspace.path)
  return (
    <div className="group/ws relative">
      <button
        type="button"
        data-workspace-choice
        onClick={onPick}
        aria-current={active || undefined}
        title={workspace.path}
        className={cn(listRowClass({ density: 'list', selected: active }), 'pr-14')}
      >
        <Avatar name={name} size={20} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate leading-4">{name}</span>
          <span className="truncate text-2xs leading-3.5 font-normal text-fg-3">
            {workspace.path}
          </span>
        </span>
      </button>
      <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 transition-opacity group-hover/ws:opacity-0">
        <ActivityBadge activity={activity} />
      </span>
      <button
        type="button"
        aria-label={`Hide ${name} from workspaces`}
        title="Hide workspace"
        onClick={onRemove}
        className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-3 opacity-0 transition-opacity group-hover/ws:opacity-100 hover:bg-active hover:text-fg focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/** Known folders stay available while session-history discovery runs in the background. */
export function WorkspaceSwitcher() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const workspaces = useApp((s) => s.prefs.workspaces)
  const discovery = useApp((s) => s.workspaceDiscovery)
  const discoveryError = useApp((s) => s.workspaceDiscoveryError)
  const active = useApp(selectActiveWorkspace)
  const { scope } = useSessionsPrefs()
  const activity = useActivityByWorkspace()
  const activityIn = (path: string) => activity.get(normalizePath(path)) ?? NO_ACTIVITY
  const label =
    scope === 'all'
      ? 'All workspaces'
      : active
        ? active.name || basename(active.path)
        : 'No workspace'
  const sorted = useMemo(
    () => [...workspaces].sort((first, second) => second.lastOpenedAt - first.lastOpenedAt),
    [workspaces]
  )
  const visible = sorted.filter((workspace) => matchesQuery(query, workspace.name, workspace.path))
  const loading = discovery === 'idle' || discovery === 'loading'

  function pickWorkspace(workspace: Workspace): void {
    setOpen(false)
    setQuery('')
    setScope('workspace')
    if (!samePath(workspace.path, active?.path)) void switchWorkspace(workspace.path)
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const choices = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[data-workspace-choice]') ?? []
    )
    if (choices.length === 0) return
    event.preventDefault()
    const current = choices.indexOf(document.activeElement as HTMLButtonElement)
    if (current === -1) {
      choices[event.key === 'ArrowDown' ? 0 : choices.length - 1]?.focus()
      return
    }
    const next = current + (event.key === 'ArrowDown' ? 1 : -1)
    choices[(next + choices.length) % choices.length]?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      align="start"
      className="w-[340px] max-w-[calc(100vw-24px)] p-1.5"
      trigger={
        <button
          type="button"
          aria-label="Switch workspace"
          className="group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-hover data-[state=open]:bg-active"
        >
          {scope === 'all' ? (
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-sm bg-surface-3 text-fg-2 shadow-elev-1">
              <Layers className="size-3.5" />
            </span>
          ) : (
            <Avatar name={label} size={22} />
          )}
          <span className="heading min-w-0 flex-1 truncate text-ui font-semibold text-fg">
            {label}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-3 transition-colors group-hover:text-fg-2" />
        </button>
      }
    >
      <div className="flex items-center justify-between px-2 pt-1 pb-2 text-xs font-medium text-fg-3">
        <span>Workspaces</span>
        <span className="tabular">{workspaces.length || ''}</span>
      </div>
      <div className="px-1 pb-2">
        <Input
          inputSize="sm"
          aria-label="Find workspace"
          placeholder="Find workspace…"
          leading={<Search />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              list.current?.querySelector<HTMLButtonElement>('[data-workspace-choice]')?.focus()
            } else if (event.key === 'Enter' && visible.length === 1) {
              event.preventDefault()
              pickWorkspace(visible[0]!)
            } else if (event.key === 'Escape' && query) {
              event.stopPropagation()
              setQuery('')
            }
          }}
        />
      </div>
      <div
        ref={list}
        onKeyDown={moveFocus}
        aria-label="Workspaces"
        aria-busy={loading}
        data-workspace-list
        className="flex max-h-[min(320px,45vh)] flex-col gap-px overflow-y-auto"
      >
        <WindowedList
          items={visible}
          itemKey={(workspace) => workspace.path}
          scrollSelector="[data-workspace-list]"
          focusSelector="[data-workspace-choice]"
          wrapFocus
        >
          {(workspace) => (
            <WorkspaceItem
              key={workspace.path}
              workspace={workspace}
              active={scope === 'workspace' && samePath(workspace.path, active?.path)}
              activity={activityIn(workspace.path)}
              onPick={() => pickWorkspace(workspace)}
              onRemove={() => useApp.getState().removeWorkspace(workspace.path)}
            />
          )}
        </WindowedList>
        {loading && sorted.length === 0 && (
          <div
            className="flex flex-col gap-3 px-2 py-2"
            role="status"
            aria-label="Finding workspaces"
          >
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {visible.length === 0 && sorted.length > 0 && (
          <div role="status" className="px-2 py-3 text-sm text-fg-2">
            No workspaces match “{query}”.
          </div>
        )}
        {!loading && sorted.length === 0 && discovery !== 'error' && (
          <div className="px-2 py-3 text-sm leading-relaxed text-fg-2">
            Open a folder to start your first workspace.
          </div>
        )}
      </div>
      {loading && sorted.length > 0 && (
        <div role="status" className="px-2 pt-2 text-xs text-fg-3">
          Checking saved workspaces…
        </div>
      )}
      {discovery === 'error' && (
        <div className="flex items-center gap-2 px-2 pt-2 text-xs text-fg-2">
          <span className="min-w-0 flex-1" title={discoveryError ?? undefined}>
            Could not check saved workspaces.
          </span>
          <button
            type="button"
            onClick={() => void useApp.getState().discoverWorkspaces()}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 hover:bg-hover"
          >
            <RefreshCw className="size-3" />
            Retry
          </button>
        </div>
      )}
      <div className="mx-1 my-1.5 h-px bg-hairline" />
      {active && (
        <div className="mx-1 mb-1.5 flex items-center justify-between gap-3 px-1 py-1">
          <span className="text-xs text-fg-2">New session default</span>
          <EnginePicker
            value={normalizeEngineId(active.engine)}
            onValueChange={(engine) => useApp.getState().setWorkspaceEngine(active.path, engine)}
            label="Engine for new sessions"
            className="h-7 gap-1.5 px-2 text-xs [&>svg]:size-3"
          />
        </div>
      )}
      <ListRow
        icon={<Layers />}
        title="All workspaces"
        trailing={scope === 'all' ? <Check className="size-3.5 text-fg-2" /> : undefined}
        onClick={() => {
          setOpen(false)
          setQuery('')
          setScope('all')
        }}
      />
      <ListRow
        icon={<FolderPlus />}
        title="Open folder…"
        onClick={() => {
          setOpen(false)
          setQuery('')
          setScope('workspace')
          void chooseWorkspace()
        }}
      />
    </Popover>
  )
}
