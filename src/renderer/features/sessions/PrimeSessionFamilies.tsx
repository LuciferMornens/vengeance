import { useState } from 'react'
import { ChevronRight, GitBranch, Pin, X } from 'lucide-react'
import { sessionIdentityPath } from '@shared/session-identity'
import { cn } from '../../lib/cn'
import { basename, pluralize } from '../../lib/format'
import { useAgents } from '../../store/agents'
import { IconButton, Tooltip } from '../../ui'
import {
  activateAgent,
  openSessionFile,
  prewarmSavedSession,
  renameSession,
  requestCloseAgent,
  resumeBackgroundAgent
} from './actions'
import { LiveDot } from './LiveDot'
import { historyMenu, openAgentMenu } from './menus'
import { agentOwnTitle, itemTitle, liveState, matchesQuery } from './model'
import {
  primeFamilyOrphans,
  type PrimeFamilyNode,
  type PrimeSessionFamilies
} from './prime-family-model'
import { resumeDormant } from './restore'
import { SessionRow } from './SessionRow'
import { SectionHeader } from './SessionListParts'
import { dismissDormant, useSessions, useSessionsPrefs } from './store'
import { WindowedList } from './WindowedList'
import { BackgroundSessionStop } from './BackgroundSessionStop'

export function primeFamilyTitle(node: PrimeFamilyNode): string {
  return (
    node.open?.sessionName ||
    node.background?.name ||
    (node.saved ? itemTitle(node.saved) : '') ||
    'Subagent session'
  )
}

export function primeFamilyMatches(node: PrimeFamilyNode | undefined, query: string): boolean {
  return (
    !!node &&
    (matchesQuery(query, primeFamilyTitle(node), node.saved?.searchText, node.cwd) ||
      node.children.some((child) => primeFamilyMatches(child, query)))
  )
}

function containsActive(node: PrimeFamilyNode, activeAgentId: string | null): boolean {
  return (
    (!!activeAgentId && node.open?.agentId === activeAgentId) ||
    node.children.some((child) => containsActive(child, activeAgentId))
  )
}

function FamilyRow({ node }: { node: PrimeFamilyNode }) {
  const openId = node.open?.agentId
  const ownTitle = useAgents((s) => (openId && s.agents[openId] ? agentOwnTitle(s.agents[openId]) : null))
  const live = useAgents((s) => (openId && s.agents[openId] ? liveState(s.agents[openId]) : null))
  const active = useAgents((state) => state.activeAgentId === openId)
  const { pinned: pinnedPaths } = useSessionsPrefs()
  const pinned =
    !!node.path &&
    pinnedPaths.some((path) => sessionIdentityPath(path) === sessionIdentityPath(node.path!))
  const title = ownTitle || primeFamilyTitle(node)
  const state = live ?? (node.background?.busy ? 'running' : 'idle')
  const target = {
    agentId: node.open?.agentId,
    path: node.path,
    cwd: node.cwd,
    title,
    engine: 'prime' as const
  }
  const close = node.open
    ? () => requestCloseAgent(node.open!.agentId)
    : node.dormant
      ? () => dismissDormant(node.dormant!.path)
      : undefined
  const open = () => {
    if (node.open) activateAgent(node.open.agentId)
    else if (node.background) void resumeBackgroundAgent(node.background)
    else if (node.dormant) resumeDormant(node.dormant)
    else if (node.path) void openSessionFile(node.path, { cwd: node.cwd, engine: 'prime' })
  }
  return (
    <div data-prime-subagent={node.lineage?.childId ?? node.key}>
      <SessionRow
        rowKey={node.open ? `agent:${node.open.agentId}` : (node.path ?? node.key)}
        title={title}
        titleTooltip={node.path}
        active={active}
        leading={<LiveDot state={state} />}
        meta={
          <>
            <span className="shrink-0">Subagent</span>
            {pinned && <Pin aria-label="Pinned" className="size-3 shrink-0 -rotate-45" />}
            <span aria-hidden>·</span>
            <span className="truncate">
              {state === 'running'
                ? 'Working'
                : node.open
                  ? 'Open'
                  : node.background
                    ? 'Background'
                    : 'Saved'}
              {node.cwd ? ` · ${basename(node.cwd)}` : ''}
            </span>
          </>
        }
        actions={
          (close || node.background) && (
            <>
              {!node.open && node.background && (
                <BackgroundSessionStop resident={node.background} title={title} />
              )}
              {close && (
                <Tooltip content="Close tab — session keeps running with its parent">
                  <IconButton label="Close tab" tooltip={false} size="xs" onClick={close}>
                    <X />
                  </IconButton>
                </Tooltip>
              )}
            </>
          )
        }
        wideActions={!!close && !!node.background && !node.open}
        menu={
          node.open
            ? openAgentMenu(target, pinned)
            : node.saved
              ? historyMenu(node.saved, pinned)
              : []
        }
        onOpen={open}
        onRename={(name) => void renameSession(target, name)}
        onIntent={() => prewarmSavedSession(target)}
        onDelete={
          node.path
            ? () =>
                useSessions.getState().openDialog({
                  kind: 'delete',
                  target: { ...target, path: node.path! }
                })
            : undefined
        }
      />
    </div>
  )
}

export function PrimeFamilyChildren({
  parent,
  query,
  inView
}: {
  parent: PrimeFamilyNode | undefined
  query: string
  inView: (cwd: string) => boolean
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const activeAgentId = useAgents((state) => state.activeAgentId)
  const children = parent?.children.filter(
    (child) => inView(child.cwd) && primeFamilyMatches(child, query)
  )
  if (!children?.length) return null
  const shown =
    expanded ?? (!!query.trim() || children.some((child) => containsActive(child, activeAgentId)))
  return (
    <div data-prime-family={parent?.key}>
      <button
        type="button"
        aria-expanded={shown}
        aria-label={`Subagents of ${parent ? primeFamilyTitle(parent) : 'session'}`}
        onClick={() => setExpanded(!shown)}
        className="mx-2 flex h-7 w-[calc(100%-16px)] items-center gap-1.5 rounded-md pl-[30px] text-xs text-fg-3 hover:bg-hover hover:text-fg-2"
      >
        <ChevronRight className={cn('size-3 shrink-0', shown && 'rotate-90')} />
        {pluralize(children.length, 'subagent session')}
      </button>
      {shown && (
        <div className="pl-3">
          <WindowedList items={children} itemKey={(child) => child.key}>
            {(child) => (
              <div>
                <FamilyRow node={child} />
                <PrimeFamilyChildren parent={child} query={query} inView={inView} />
              </div>
            )}
          </WindowedList>
        </div>
      )}
    </div>
  )
}

export function PrimeOrphanSessions({
  families,
  query,
  inView
}: {
  families: PrimeSessionFamilies
  query: string
  inView: (cwd: string) => boolean
}) {
  const orphans = primeFamilyOrphans(families, inView).filter((node) =>
    primeFamilyMatches(node, query)
  )
  if (!orphans.length) return null
  return (
    <section aria-label="Subagent sessions">
      <SectionHeader label="Subagent sessions" count={orphans.length}>
        <Tooltip content="Their parent session is outside this view or unavailable.">
          <GitBranch className="size-3" />
        </Tooltip>
      </SectionHeader>
      <WindowedList items={orphans} itemKey={(node) => node.key}>
        {(node) => (
          <div>
            <FamilyRow node={node} />
            <PrimeFamilyChildren parent={node} query={query} inView={inView} />
          </div>
        )}
      </WindowedList>
    </section>
  )
}
