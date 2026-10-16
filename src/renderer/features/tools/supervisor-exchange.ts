import type { ToolCall } from '@shared/engine-types'
import { asSupervisorRequest, parseSupervisorReplyPrompt, SUBAGENT_MESSAGE_TYPES } from '@shared/subagents'
import type { TranscriptEntry } from '../../store/agent-state'
import { useAgents } from '../../store/agents'
import { str } from './tool-utils'

/**
 * A supervisor exchange (a child's question, the user's answer from the app, the parent relaying it) reads as
 * one row: the request row carries the answer, and the reply prompt and the relay call stay out of the transcript.
 */
export interface SupervisorExchanges {
  /** Request ids with a request notice in the transcript. */
  requests: ReadonlySet<string>
  /** The user's answer per request id, from the reply prompts the app sent. */
  userReplies: ReadonlyMap<string, string>
}

const exchangeCache = new WeakMap<TranscriptEntry[], SupervisorExchanges>()

export function supervisorExchanges(entries: TranscriptEntry[]): SupervisorExchanges {
  let exchanges = exchangeCache.get(entries)
  if (exchanges) return exchanges
  const requests = new Set<string>()
  const userReplies = new Map<string, string>()
  for (const { message } of entries) {
    if (message.role === 'custom' && message.customType === SUBAGENT_MESSAGE_TYPES.supervisorRequest) {
      const request = asSupervisorRequest(message.details)
      if (request) requests.add(request.requestId)
    } else if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      const reply = parseSupervisorReplyPrompt(text)
      if (reply) userReplies.set(reply.requestId, reply.message)
    }
  }
  exchanges = { requests, userReplies }
  exchangeCache.set(entries, exchanges)
  return exchanges
}

function useExchanges<T>(agentId: string, select: (exchanges: SupervisorExchanges) => T, fallback: T): T {
  return useAgents((s) => {
    const entries = s.agents[agentId]?.entries
    return entries ? select(supervisorExchanges(entries)) : fallback
  })
}

/** The answer the user gave a supervisor request from the app, if they did. */
export function useUserSupervisorReply(agentId: string, requestId: string | undefined): string | undefined {
  return useExchanges(agentId, (exchanges) => (requestId ? exchanges.userReplies.get(requestId) : undefined), undefined)
}

/** Whether a request's notice is in the transcript (its row then shows the user's answer). */
export function useHasSupervisorRequest(agentId: string, requestId: string): boolean {
  return useExchanges(agentId, (exchanges) => exchanges.requests.has(requestId), false)
}

/** A `subagent_supervisor` call relaying an answer the user gave from the app. */
function isUserAnswerRelay(call: ToolCall, exchanges: SupervisorExchanges): boolean {
  if (call.name !== 'subagent_supervisor') return false
  const replyTo = str(call.arguments.replyTo)
  return replyTo !== undefined && exchanges.userReplies.has(replyTo)
}

/** Ids of the calls among `calls` that relay the user's answers (as one string, so a selector stays stable). */
export function useUserAnswerRelayIds(agentId: string, calls: ToolCall[]): string {
  return useExchanges(
    agentId,
    (exchanges) =>
      calls
        .filter((call) => isUserAnswerRelay(call, exchanges))
        .map((call) => call.id)
        .join(' '),
    ''
  )
}
