import { Fragment, useEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, FolderOpen, Pin, Search, Settings, Trash2, X } from 'lucide-react'
import type { OpenSessionRef } from '@shared/api/app'
import { ENGINE_LABELS, normalizeEngineId } from '@shared/api/engine'
import type { SessionListItem } from '@shared/api/sessions'
import { cn } from '../../lib/cn'
import { basename, pluralize } from '../../lib/format'
import { spring } from '../../lib/motion'
import { normalizePath, samePath } from '../../lib/paths'
import { useAgents, type AgentsStore } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, IconButton, Input, Tooltip } from '../../ui'
import { chooseWorkspace } from '../shell/workspace'
import {
  activateAgent,
  openSession,
  prewarmSavedSession,
  renameSession,
  requestCloseAgent
} from './actions'
import { LiveDot } from './LiveDot'
import { NewSessionActions } from './NewSessionActions'
import { historyMenu, openAgentMenu } from './menus'
import {
  agentMessageCount,
  agentOwnTitle,
  agentSearchText,
  agentSessionFile,
  DATE_GROUPS,
  dateGroup,
  generatedChildName,
  itemTitle,
  LIVE_LABEL,
  liveState,
  matchesQuery,
  shortTime
} from './model'
import { useSessionPaletteActions } from './palette-actions'
import { SessionDialogs } from './SessionDialogs'
import { SectionHeader, SessionListFeedback, WorkspaceSection } from './SessionListParts'
import { SessionRow } from './SessionRow'
import { resumeDormant } from './restore'
import {
  dismissDormant,
  findListed,
  listKey,
  startSessionsTracking,
  togglePinned,
  useSessions,
  useSessionsPrefs
} from './store'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { BackgroundSessions } from './BackgroundSessions'
import { WindowedList } from './WindowedList'
import { inWorkspaceView } from './workspace-view'

const WORKSPACE_GROUP_HEIGHT = 294

/** Ids of agents that exist (order can briefly name one being disposed). */
function openIdsOf(s: AgentsStore): string[] {
  return s.order.filter((id) => !!s.agents[id])
}

function someMatch(query: string, items: SessionListItem[] | undefined): boolean {
  return !!items?.some((item) => matchesQuery(query, itemTitle(item), item.searchText))
}

function workspaceName(cwd: string, workspaces: { path: string; name: string }[]): string {
  return workspaces.find((w) => samePath(w.path, cwd))?.name || basename(cwd) || 'Unknown folder'
}

/** Child sessions of subagent runs under their parent's row: one quiet line, expanded on demand (or while searching). */
function SubagentSessions({ items, searching }: { items: SessionListItem[]; searching: boolean }) {
  const expansionKey = `subagents:${normalizePath(items[0]?.subagentRun?.parentPath ?? '')}`
  const expanded = useSessions((state) => state.expandedLists.includes(expansionKey))
  const shown = expanded || searching
  return (
    <>
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => useSessions.getState().toggleExpanded(expansionKey)}
        className="mx-2 flex h-6 w-[calc(100%-16px)] items-center gap-1.5 rounded-md pl-[30px] text-xs text-fg-3 hover:bg-hover hover:text-fg-2"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform duration-[var(--dur-fast)]',
            shown && 'rotate-90'
          )}
        />
        {pluralize(items.length, 'subagent session')}
      </button>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.panel}
            className="overflow-hidden pl-4"
          >
            <WindowedList items={items} itemKey={(item) => item.path}>
              {(item) => <HistoryRow item={item} pinned={false} />}
            </WindowedList>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

interface SubagentRowProps {
  /** Subagent child sessions stored under this one. */
  subagents?: SessionListItem[]
  /** The search matches one of them (they show expanded). */
  searching?: boolean
}

interface HistoryRowProps extends SubagentRowProps {
  item: SessionListItem
  pinned: boolean
  showWorkspace?: string
}

