import { create } from 'zustand'
import { invoke, on } from '../../lib/ipc'
import { useAgents } from '../../store/agents'

interface SideQuestionTurn {
  question: string
  answer: string
}

interface SideQuestionState {
  id: string
  question: string
  answer: string
  status: string
  error: string
  previousTurns: SideQuestionTurn[]
}

interface SideQuestionsStore {
  sessions: Record<string, SideQuestionState>
  ask(agentId: string, question: string): Promise<void>
  abort(agentId: string): Promise<void>
}

export const useSideQuestions = create<SideQuestionsStore>((set, get) => ({
  sessions: {},
  async ask(agentId, question) {
    const current = get().sessions[agentId]
    if (current?.status === 'running') throw new Error('A side question is already running.')
    const sideQuestionId = crypto.randomUUID()
    const previousTurns = current
      ? [
          ...current.previousTurns,
          ...(current.status === 'complete'
            ? [{ question: current.question, answer: current.answer }]
            : [])
        ]
      : []
    set((state) => ({
      sessions: {
        ...state.sessions,
        [agentId]: {
          id: sideQuestionId,
          question,
          answer: '',
          status: 'running',
          error: '',
          previousTurns
        }
      }
    }))
    try {
      await invoke('prime:command', agentId, 'start_side_question', {
        sideQuestionId,
        question,
        previousTurns
      })
    } catch (error) {
      const active = get().sessions[agentId]
      if (active?.id === sideQuestionId && active.status === 'running') {
        set((state) => ({
          sessions: {
            ...state.sessions,
            [agentId]: {
              ...active,
              status: 'error',
              error: error instanceof Error ? error.message : String(error)
            }
          }
        }))
      }
      throw error
    }
  },
  async abort(agentId) {
    const current = get().sessions[agentId]
    if (current?.status === 'running') {
      await invoke('prime:command', agentId, 'abort_side_question', {
        sideQuestionId: current.id
      })
    }
  }
}))

function interruptQuestion(agentId: string): void {
  useSideQuestions.setState((state) => {
    const current = state.sessions[agentId]
    if (current?.status !== 'running') return state
    return {
      sessions: {
        ...state.sessions,
        [agentId]: {
          ...current,
          status: 'interrupted',
          error: 'The session connection closed. You can ask again after it reconnects.'
        }
      }
    }
  })
}

/** Native side-question events are not replayed, so their listener must outlive session panes. */
export function startPrimeSideQuestionEvents(): () => void {
  const unsubscribe = [
    on('engine:event', ({ agentId, event }) => {
      if (
        event.type !== 'engine_native_event' ||
        event.engine !== 'prime' ||
        event.name !== 'side_question_event'
      )
        return
      const nested = event.data.event
      const payload =
        nested && typeof nested === 'object' && !Array.isArray(nested)
          ? (nested as Record<string, unknown>)
          : event.data
      useSideQuestions.setState((state) => {
        const current = state.sessions[agentId]
        if (current?.status !== 'running' || current.id !== payload.id) return state
        return {
          sessions: {
            ...state.sessions,
            [agentId]: {
              ...current,
              answer: typeof payload.answer === 'string' ? payload.answer : current.answer,
              status: typeof payload.status === 'string' ? payload.status : current.status,
              error: typeof payload.errorMessage === 'string' ? payload.errorMessage : ''
            }
          }
        }
      })
    }),
    on('engine:status', ({ agentId, status }) => {
      if (status !== 'ready') interruptQuestion(agentId)
    }),
    on('engine:exit', ({ agentId }) => interruptQuestion(agentId)),
    useAgents.subscribe((state, previous) => {
      if (state.order === previous.order) return
      useSideQuestions.setState((questions) => {
        const removed = Object.keys(questions.sessions).filter((agentId) => !state.agents[agentId])
        if (removed.length === 0) return questions
        const sessions = { ...questions.sessions }
        for (const agentId of removed) delete sessions[agentId]
        return { sessions }
      })
    })
  ]
  return () => {
    for (const stop of unsubscribe) stop()
  }
}
