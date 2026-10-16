import { useEffect } from 'react'
import { CopyPlus, FileDown, FileInput, FileJson, Ghost, GitFork, History, ListTree, Pencil, Share2 } from 'lucide-react'
import { registerActions } from '../../lib/actions'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { cloneSession, exportSession, newEphemeralSession, pickImport, shareSession, targetForAgent } from './actions'
import { useSessions } from './store'

function activeTarget() {
  const id = useAgents.getState().activeAgentId
  return id ? targetForAgent(id) : null
}

const hasActive = () => activeTarget() !== null

/** Session palette actions (session.new lives with the shell's core actions). */
export function useSessionPaletteActions(): void {
  useEffect(
    () =>
      registerActions([
        {
          id: 'session.fork',
          title: 'Fork from a previous message…',
          group: 'Session',
          keywords: ['branch', 'edit', 'resend'],
          icon: GitFork,
          when: hasActive,
          run: () => {
            const target = activeTarget()
            if (target) useSessions.getState().openDialog({ kind: 'fork', target })
          }
        },
        {
          id: 'session.clone',
          title: 'Clone session',
          group: 'Session',
          keywords: ['duplicate', 'copy'],
          icon: CopyPlus,
          when: hasActive,
          run: () => {
            const target = activeTarget()
            if (target) void cloneSession(target)
          }
        },
        {
          id: 'session.tree',
          title: 'Show session tree',
          group: 'Session',
          keywords: ['branches', 'navigate', 'history', 'graph'],
          icon: ListTree,
          when: hasActive,
          run: () => useApp.getState().setInspectorTab('branches')
        },
        {
          id: 'session.resume',
          title: 'Open a previous session…',
          group: 'Session',
          keywords: ['resume', 'history', 'continue', 'search'],
          icon: History,
          run: () => {
            useApp.getState().toggleSidebar(true)
            useSessions.getState().focusSearch()
          }
        },
        {
          id: 'session.rename',
          title: 'Rename session',
          group: 'Session',
          keywords: ['name', 'title'],
          icon: Pencil,
          when: hasActive,
          run: () => {
            const id = useAgents.getState().activeAgentId
            if (!id) return
            useApp.getState().toggleSidebar(true)
            useSessions.getState().setRenaming(`agent:${id}`)
          }
        },
        {
          id: 'session.export',
          title: 'Export session as HTML…',
          group: 'Session',
          keywords: ['save', 'share', 'html'],
          icon: FileDown,
          when: hasActive,
          run: () => {
            const target = activeTarget()
            if (target) void exportSession(target, 'html')
          }
        },
        {
          id: 'session.exportJsonl',
          title: 'Export session as JSONL…',
          group: 'Session',
          keywords: ['save', 'jsonl', 'file', 'backup'],
          icon: FileJson,
          when: hasActive,
          run: () => {
            const target = activeTarget()
            if (target) void exportSession(target, 'jsonl')
          }
        },
        {
          id: 'session.share',
          title: 'Share session…',
          group: 'Session',
          keywords: ['gist', 'link', 'url', 'publish', 'upload'],
          icon: Share2,
          when: hasActive,
          run: () => {
            const target = activeTarget()
            if (target) shareSession(target)
          }
        },
        {
          id: 'session.import',
          title: 'Import session…',
          group: 'Session',
          keywords: ['jsonl', 'open', 'file', 'load'],
          icon: FileInput,
          run: () => void pickImport()
        },
        {
          id: 'session.newEphemeral',
          title: 'New ephemeral session',
          group: 'Session',
          keywords: ['temporary', 'no-session', 'incognito', 'private', 'unsaved'],
          icon: Ghost,
          run: () => void newEphemeralSession()
        }
      ]),
    []
  )
}