function HistoryRow({
  item,
  pinned,
  showWorkspace,
  subagents,
  searching = false
}: HistoryRowProps) {
  const title = itemTitle(item)
  const target = { path: item.path, cwd: item.cwd, title, engine: item.engine }
  return (
    <>
      <SessionRow
        rowKey={item.path}
        title={title}
        titleTooltip={generatedChildName(item.name)}
        leading={
          pinned ? <Pin aria-label="Pinned" className="size-3 -rotate-45 text-fg-3" /> : undefined
        }
        meta={
          <>
            <span className="tabular">{pluralize(item.messageCount, 'message')}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{ENGINE_LABELS[normalizeEngineId(item.engine)]}</span>
            {showWorkspace && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{showWorkspace}</span>
              </>
            )}
          </>
        }
        trailing={shortTime(item.modifiedAt)}
        actions={
          <IconButton
            label={pinned ? 'Unpin' : 'Pin'}
            size="xs"
            onClick={() => togglePinned(item.path)}
            className="bg-[var(--bg)] hover:bg-surface-3"
          >
            <Pin className={cn('-rotate-45', pinned && 'fill-current')} />
          </IconButton>
        }
        menu={historyMenu(item, pinned)}
        deferOpen
        onOpen={() => void openSession(item)}
        onRename={(name) => void renameSession(target, name)}
        onDelete={() => useSessions.getState().openDialog({ kind: 'delete', target })}
        onIntent={() => prewarmSavedSession(target)}
      />
      {subagents && subagents.length > 0 && (
        <SubagentSessions items={subagents} searching={searching} />
      )}
    </>
  )
}

/**
 * An open agent's row. Subscribes to its own agent with primitive selectors (state, title, message count…), so a
 * streaming frame re-renders this row only when something it shows actually changed.
 */
function OpenRow({
  agentId,
  listing,
  active,
  pinned,
  foreignWorkspace
}: {
  agentId: string
  listing?: SessionListItem
  active: boolean
  pinned: boolean
  foreignWorkspace?: string
}) {
  const unread = useSessions((s) => !!s.unread[agentId])
  const state = useAgents((s) => (s.agents[agentId] ? liveState(s.agents[agentId]) : 'idle'))
  const ownTitle = useAgents((s) => (s.agents[agentId] ? agentOwnTitle(s.agents[agentId]) : null))
  const rawName = useAgents(
    (s) =>
      generatedChildName(s.agents[agentId]?.sessionName) ??
      (listing ? generatedChildName(listing.name) : undefined)
  )
  const messages = useAgents((s) => (s.agents[agentId] ? agentMessageCount(s.agents[agentId]) : 0))
  const path = useAgents((s) =>
    s.agents[agentId] ? agentSessionFile(s.agents[agentId]) : undefined
  )
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd ?? '')
  const ephemeral = useAgents((s) => s.agents[agentId]?.info.args.noSession === true)
  const engine = useAgents((s) => s.agents[agentId]?.info.engine)
  const title = ownTitle ?? (listing ? itemTitle(listing) : 'New session')
  const target = { agentId, path, cwd, title, engine }
  const idle = unread
    ? 'Finished'
    : messages > 0
      ? pluralize(messages, 'message')
      : ephemeral
        ? 'Ephemeral'
        : 'Empty'
  const status = state === 'idle' ? (ephemeral ? `${idle} · not saved` : idle) : LIVE_LABEL[state]
  return (
    <SessionRow
      rowKey={`agent:${agentId}`}
      title={title}
      titleTooltip={rawName}
      active={active}
      leading={<LiveDot state={state} unread={unread} />}
      meta={
        <>
          <span
            className={cn(
              'truncate',
              state === 'running' && 'text-accent-text',
              state === 'waiting' && 'text-warning',
              state === 'crashed' && 'text-danger',
              unread && state === 'idle' && 'text-info'
            )}
          >
            {status}
          </span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{ENGINE_LABELS[normalizeEngineId(engine)]}</span>
          {foreignWorkspace && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{foreignWorkspace}</span>
            </>
          )}
        </>
      }
      wideActions={!!path}
      actions={
        <>
          {path && (
            <IconButton
              label="Delete session"
              size="xs"
              onClick={() =>
                useSessions.getState().openDialog({ kind: 'delete', target: { ...target, path } })
              }
              className="bg-[var(--bg)] hover:bg-surface-3 hover:text-danger"
            >
              <Trash2 />
            </IconButton>
          )}
          <Tooltip
            content={
              engine === 'prime' && !ephemeral
                ? 'Close tab — session keeps running in Background sessions'
                : ephemeral
                  ? 'Close tab — stops this temporary session'
                  : 'Close tab'
            }
          >
            <IconButton
              label="Close tab"
              tooltip={false}
              size="xs"
              onClick={() => requestCloseAgent(agentId)}
              className="bg-[var(--bg)] hover:bg-surface-3"
            >
              <X />
            </IconButton>
          </Tooltip>
        </>
      }
      menu={openAgentMenu(target, pinned)}
      onOpen={() => activateAgent(agentId)}
      onRename={(name) => void renameSession(target, name)}
      onDelete={
        path
          ? () => useSessions.getState().openDialog({ kind: 'delete', target: { ...target, path } })
          : undefined
      }
    />
  )
}

