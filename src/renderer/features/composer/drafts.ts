import { create } from 'zustand'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'

export interface ImageAttachment {
  id: string
  name: string
  mimeType: string
  /** base64 (already resized/compressed for sending). */
  data: string
  width: number
  height: number
  bytes: number
}

/** Placeholder shown in the tray while an image is decoded/resized. */
export interface PendingAttachment {
  id: string
  name: string
}

export interface Draft {
  text: string
  images: ImageAttachment[]
  pending: PendingAttachment[]
  /** Last `set_editor_text` nonce applied to this draft. */
  editorNonce: number
}

const EMPTY: Draft = { text: '', images: [], pending: [], editorNonce: 0 }

export type DraftPatch = Partial<Draft> | ((draft: Draft) => Partial<Draft>)

interface DraftStore {
  drafts: Record<string, Draft>
  /** Bumped by requestComposerFocus(); the mounted composer focuses its textarea. */
  focusRequest: number
  draftOf(agentId: string): Draft
  patch(agentId: string, patch: DraftPatch): void
  clear(agentId: string): void
}

/** Per-agent composer drafts: switching sessions keeps text and attachments. */
export const useDrafts = create<DraftStore>()((set, get) => ({
  drafts: {},
  focusRequest: 0,
  draftOf: (agentId) => get().drafts[agentId] ?? EMPTY,
  patch(agentId, patch) {
    set((state) => {
      const current = state.drafts[agentId] ?? EMPTY
      const next = typeof patch === 'function' ? patch(current) : patch
      return { drafts: { ...state.drafts, [agentId]: { ...current, ...next } } }
    })
  },
  clear(agentId) {
    set((state) => {
      const current = state.drafts[agentId] ?? EMPTY
      return { drafts: { ...state.drafts, [agentId]: { ...EMPTY, editorNonce: current.editorNonce } } }
    })
  }
}))

export function useDraft(agentId: string): Draft {
  return useDrafts((s) => s.drafts[agentId] ?? EMPTY)
}

/** Replace an agent's draft text (e.g. a prompt template picked in the palette) and focus the composer. */
export function setDraftText(agentId: string, text: string): void {
  useDrafts.getState().patch(agentId, { text })
  focusComposer()
}

/** Focus the active session's composer. */
export function focusComposer(): void {
  useDrafts.setState((s) => ({ focusRequest: s.focusRequest + 1 }))
}

// Drop drafts of disposed agents.
useAgents.subscribe((state, previous) => {
  if (state.order === previous.order) return
  const { drafts } = useDrafts.getState()
  const stale = Object.keys(drafts).filter((id) => !state.agents[id])
  if (stale.length === 0) return
  const next = { ...drafts }
  for (const id of stale) delete next[id]
  useDrafts.setState({ drafts: next })
})

// ─── Prompt history (persisted, shell-like Up/Down) ──────────────────────────────────────────

const HISTORY_LIMIT = 200

export function promptHistory(): string[] {
  return useApp.getState().prefs.features.composer?.history ?? []
}

export function pushHistory(text: string): void {
  const prefs = useApp.getState().prefs.features.composer ?? {}
  const history = (prefs.history ?? []).filter((entry) => entry !== text)
  history.push(text)
  useApp.getState().updateFeaturePrefs('composer', { ...prefs, history: history.slice(-HISTORY_LIMIT) })
}
