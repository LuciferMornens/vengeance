import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, MessageSquareDashed, Plus, RefreshCw, Search } from 'lucide-react'
import type { SessionListItem, SessionScope } from '@shared/api/sessions'
import { cn } from '../../lib/cn'
import { spring } from '../../lib/motion'
import { Avatar, Button, IconButton, Skeleton } from '../../ui'
import { newSession } from '../shell/workspace'
import { toggleCollapsed, useSessions } from './store'
import { normalizePath } from '../../lib/paths'
import { WindowedList } from './WindowedList'

const WORKSPACE_PREVIEW = 5

export function WorkspaceSection({
  cwd,
  name,
  items,
  collapsed,
  query,
  children
}: {
  cwd: string
  name: string
  items: SessionListItem[]
  collapsed: boolean
  query: string
  children: (item: SessionListItem) => ReactNode
}) {
  const expansionKey = `workspace:${normalizePath(cwd)}`
  const expanded = useSessions((state) => state.expandedLists.includes(expansionKey))
  const shown = expanded || query ? items : items.slice(0, WORKSPACE_PREVIEW)
  return (
    <div className="pb-1">
      <div className="group/ws mx-2 mt-2 flex h-8 items-center gap-1 rounded-md pr-1 hover:bg-hover">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggleCollapsed(cwd)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-fg-3 transition-transform duration-[var(--dur-fast)]',
              !collapsed && 'rotate-90'
            )}
          />
          <Avatar name={name} size={18} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-2">{name}</span>
          <span className="tabular text-2xs text-fg-3">{items.length}</span>
        </button>
        <IconButton
          label={`New session in ${name}`}
          size="xs"
          className="opacity-0 group-hover/ws:opacity-100 focus-visible:opacity-100"
          onClick={() => void newSession({ cwd })}
        >
          <Plus />
        </IconButton>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring.panel}
            className="overflow-hidden"
          >
            <WindowedList items={shown} itemKey={(item) => item.path}>
              {children}
            </WindowedList>
            {!query && items.length > WORKSPACE_PREVIEW && (
              <button
                type="button"
                onClick={() => useSessions.getState().toggleExpanded(expansionKey)}
                className="mx-2 flex h-7 w-[calc(100%-16px)] items-center rounded-md pl-[30px] text-xs text-fg-3 hover:bg-hover hover:text-fg-2"
              >
                {expanded ? 'Show less' : `Show ${items.length - WORKSPACE_PREVIEW} more`}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function SectionHeader({
  label,
  count,
  children
}: {
  label: ReactNode
  count?: number
  children?: ReactNode
}) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-4 pt-2 text-xs font-medium text-fg-3">
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="tabular font-normal text-fg-3">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  )
}

interface SessionListFeedbackProps {
  loading: boolean
  error?: string
  warning?: string
  empty: boolean
  query: string
  scope: SessionScope
  onRetry: () => void
}

export function SessionListFeedback({
  loading,
  error,
  warning,
  empty,
  query,
  scope,
  onRetry
}: SessionListFeedbackProps) {
  if (error) {
    return (
      <div role="status" className="mx-4 mt-3 text-xs leading-relaxed text-fg-2">
        <p className="font-medium">Could not load sessions</p>
        <p className="mt-1 break-words text-fg-3">{error}</p>
        <Button
          variant="ghost"
          size="sm"
          leading={<RefreshCw />}
          onClick={onRetry}
          className="mt-2"
        >
          Try again
        </Button>
      </div>
    )
  }
  if (loading) {
    return (
      <div role="status" aria-label="Loading sessions" className="flex flex-col gap-3 px-4 pt-3">
        {[78, 92, 64, 84].map((width) => (
          <div key={width} className="flex flex-col gap-1.5" style={{ width: `${width}%` }}>
            <Skeleton className="h-3" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    )
  }
  if (warning) {
    return (
      <p role="status" className="mx-4 mt-3 break-words text-xs leading-relaxed text-fg-3">
        {warning}
      </p>
    )
  }
  if (!empty) return null
  return (
    <div role="status" className="mx-4 mt-3 flex flex-col items-start gap-1 px-3 py-3 text-sm">
      <span className="flex items-center gap-2 font-medium text-fg-2 [&_svg]:size-3.5 [&_svg]:text-fg-3">
        {query ? <Search /> : <MessageSquareDashed />}
        {query ? 'No matching sessions' : 'No saved sessions yet'}
      </span>
      <span className="text-xs leading-relaxed text-fg-3">
        {query
          ? `Nothing matches “${query}”${scope === 'workspace' ? ' in this workspace.' : '.'}`
          : 'Sessions you start here are saved automatically and show up in this list.'}
      </span>
    </div>
  )
}