interface DormantRowProps extends SubagentRowProps {
  session: OpenSessionRef
  listing?: SessionListItem
  pinned: boolean
  foreignWorkspace?: string
}

/** A session that was open at the last quit and has not been resumed: an open row without an engine, quieter. */
function DormantRow({
  session,
  listing,
  pinned,
  foreignWorkspace,
  subagents,
  searching = false
}: DormantRowProps) {
  const title = listing ? itemTitle(listing) : 'Untitled session'
  const target = { path: session.path, cwd: session.cwd, title, engine: session.engine }
  return (
    <>
      <SessionRow
        rowKey={session.path}
        title={title}
        titleTooltip={listing ? generatedChildName(listing.name) : undefined}
        quiet
        meta={
          <>
            {listing && (
              <span className="tabular">{pluralize(listing.messageCount, 'message')}</span>
            )}
            {listing && <span aria-hidden>·</span>}
            <span className="shrink-0">{ENGINE_LABELS[normalizeEngineId(session.engine)]}</span>
            {foreignWorkspace && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{foreignWorkspace}</span>
              </>
            )}
          </>
        }
        actions={
          <IconButton
            label="Close tab"
            size="xs"
            onClick={() => dismissDormant(session.path)}
            className="bg-[var(--bg)] hover:bg-surface-3"
          >
            <X />
          </IconButton>
        }
        menu={listing ? historyMenu(listing, pinned) : []}
        deferOpen
        onOpen={() => resumeDormant(session)}
        onRename={(name) => void renameSession(target, name)}
        onDelete={() => useSessions.getState().openDialog({ kind: 'delete', target })}
        onIntent={() => prewarmSavedSession(target)}
      />
      {subagents && subagents.length > 0 && (
        <SubagentSessions items={subagents} searching={searching} />
      )}
    </>
  )
}

function SearchField() {
  const query = useSessions((s) => s.query)
  const setQuery = useSessions((s) => s.setQuery)
  const nonce = useSessions((s) => s.searchFocusNonce)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (nonce > 0) {
      // Let the sidebar finish opening before taking focus.
      const t = setTimeout(() => ref.current?.focus(), 60)
      return () => clearTimeout(t)
    }
  }, [nonce])
  return (
    <Input
      ref={ref}
      inputSize="sm"
      value={query}
      placeholder="Search sessions"
      aria-label="Search sessions"
      leading={<Search />}
      trailing={
        query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery('')}
            className="rounded-xs p-0.5 text-fg-3 hover:bg-active hover:text-fg"
          >
            <X className="size-3" />
          </button>
        ) : undefined
      }
      onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && query) {
          e.stopPropagation()
          setQuery('')
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          document.querySelector<HTMLElement>('[data-session-list] [data-session-row]')?.focus()
        }
      }}
      className="bg-transparent [&_input]:bg-[color-mix(in_oklab,var(--surface-2)_60%,transparent)] [&_input]:shadow-[inset_0_0_0_1px_var(--hairline)]"
    />
  )
}

