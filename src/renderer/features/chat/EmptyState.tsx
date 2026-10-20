import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Bug, Compass, FlaskConical, Folder, Gauge, History } from 'lucide-react'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'
import type { SessionListItem } from '@shared/api/sessions'
import { rpc } from '../../lib/engine'
import { basename, formatRelativeTime } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { samePath } from '../../lib/paths'
import { fadeUp, stagger } from '../../lib/motion'
import { useAgents } from '../../store/agents'
import { Mark, toast } from '../../ui'
import { activateAgent, openSessionFile } from '../sessions'
import { findAgentForFile } from '../sessions/actions'
import { itemTitle } from '../sessions/model'

interface Suggestion {
  icon: ReactNode
  title: string
  hint: string
  prompt: string
}

function suggestionsFor(project: string): Suggestion[] {
  return [
    {
      icon: <Compass />,
      title: 'Explain this codebase',
      hint: 'Architecture, key modules, how data flows',
      prompt: `Give me a guided tour of ${project}: the architecture, the key modules and how data flows between them.`
    },
    {
      icon: <Bug />,
      title: 'Hunt for bugs',
      hint: 'Review recent changes for risky code',
      prompt: 'Review the most recently changed files for bugs, edge cases and risky code. List findings by severity.'
    },
    {
      icon: <FlaskConical />,
      title: 'Strengthen the tests',
      hint: 'Find gaps and add meaningful tests',
      prompt: 'Find the most important untested behavior in this project and add focused tests for it.'
    },
    {
      icon: <Gauge />,
      title: 'Make it faster',
      hint: 'Spot slow paths and propose fixes',
      prompt: 'Look for performance problems (hot paths, redundant work, N+1 patterns) and propose concrete fixes.'
    }
  ]
}

const RECENT_LIMIT = 4

/**
 * The workspace's latest sessions of this engine with messages (`sessions:list`, the session browser's
 * source): an in-place switch only opens the engine's own session files.
 */
function useRecentSessions(cwd: string, engine: EngineId): SessionListItem[] {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  useEffect(() => {
    let alive = true
    if (!cwd) return
    invoke('sessions:list', { cwd, engine })
      .then(({ sessions: list }) => {
        if (!alive) return
        const recent = list
          .filter((s) => s.messageCount > 0 && (!s.cwd || samePath(s.cwd, cwd)))
          .sort((a, b) => b.modifiedAt - a.modifiedAt)
          .slice(0, RECENT_LIMIT)
        setSessions(recent)
      })
      .catch(() => alive && setSessions([]))
    return () => {
      alive = false
    }
  }, [cwd, engine])
  return sessions
}

/**
 * One engine per session file: focus the agent that already has it open; otherwise this empty session
 * becomes it (switch_session in place, no extra engine). Conversation instructions are launch flags of
 * the process started with them, so when this session or the recent one has its own, the recent session
 * opens in its own agent instead.
 */
async function openRecent(agentId: string, session: SessionListItem): Promise<void> {
  const open = findAgentForFile(session.path, session.engine)
  if (open) return activateAgent(open)
  try {
    const engine = normalizeEngineId(session.engine)
    const own =
      !!useAgents.getState().agents[agentId]?.info.args.conversationPrompt ||
      !!(await invoke('engine:conversation-prompt', engine, session.path))
    if (own) {
      await openSessionFile(session.path, { cwd: session.cwd || undefined, engine })
      return
    }
    const result = await rpc(agentId, { type: 'switch_session', sessionPath: session.path })
    if (!result.cancelled) await useAgents.getState().refresh(agentId)
  } catch (error) {
    toast({ level: 'error', title: 'Could not open the session', description: (error as Error).message })
  }
}

/** Calm hero for a session without messages: mark, workspace, suggested prompts, recent sessions. */
export function SessionEmptyState({ agentId }: { agentId: string }) {
  const cwd = useAgents((s) => s.agents[agentId]?.info.cwd ?? '')
  const engine = useAgents((s) => s.agents[agentId]?.info.engine ?? 'pi')
  const ready = useAgents((s) => s.agents[agentId]?.status === 'ready')
  const project = basename(cwd)
  const recent = useRecentSessions(cwd, engine)
  const send = (text: string) => void useAgents.getState().prompt(agentId, text).catch((error: Error) => toast({ level: 'error', title: 'Could not send', description: error.message }))

  return (
    <motion.div
      variants={stagger(0.05)}
      initial="hidden"
      animate="show"
      className="mx-auto flex min-h-full w-full max-w-[680px] flex-col items-center justify-center px-8 pt-10 pb-[calc(var(--composer-h)+24px)] short:pt-6 @max-[640px]/pane:px-5"
    >
      <motion.div
        variants={fadeUp}
        className="relative mb-7 flex size-20 items-center justify-center short:mb-4 short:size-14"
      >
        <span className="v-ember-glow absolute inset-[-28px] rounded-full" aria-hidden />
        <Mark size={52} className="relative short:size-10" />
      </motion.div>
      <motion.h1 variants={fadeUp} className="heading text-center text-[26px] leading-tight font-semibold text-fg">
        What should we build?
      </motion.h1>
      <motion.div variants={fadeUp} className="mt-3 flex items-center gap-2 text-ui text-fg-3">
        <Folder className="size-3.5" />
        <span className="font-medium text-fg-2">{project}</span>
        <span
          className="max-w-[340px] truncate font-mono text-xs text-fg-3 @max-[640px]/pane:hidden"
          title={cwd}
        >
          {cwd}
        </span>
      </motion.div>

      <motion.div variants={fadeUp} className="mt-10 grid w-full grid-cols-2 gap-2.5 short:mt-6">
        {suggestionsFor(project).map((s) => (
          <button
            key={s.title}
            type="button"
            disabled={!ready}
            onClick={() => send(s.prompt)}
            className="group flex items-start gap-3 rounded-card bg-surface-2 px-3.5 py-3 text-left cramped:items-center cramped:py-2.5 shadow-[var(--highlight),0_0_0_1px_var(--hairline)] transition-[background-color,box-shadow,transform] duration-[var(--dur-base)] ease-[var(--ease-out)] hover:-translate-y-px hover:bg-surface-3 hover:shadow-[var(--highlight),0_0_0_1px_var(--hairline-strong),var(--shadow-md)] disabled:opacity-50"
          >
            <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-md bg-hover text-fg-3 transition-colors group-hover:bg-accent-soft group-hover:text-accent-text [&_svg]:size-4">
              {s.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-ui font-medium text-fg">{s.title}</span>
              <span className="mt-0.5 block text-xs text-fg-3 cramped:hidden">{s.hint}</span>
            </span>
          </button>
        ))}
      </motion.div>

      {recent.length > 0 && (
        <motion.div variants={fadeUp} className="mt-9 w-full short:hidden">
          <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium text-fg-3">
            Recent in {project}
          </div>
          <div className="flex flex-col">
            {recent.map((session) => (
              <button
                key={session.path}
                type="button"
                disabled={!ready}
                onClick={() => void openRecent(agentId, session)}
                className="group flex h-9 items-center gap-3 rounded-md px-2.5 text-left transition-colors hover:bg-hover"
              >
                <History className="size-3.5 shrink-0 text-fg-3 transition-colors group-hover:text-fg-2" />
                <span className="min-w-0 flex-1 truncate text-ui text-fg-2 group-hover:text-fg">{itemTitle(session)}</span>
                <span className="shrink-0 text-xs text-fg-3 tabular">
                  {session.messageCount} msgs · {formatRelativeTime(session.modifiedAt)}
                </span>
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </motion.div>
  )
}
