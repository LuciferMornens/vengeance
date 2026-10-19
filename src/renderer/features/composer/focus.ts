import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { useAgents } from '../../store/agents'
import { useDrafts } from './drafts'

export interface OpeningFocus {
  pending: boolean
  owner?: Element | null
}

export function useComposerFocus(
  agentId: string,
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  opening: OpeningFocus
) {
  const focusRequest = useDrafts((state) => state.focusRequest)
  const handledFocusRequest = useRef(focusRequest)
  const focusedAgent = useRef<string | null>(null)
  const focus = useCallback(() => textareaRef.current?.focus(), [textareaRef])

  useEffect(() => {
    if (opening.pending || focusedAgent.current === agentId) return
    const current = document.activeElement
    if (opening.owner === undefined || current === opening.owner || current === document.body) {
      focus()
    }
    focusedAgent.current = agentId
  }, [agentId, focus, opening.pending, opening.owner])

  useEffect(() => {
    if (opening.pending || handledFocusRequest.current === focusRequest) return
    handledFocusRequest.current = focusRequest
    // Only the active pane answers; its initial focus waits until the opening layer is gone.
    if (focusRequest && useAgents.getState().activeAgentId === agentId) focus()
  }, [focusRequest, focus, agentId, opening.pending])

  return focus
}
