import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Bot } from 'lucide-react'
import type { SessionListItem } from '@shared/api/sessions'
import { normalizePath } from '../../lib/paths'
import { Button } from '../../ui'
import { openSession } from './actions'
import { listKey, useSessions, type SessionList } from './store'

/** Listed child sessions of the given subagent runs of `parentPath` (each list once, so no duplicates). */
function runSessions(lists: Record<string, SessionList>, parentPath: string, runIds: string[]): SessionListItem[] {
  const parent = normalizePath(parentPath)
  const found = new Map<string, SessionListItem>()
  for (const list of Object.values(lists)) {
    for (const item of list.items) {
      const run = item.subagentRun
      if (run && runIds.includes(run.runId) && normalizePath(run.parentPath) === parent) found.set(normalizePath(item.path), item)
    }
  }
  return [...found.values()]
}

/**
 * "Open child session" on a subagent notice in a session tree: one button per session the notice's runs left under
 * the parent session (pi-subagents' `<parent>/<run id>/run-<n>/`). Nothing when the runs saved no session.
 */
export function SubagentSessionButtons({
  parentPath,
  cwd,
  runIds,
  onOpen = (session) => void openSession(session)
}: {
  parentPath: string
  cwd: string
  runIds: string[]
  onOpen?: (session: SessionListItem) => void
}) {
  const sessions = useSessions(useShallow((s) => runSessions(s.lists, parentPath, runIds)))
  const listed = useSessions((s) => !!s.lists[listKey(cwd)])

  useEffect(() => {
    if (!listed) void useSessions.getState().load(cwd)
  }, [listed, cwd])

  return sessions.map((session, index) => (
    <Button key={session.path} size="xs" variant="secondary" leading={<Bot />} onClick={() => onOpen(session)}>
      {sessions.length > 1 ? `Open child session ${index + 1}` : 'Open child session'}
    </Button>
  ))
}