/** Roving arrow-key focus between session rows. */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-session-row]')]
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  event.preventDefault()
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next) next.focus()
  else if (event.key === 'ArrowUp')
    document.querySelector<HTMLInputElement>('input[aria-label="Search sessions"]')?.focus()
}

/** Left sidebar: workspace switcher, open agents, pinned + dated session history, search, footer. */
export function SessionSidebar() {
  useEffect(() => startSessionsTracking(), [])
  useSessionPaletteActions()

  const { pinned: pinnedPaths, scope, collapsed } = useSessionsPrefs()
  const workspaces = useApp((s) => s.prefs.workspaces)
  const activeWorkspace = useApp((s) => s.prefs.activeWorkspace)
  // Per-agent strings only (shallow-compared), never the agents map: streaming frames don't re-render the list.
  const openIds = useAgents(useShallow(openIdsOf))
  const openCwds = useAgents(useShallow((s) => openIdsOf(s).map((id) => s.agents[id]!.info.cwd)))
  const openFileList = useAgents(
    useShallow((s) => openIdsOf(s).map((id) => agentSessionFile(s.agents[id]!) ?? ''))
  )
  const openTitles = useAgents(
    useShallow((s) => openIdsOf(s).map((id) => agentOwnTitle(s.agents[id]!) ?? ''))
  )
  const activeAgentId = useAgents((s) => s.activeAgentId)
  const query = useSessions((s) => s.query)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Transcript text only while searching (cached per transcript, so streaming frames stay cheap).
  const openSearchTexts = useAgents(
    useShallow((s) =>
      query.trim() ? openIdsOf(s).map((id) => agentSearchText(s.agents[id]!)) : []
    )
  )
  const load = useSessions((s) => s.load)
  const lists = useSessions((s) => s.lists)
  const dormant = useSessions((s) => s.dormant)
  const background = useSessions((s) => s.background)

  const listCwd = scope === 'all' ? null : activeWorkspace
  const list = useSessions((s) =>
    scope === 'all' || listCwd ? s.lists[listKey(listCwd)] : undefined
  )

  useEffect(() => {
    if (scope === 'all' || listCwd) void load(listCwd)
  }, [scope, listCwd, load])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [scope, listCwd, query])

  const pinned = useMemo(() => new Set(pinnedPaths.map(normalizePath)), [pinnedPaths])
  const listed = list?.items
  const byPath = useMemo(
    () => new Map((listed ?? []).map((i) => [normalizePath(i.path), i])),
    [listed]
  )
  // Subagent child sessions are shown under their parent's row when the parent is listed too.
  const { items, subagentsByParent } = useMemo(() => {
    const topLevel: SessionListItem[] = []
    const children = new Map<string, SessionListItem[]>()
    for (const item of listed ?? []) {
      const parent = item.subagentRun ? normalizePath(item.subagentRun.parentPath) : undefined
      if (!parent || !byPath.has(parent)) {
        topLevel.push(item)
        continue
      }
      const siblings = children.get(parent)
      if (siblings) siblings.push(item)
      else children.set(parent, [item])
    }
    return { items: topLevel, subagentsByParent: children }
  }, [listed, byPath])
  const subagentsOf = (path: string): SubagentRowProps => {
    const subagents = subagentsByParent.get(normalizePath(path))
    return { subagents, searching: !!query.trim() && someMatch(query, subagents) }
  }

  const inView = (cwd: string) => inWorkspaceView(cwd, { scope, activeWorkspace, workspaces })
  const open = openIds.map((id, i) => {
    const file = openFileList[i] || undefined
    const listing = file ? byPath.get(normalizePath(file)) : undefined
    return {
      id,
      cwd: openCwds[i] ?? '',
      file,
      listing,
      title: openTitles[i] || (listing ? itemTitle(listing) : 'New session'),
      searchText: openSearchTexts[i]
    }
  })
  const visibleOpen = open.filter(
    (a) => inView(a.cwd) && matchesQuery(query, a.title, a.searchText)
  )
  const runningFiles = new Set(openFileList.filter(Boolean).map(normalizePath))
  const backgroundFiles = new Set(
    background.flatMap((agent) => (agent.sessionPath ? [normalizePath(agent.sessionPath)] : []))
  )
  const visibleDormant = dormant
    .filter((session) => inView(session.cwd))
    .filter((session) => !backgroundFiles.has(normalizePath(session.path)))
    .filter((session) => !runningFiles.has(normalizePath(session.path)))
    .map((session) => ({ session, listing: findListed(lists, session.path) }))
    .filter(({ listing }) =>
      matchesQuery(query, listing ? itemTitle(listing) : '', listing?.searchText)
    )
  const openCount = visibleOpen.length + visibleDormant.length
  // A string key (not a Set) so the history memo only recomputes when the set of open files really changes.
  const openFilesKey = [
    ...openFileList.filter(Boolean),
    ...dormant.map((session) => session.path),
    ...background.flatMap((agent) => (agent.sessionPath ? [agent.sessionPath] : []))
  ]
    .map(normalizePath)
    .join('|')
  const { pinnedItems, rest } = useMemo(() => {
    const openFiles = new Set(openFilesKey.split('|'))
    // A parent also matches through its subagent sessions (they show expanded under it).
    const matches = (item: SessionListItem) =>
      someMatch(query, [item]) || someMatch(query, subagentsByParent.get(normalizePath(item.path)))
    const history = items.filter((i) => !openFiles.has(normalizePath(i.path)) && matches(i))
    return {
      pinnedItems: history.filter((i) => pinned.has(normalizePath(i.path))),
      rest: history.filter((i) => !pinned.has(normalizePath(i.path)))
    }
  }, [items, subagentsByParent, openFilesKey, query, pinned])
  const historyCount = pinnedItems.length + rest.length

  const now = new Date()
  const dated = DATE_GROUPS.map((group) => ({
    group,
    items: rest.filter((i) => dateGroup(i.modifiedAt, now) === group)
  })).filter((g) => g.items.length > 0)
  const byWorkspace = useMemo(() => {
    const groups = new Map<string, { cwd: string; items: SessionListItem[] }>()
    for (const item of rest) {
      const key = normalizePath(item.cwd || '?')
      const group = groups.get(key) ?? { cwd: item.cwd, items: [] }
      group.items.push(item)
      groups.set(key, group)
    }
    return [...groups.values()].sort(
      (a, b) => (b.items[0]?.modifiedAt ?? 0) - (a.items[0]?.modifiedAt ?? 0)
    )
  }, [rest])

  const loading = (scope === 'all' || !!listCwd) && (!list || !list.loaded)
  const hasBackgroundMatch = background.some((agent) =>
    matchesQuery(query, agent.name, agent.cwd, agent.status)
  )
  const nothing = !loading && historyCount === 0 && openCount === 0 && !hasBackgroundMatch

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <WorkspaceSwitcher />
        <NewSessionActions />
      </div>
      <div className="px-3 pt-2 pb-1.5">
        <SearchField />
      </div>

      <LayoutGroup>
        <div
          ref={scrollRef}
          data-session-list
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3 [scrollbar-gutter:stable]"
        >
          {openCount > 0 && (
            <section aria-label="Open sessions">
              <SectionHeader label="Open" count={openCount} />
              {visibleOpen.map((agent) => {
                const { subagents, searching } = agent.file ? subagentsOf(agent.file) : {}
                return (
                  <Fragment key={agent.id}>
                    <OpenRow
                      agentId={agent.id}
                      listing={agent.listing}
                      active={agent.id === activeAgentId}
                      pinned={!!agent.file && pinned.has(normalizePath(agent.file))}
                      foreignWorkspace={
                        scope === 'all' || !samePath(agent.cwd, activeWorkspace)
                          ? workspaceName(agent.cwd, workspaces)
                          : undefined
                      }
                    />
                    {subagents && <SubagentSessions items={subagents} searching={!!searching} />}
                  </Fragment>
                )
              })}
              <WindowedList items={visibleDormant} itemKey={({ session }) => session.path}>
                {({ session, listing }) => (
                  <DormantRow
                    key={session.path}
                    session={session}
                    listing={listing}
                    pinned={pinned.has(normalizePath(session.path))}
                    foreignWorkspace={
                      scope === 'all' || !samePath(session.cwd, activeWorkspace)
                        ? workspaceName(session.cwd, workspaces)
                        : undefined
                    }
                    {...subagentsOf(session.path)}
                  />
                )}
              </WindowedList>
            </section>
          )}

          {pinnedItems.length > 0 && (
            <section aria-label="Pinned sessions">
              <SectionHeader label="Pinned" count={pinnedItems.length} />
              <WindowedList items={pinnedItems} itemKey={(item) => item.path}>
                {(item) => (
                  <HistoryRow
                    key={item.path}
                    item={item}
                    pinned
                    showWorkspace={
                      scope === 'all' ? workspaceName(item.cwd, workspaces) : undefined
                    }
                    {...subagentsOf(item.path)}
                  />
                )}
              </WindowedList>
            </section>
          )}

          <BackgroundSessions />

          <SessionListFeedback
            loading={loading}
            error={list?.error}
            empty={nothing}
            query={query}
            scope={scope}
            onRetry={() => void load(listCwd)}
          />

          {scope === 'workspace' &&
            dated.map(({ group, items: groupItems }) => (
              <section key={group} aria-label={group}>
                <SectionHeader
                  label={query ? `${group} · matches` : group}
                  count={groupItems.length}
                />
                <WindowedList items={groupItems} itemKey={(item) => item.path}>
                  {(item) => (
                    <HistoryRow
                      key={item.path}
                      item={item}
                      pinned={false}
                      {...subagentsOf(item.path)}
                    />
                  )}
                </WindowedList>
              </section>
            ))}

          {scope === 'all' && byWorkspace.length > 0 && (
            <section aria-label="Sessions by workspace">
              <SectionHeader label="Workspaces" count={byWorkspace.length} />
              <WindowedList
                items={byWorkspace}
                itemKey={(group) => normalizePath(group.cwd || '?')}
                estimateSize={WORKSPACE_GROUP_HEIGHT}
                isItemFocusable={(group) =>
                  !!query || !collapsed.includes(normalizePath(group.cwd))
                }
              >
                {(group) => (
                  <WorkspaceSection
                    key={normalizePath(group.cwd || '?')}
                    cwd={group.cwd}
                    name={workspaceName(group.cwd, workspaces)}
                    items={group.items}
                    collapsed={!query && collapsed.includes(normalizePath(group.cwd))}
                    query={query}
                  >
                    {(item) => (
                      <HistoryRow
                        item={item}
                        pinned={pinned.has(normalizePath(item.path))}
                        {...subagentsOf(item.path)}
                      />
                    )}
                  </WorkspaceSection>
                )}
              </WindowedList>
            </section>
          )}
        </div>
      </LayoutGroup>

      <div className="flex items-center gap-1 border-t border-hairline-soft px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 flex-1 justify-start text-fg-3"
          leading={<FolderOpen />}
          onClick={() => void chooseWorkspace()}
        >
          Open folder…
        </Button>
        <IconButton
          label="Settings"
          hotkey="mod+comma"
          size="sm"
          onClick={() => useApp.getState().openSettings()}
        >
          <Settings />
        </IconButton>
      </div>
      <SessionDialogs />
    </div>
  )
}
