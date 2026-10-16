import { createContext, useCallback, useContext, useState } from 'react'
import { create } from 'zustand'
import type { ToolCall } from '@shared/engine-types'
import type { ToolExecution } from '../../store/agent-state'
import { useAgents } from '../../store/agents'

/**
 * Open/closed state of transcript disclosures (tool rows, activity groups, thinking blocks, "show more"
 * toggles). It lives outside the components so it survives unmounting (the virtualized transcript
 * unmounts off-screen turns) and so the app-level "expand all tool output" switch (Ctrl+O, pi's
 * `app.tools.expand`) can reset every card at once.
 */
interface DisclosureStore {
  /** App-level: every tool card, activity stack and output preview opens fully. */
  toolsExpanded: boolean
  /** Explicit choices owned by open agents, then keyed by disclosure. */
  open: Record<string, Record<string, boolean>>
}

const useDisclosureStore = create<DisclosureStore>()(() => ({ toolsExpanded: false, open: {} }))
export const DisclosureAgentContext = createContext<string | null>(null)

const unsubscribeDisclosures = useAgents.subscribe((state, previous) => {
  if (state.order === previous.order) return
  const choices = useDisclosureStore.getState().open
  const removed = Object.keys(choices).filter((agentId) => !state.agents[agentId])
  if (removed.length === 0) return
  const open = { ...choices }
  for (const agentId of removed) delete open[agentId]
  useDisclosureStore.setState({ open })
})
import.meta.hot?.dispose(unsubscribeDisclosures)

/** Whether tool output is expanded app-wide (Ctrl+O). */
export function useToolsExpanded(): boolean {
  return useDisclosureStore((s) => s.toolsExpanded)
}

/** Expand or collapse all tool output; per-card choices reset so every card follows. */
export function setToolsExpanded(expanded: boolean): void {
  useDisclosureStore.setState({ toolsExpanded: expanded, open: {} })
}

export function toggleToolsExpanded(): void {
  setToolsExpanded(!useDisclosureStore.getState().toolsExpanded)
}

/**
 * Open state of one disclosure. `fallback` applies until the user toggles it (it may change over time,
 * e.g. a card that fails opens). Without a key the state is local to the component.
 */
export function useDisclosure(
  key: string | null,
  fallback: boolean
): [boolean, (open: boolean) => void] {
  const [choice, setChoice] = useDisclosureChoice(key)
  return [choice ?? fallback, setChoice]
}

/** The user's explicit open/closed choice for a keyed disclosure (undefined until they toggle it). */
export function useDisclosureChoice(
  key: string | null
): [boolean | undefined, (open: boolean) => void] {
  const agentId = useContext(DisclosureAgentContext)
  const stored = useDisclosureStore((state) =>
    agentId && key ? state.open[agentId]?.[key] : undefined
  )
  const [local, setLocal] = useState<boolean | undefined>(undefined)
  const setChoice = useCallback(
    (open: boolean) => {
      if (!agentId || !key) {
        setLocal(open)
        return
      }
      // Exiting views can outlive their closed agent during the shell's transition.
      if (!useAgents.getState().agents[agentId]) return
      useDisclosureStore.setState((state) => ({
        open: { ...state.open, [agentId]: { ...state.open[agentId], [key]: open } }
      }))
    },
    [agentId, key]
  )
  return [agentId && key ? stored : local, setChoice]
}

/**
 * The tool call being rendered (provided by ToolCallView): rows key their disclosure by its id, and the detail
 * well's Raw view shows its arguments and result.
 */
export interface ToolCallScope {
  call: ToolCall
  execution: ToolExecution | undefined
}

export const ToolCallContext = createContext<ToolCallScope | null>(null)

export function useToolCallScope(): ToolCallScope | null {
  return useContext(ToolCallContext)
}

export function useToolCallId(): string | null {
  return useContext(ToolCallContext)?.call.id ?? null
}
