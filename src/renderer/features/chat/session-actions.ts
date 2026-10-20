import type { UserMessage } from '@shared/engine-types'
import { bridge } from '../../lib/bridge'
import { rpc } from '../../lib/engine'
import { useAgents } from '../../store/agents'
import { toast } from '../../ui'
import { setDraftText } from '../composer/drafts'
import { forkAt, targetForAgent } from '../sessions'
import { cloneSession } from '../sessions/actions'
import { toastFailure } from './failure-toast'
import { userText, type TurnInfo } from './transcript-items'

/** Session entry of a user message (matched by timestamp, falling back to text). */
async function userEntry(agentId: string, message: UserMessage): Promise<{ entryId: string; parentId: string | null }> {
  const { entries } = await rpc(agentId, { type: 'get_entries' })
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.type === 'message' && entry.message.role === 'user' && entry.message.timestamp === message.timestamp) return { entryId: entry.id, parentId: entry.parentId }
  }
  const text = userText(message)
  const { messages } = await rpc(agentId, { type: 'get_fork_messages' })
  const match = [...messages].reverse().find((m) => m.text === text)
  if (match) return { entryId: match.entryId, parentId: entries.find((e) => e.id === match.entryId)?.parentId ?? null }
  throw new Error('This message is not part of the saved session.')
}

async function guarded(title: string, action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    toastFailure(title, error)
  }
}

/** The sessions feature's fork (one fork path for the app): new session ending before `message`, text back in the composer. */
async function forkBefore(agentId: string, message: UserMessage): Promise<void> {
  const target = targetForAgent(agentId)
  if (!target) return
  const { entryId, parentId } = await userEntry(agentId, message)
  await forkAt(target, { entryId, parentId, text: userText(message) })
}

/**
 * Edit & resend. With the bridge: move the session leaf to just before this message in place (same file,
 * like the TUI's /tree) and put its text in the composer. Without it: fork into a new session.
 */
export function editAndResend(agentId: string, message: UserMessage): Promise<void> {
  return guarded('Could not edit this message', async () => {
    if (!bridge.available(agentId)) return forkBefore(agentId, message)
    const { entryId } = await userEntry(agentId, message)
    const result = await bridge.navigateTree(agentId, entryId)
    if (result.cancelled) {
      toast({ level: 'info', title: 'Cancelled by an extension' })
      return
    }
    setDraftText(agentId, result.editorText ?? userText(message))
  })
}

/** Continue in a new session that contains everything up to the end of this turn. */
export function forkFromTurn(agentId: string, turn: TurnInfo): Promise<void> {
  return guarded('Could not fork the session', async () => {
    if (turn.next) return forkBefore(agentId, turn.next)
    const target = targetForAgent(agentId)
    if (target) await cloneSession(target)
  })
}

/**
 * Re-run the turn from its prompt. With the bridge the leaf moves back in place (same session file);
 * without it the engine forks before the prompt (in place, like /fork). Then the prompt is sent again.
 */
export function retryTurn(agentId: string, turn: TurnInfo): Promise<void> {
  return guarded('Could not retry', async () => {
    const prompt = turn.prompt
    if (!prompt) return
    const { entryId } = await userEntry(agentId, prompt)
    if (bridge.available(agentId)) {
      if ((await bridge.navigateTree(agentId, entryId)).cancelled) return
    } else {
      if ((await rpc(agentId, { type: 'fork', entryId })).cancelled) return
      await useAgents.getState().refresh(agentId)
    }
    const images = typeof prompt.content === 'string' ? [] : prompt.content.filter((c) => c.type === 'image')
    await useAgents.getState().prompt(agentId, userText(prompt), { images: images.length > 0 ? images : undefined })
  })
}
