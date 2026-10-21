import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, FolderOpen, Pin, Settings, Trash2, X } from 'lucide-react'
import type { OpenSessionRef } from '@shared/api/app'
import { ENGINE_LABELS, normalizeEngineId, type EngineId } from '@shared/api/engine'
import type { SessionListItem } from '@shared/api/sessions'
import { cn } from '../../lib/cn'
import { basename, pluralize } from '../../lib/format'
import { spring } from '../../lib/motion'
import { normalizePath, samePath } from '../../lib/paths'
import { useAgents, type AgentsStore } from '../../store/agents'
import { useApp } from '../../store/app'
import { Button, IconButton, Tooltip } from '../../ui'
import { preloadSettingsSheet } from '../shell/settings-sheet'
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
  partitionSessions,
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
import { backgroundMatches, BackgroundSessions } from './BackgroundSessions'
import { WindowedList } from './WindowedList'
import { inWorkspaceView } from './workspace-view'
import { onSessionListKeyDown, SidebarSearch } from './SidebarSearch'
import {
  buildPrimeSessionFamilies,
  primeBackgroundFamilyNode,
  primeFamilyNode
} from './prime-family-model'
import {
  PrimeFamilyChildren,
  primeFamilyMatches,
  PrimeOrphanSessions,
  visiblePrimeOrphans
} from './PrimeSessionFamilies'

