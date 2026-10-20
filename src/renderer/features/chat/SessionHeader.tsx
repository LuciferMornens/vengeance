import { useEffect, useRef, useState } from 'react'
import { FileDown, GitBranchPlus, PanelRight } from 'lucide-react'
import { runAction } from '../../lib/actions'
import { cn } from '../../lib/cn'
import { isImeComposing } from '../../lib/keybindings'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { IconButton, Shimmer, Tooltip } from '../../ui'
import { LiveDot, liveState } from '../sessions'
import { renameSession, targetForAgent } from '../sessions/actions'
import { agentOwnTitle } from '../sessions/model'
import { ContextUsage } from './ContextRing'
import { ConversationPromptButton } from './ConversationPrompt'

/** The session's own title (a child subagent session reads as "Worker subagent · <task>"), else "New session". */
function useSessionTitle(agentId: string): string {
  return useAgents((s) => {
    const agent = s.agents[agentId]
    return agent ? (agentOwnTitle(agent) ?? 'New session') : ''
  })
}

/** Session title with its live state; click to rename (one rename path: the sessions feature). */
function SessionTitle({ agentId }: { agentId: string }) {
  const title = useSessionTitle(agentId)
  const named = useAgents((s) => !!s.agents[agentId]?.sessionName || !!s.agents[agentId]?.ext.title)
  const state = useAgents((s) => {
    const agent = s.agents[agentId]
    return agent ? liveState(agent) : 'idle'
  })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const commit = async () => {
    const name = draft.trim()
    setEditing(false)
    const target = targetForAgent(agentId)
    if (!name || name === title || !target) return
    await renameSession(target, name)
    // The user's name wins over an extension-provided title from now on.
    const agent = useAgents.getState().agents[agentId]
    if (agent?.sessionName === name && agent.ext.title) useAgents.getState().patchAgent(agentId, { ext: { ...agent.ext, title: undefined } })
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <LiveDot state={state} className={cn(state === 'idle' && 'invisible')} />
      {editing ? (
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !isImeComposing(e)) void commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          aria-label="Session name"
          className="no-drag -ml-2 h-7 min-w-0 flex-1 rounded-md bg-surface-2 px-2 text-ui font-medium text-fg shadow-focus outline-none"
        />
      ) : (
        <Tooltip content="Rename session" side="bottom" align="start">
          <button
            type="button"
            aria-label="Rename session"
            data-session-title
            onClick={() => {
              setDraft(title)
              setEditing(true)
            }}
            className={cn(
              'heading no-drag -ml-2 h-7 min-w-0 truncate rounded-md px-2 text-left text-ui transition-colors duration-[var(--dur-instant)] hover:bg-hover',
              named || title !== 'New session' ? 'text-fg' : 'text-fg-3'
            )}
          >
            {title}
          </button>
        </Tooltip>
      )}
    </div>
  )
}

function EngineStatus({ agentId }: { agentId: string }) {
  const status = useAgents((s) => s.agents[agentId]?.status)
  if (status === 'starting') {
    return (
      <span className="inline-flex h-6 shrink-0 items-center gap-2 rounded-full px-2.5 text-xs shadow-[inset_0_0_0_1px_var(--hairline)]">
        <span className="size-1.5 animate-[v-pulse_1s_ease-in-out_3] rounded-full bg-warning" />
        <Shimmer>Starting engine</Shimmer>
      </span>
    )
  }
  if (status === 'stopping' || status === 'exited') {
    return (
      <span className="inline-flex h-6 shrink-0 items-center gap-2 rounded-full px-2.5 text-xs text-fg-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
        <span className="size-1.5 rounded-full bg-fg-4" />
        Engine stopped
      </span>
    )
  }
  return null
}

/** Instructions · fork · export | inspector toggle (the toggle sits next to the pane it opens). */
function HeaderToolbar({ agentId }: { agentId: string }) {
  const ready = useAgents((s) => s.agents[agentId]?.status === 'ready')
  // Nothing to fork from or export until the session has a message.
  const empty = useAgents((s) => (s.agents[agentId]?.entries.length ?? 0) === 0)
  const inspectorOpen = useApp((s) => s.prefs.inspector.open)
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ConversationPromptButton agentId={agentId} />
      <IconButton label="Fork from a message…" disabled={!ready || empty} onClick={() => runAction('session.fork')}>
        <GitBranchPlus />
      </IconButton>
      <IconButton label="Export as HTML…" disabled={!ready || empty} onClick={() => runAction('session.export')}>
        <FileDown />
      </IconButton>
      <span className="mx-1 h-4 w-px bg-hairline" aria-hidden />
      <IconButton label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} hotkey="mod+i" active={inspectorOpen} onClick={() => runAction('inspector.toggle')}>
        <PanelRight />
      </IconButton>
    </div>
  )
}

/**
 * Pane header above the transcript (SPEC §9.1): session title (inline rename) with its live state, a passive
 * context gauge + cost (hover breakdown) and the session toolbar. Model and thinking live in the composer.
 */
export function SessionHeader({ agentId }: { agentId: string }) {
  const exists = useAgents((s) => !!s.agents[agentId])
  if (!exists) return null
  return (
    <div data-session-header className="flex h-[var(--pane-header-h)] shrink-0 items-center gap-2 border-b border-hairline-soft pr-2.5 pl-5">
      <SessionTitle agentId={agentId} />
      <EngineStatus agentId={agentId} />
      <ContextUsage agentId={agentId} />
      <HeaderToolbar agentId={agentId} />
    </div>
  )
}