const WORKSPACE_GROUP_HEIGHT = 294
const EMPTY_STRINGS: string[] = []

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
function SubagentSessions({
  parentPath,
  items,
  searching
}: {
  parentPath: string
  items: SessionListItem[]
  searching: boolean
}) {
  const expansionKey = `subagents:${normalizePath(parentPath)}`
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
            {/* Pinned sessions stay in the list (`partitionSessions`), so none here is pinned. */}
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
  family?: ReactNode
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
  family,
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
        onOpen={(revision) => void openSession(item, revision)}
        onRename={(name) => void renameSession(target, name)}
        onDelete={() => useSessions.getState().openDialog({ kind: 'delete', target })}
        onIntent={() => prewarmSavedSession(target)}
      />
      {subagents && subagents.length > 0 && (
        <SubagentSessions parentPath={item.path} items={subagents} searching={searching} />
      )}
      {family}
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
  family,
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
        onOpen={(revision) => resumeDormant(session, revision)}
        onRename={(name) => void renameSession(target, name)}
        onDelete={() => useSessions.getState().openDialog({ kind: 'delete', target })}
        onIntent={() => prewarmSavedSession(target)}
      />
      {subagents && subagents.length > 0 && (
        <SubagentSessions parentPath={session.path} items={subagents} searching={searching} />
      )}
      {family}
    </>
  )
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
  const openInfos = useAgents(useShallow((s) => openIdsOf(s).map((id) => s.agents[id]!.info)))
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
      query.trim() ? openIdsOf(s).map((id) => agentSearchText(s.agents[id]!)) : EMPTY_STRINGS
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
  const families = useMemo(
    () => buildPrimeSessionFamilies({ open: openInfos, dormant, background, saved: listed ?? [] }),
    [openInfos, dormant, background, listed]
  )
  const familyOf = (path?: string, nativeId?: string, engine?: EngineId, agentId?: string) =>
    engine === 'prime' ? primeFamilyNode(families, path, nativeId, agentId) : undefined
  const byPath = useMemo(
    () => new Map((listed ?? []).map((i) => [normalizePath(i.path), i])),
    [listed]
  )
  const hasQuery = !!query.trim()
  const { items, subagentsByParent } = useMemo(
    () =>
      partitionSessions(listed ?? [], {
        key: normalizePath,
        skip: (item) => item.engine === 'prime' && !!primeFamilyNode(families, item.path)?.child,
        pinned: (item) => pinned.has(normalizePath(item.path)),
        searching: hasQuery
      }),
    [listed, families, pinned, hasQuery]
  )
  const subagentsOf = (path: string, engine?: EngineId): SubagentRowProps => {
    const subagents = subagentsByParent.get(normalizePath(path))
    return {
      subagents,
      searching: hasQuery && someMatch(query, subagents),
      family: (
        <PrimeFamilyChildren
          parent={familyOf(path, undefined, engine)}
          query={query}
          inView={inView}
        />
      )
    }
  }

  const inView = (cwd: string) => inWorkspaceView(cwd, { scope, activeWorkspace, workspaces })
  const open = openIds.map((id, i) => {
    const file = openFileList[i] || undefined
    const listing = file ? byPath.get(normalizePath(file)) : undefined
    return {
      id,
      engine: openInfos[i]?.engine,
      nativeId: openInfos[i]?.nativeAgentId,
      cwd: openCwds[i] ?? '',
      file,
      listing,
      title: openTitles[i] || (listing ? itemTitle(listing) : 'New session'),
      searchText: openSearchTexts[i]
    }
  })
  const visibleOpen = open.filter(
    (agent) =>
      !familyOf(agent.file, agent.nativeId, agent.engine, agent.id)?.child &&
      inView(agent.cwd) &&
      (matchesQuery(query, agent.title, agent.searchText) ||
        primeFamilyMatches(familyOf(agent.file, agent.nativeId, agent.engine, agent.id), query))
  )
  const runningFiles = new Set(openFileList.filter(Boolean).map(normalizePath))
  const backgroundFiles = new Set(
    background.flatMap((agent) => (agent.sessionPath ? [normalizePath(agent.sessionPath)] : []))
  )
  const visibleDormant = dormant
    .filter((session) => !familyOf(session.path, undefined, session.engine)?.child)
    .filter((session) => inView(session.cwd))
    .filter((session) => !backgroundFiles.has(normalizePath(session.path)))
    .filter((session) => !runningFiles.has(normalizePath(session.path)))
    .map((session) => ({ session, listing: findListed(lists, session.path) }))
    .filter(
      ({ listing }) =>
        matchesQuery(query, listing ? itemTitle(listing) : '', listing?.searchText) ||
        primeFamilyMatches(familyOf(listing?.path, undefined, listing?.engine), query)
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
      someMatch(query, [item]) ||
      someMatch(query, subagentsByParent.get(normalizePath(item.path))) ||
      (item.engine === 'prime' && primeFamilyMatches(primeFamilyNode(families, item.path), query))
    const history = items.filter((i) => !openFiles.has(normalizePath(i.path)) && matches(i))
    return {
      pinnedItems: history.filter((i) => pinned.has(normalizePath(i.path))),
      rest: history.filter((i) => !pinned.has(normalizePath(i.path)))
    }
  }, [items, subagentsByParent, openFilesKey, query, pinned, families])
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
  // Open sessions are listed under Open, not Background sessions.
  const hasBackgroundMatch = background.some(
    (agent) =>
      !primeBackgroundFamilyNode(families, agent)?.child &&
      inView(agent.cwd) &&
      !(agent.sessionPath && runningFiles.has(normalizePath(agent.sessionPath))) &&
      backgroundMatches(agent, families, query)
  )
  const primeOrphans = visiblePrimeOrphans(families, query, inView)
  const nothing =
    !loading &&
    historyCount === 0 &&
    openCount === 0 &&
    !hasBackgroundMatch &&
    primeOrphans.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <WorkspaceSwitcher />
        <NewSessionActions />
      </div>
      <div className="px-3 pt-2 pb-1.5">
        <SidebarSearch />
      </div>

      <LayoutGroup>
        <div
          ref={scrollRef}
          data-session-list
          onKeyDown={onSessionListKeyDown}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-3 [scrollbar-gutter:stable]"
        >
          {openCount > 0 && (
            <section aria-label="Open sessions">
              <SectionHeader label="Open" count={openCount} />
              {visibleOpen.map((agent) => {
                const { subagents, searching } = agent.file
                  ? subagentsOf(agent.file, agent.engine)
                  : {}
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
                    {agent.file && subagents && (
                      <SubagentSessions
                        parentPath={agent.file}
                        items={subagents}
                        searching={!!searching}
                      />
                    )}
                    <PrimeFamilyChildren
                      parent={familyOf(agent.file, agent.nativeId, agent.engine, agent.id)}
                      query={query}
                      inView={inView}
                    />
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
                    {...subagentsOf(session.path, session.engine)}
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
                    {...subagentsOf(item.path, item.engine)}
                  />
                )}
              </WindowedList>
            </section>
          )}

          <BackgroundSessions families={families} />
          <PrimeOrphanSessions orphans={primeOrphans} query={query} inView={inView} />

          <SessionListFeedback
            loading={loading}
            error={list?.error}
            warning={list?.warning}
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
                      {...subagentsOf(item.path, item.engine)}
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
                        {...subagentsOf(item.path, item.engine)}
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
          onPointerEnter={preloadSettingsSheet}
          onFocus={preloadSettingsSheet}
          onClick={() => useApp.getState().openSettings()}
        >
          <Settings />
        </IconButton>
      </div>
      <SessionDialogs />
    </div>
  )
}
