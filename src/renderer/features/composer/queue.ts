import type { ImageContent } from '@shared/engine-types'
import { rpc } from '../../lib/engine'
import { useAgents } from '../../store/agents'
import type { ImageAttachment } from './drafts'

/**
 * Images of queued steering/follow-up messages. The engine's queue (queue_update, clear_queue) carries text
 * only, so the composer remembers what it attached to each message it queued. Removing one queued message
 * (clear_queue + re-queue) and restoring the queue into the editor then keep their images.
 */

export type QueueKind = 'steering' | 'followUp'

export interface QueuedMessage {
  kind: QueueKind
  text: string
  /** The draft attachments sent with the message, so they can return to the editor as they were. */
  images: ImageAttachment[]
}

export function toImageContent(image: ImageAttachment): ImageContent {
  return { type: 'image', data: image.data, mimeType: image.mimeType }
}

interface SentRecord extends QueuedMessage {
  rememberedAt: number
}

const sent = new Map<string, SentRecord[]>()

/**
 * A record younger than this survives a queue_update that does not list it yet: the steer/follow-up response
 * resolves before the rAF-batched queue_update reaches the store.
 */
const QUEUE_UPDATE_GRACE_MS = 1000

/** Remember a message the composer queued while the agent was running (only needed when it has images). */
export function rememberQueued(agentId: string, message: QueuedMessage): void {
  if (message.images.length === 0) return
  sent.set(agentId, [...(sent.get(agentId) ?? []), { ...message, rememberedAt: Date.now() }])
}

/** Records still in the engine queue (matched by kind + text, one record per queued copy) or remembered just now. */
function stillQueued(
  records: SentRecord[],
  queue: { steering: string[]; followUp: string[] },
  now: number
): SentRecord[] {
  const left = { steering: [...queue.steering], followUp: [...queue.followUp] }
  return records.filter((record) => {
    const at = left[record.kind].indexOf(record.text)
    if (at >= 0) {
      left[record.kind].splice(at, 1)
      return true
    }
    return now - record.rememberedAt < QUEUE_UPDATE_GRACE_MS
  })
}

/**
 * Drop stale records (r5 N7): messages the engine delivered (gone from `queue_update`), everything once the run
 * settles, and all records of a disposed agent. Only agents with records are inspected, so streaming frames
 * cost one map lookup.
 */
const seenQueues = new Map<string, unknown>()
useAgents.subscribe((state) => {
  for (const [agentId, records] of sent) {
    const agent = state.agents[agentId]
    if (!agent || agent.phase !== 'running') {
      sent.delete(agentId)
      seenQueues.delete(agentId)
      continue
    }
    if (seenQueues.get(agentId) === agent.queue) continue
    seenQueues.set(agentId, agent.queue)
    const kept = stillQueued(records, agent.queue, Date.now())
    if (kept.length === 0) {
      sent.delete(agentId)
      seenQueues.delete(agentId)
    } else if (kept.length !== records.length) sent.set(agentId, kept)
  }
})

/** Image count of a queued message, matched by kind + text in queue order (`index` = position among equal texts). */
export function queuedImageCount(
  agentId: string,
  kind: QueueKind,
  text: string,
  index: number
): number {
  return (
    (sent.get(agentId) ?? []).filter((m) => m.kind === kind && m.text === text)[index]?.images
      .length ?? 0
  )
}

/**
 * Pair texts returned by `clear_queue` with their remembered images, in engine order (steering first). Records
 * of messages the engine already delivered are dropped.
 */
function takeQueued(
  agentId: string,
  cleared: { steering: string[]; followUp: string[] },
  remembered: SentRecord[]
): QueuedMessage[] {
  const pool = [...remembered]
  sent.delete(agentId)
  seenQueues.delete(agentId)
  const pick = (kind: QueueKind, text: string): QueuedMessage => {
    const at = pool.findIndex((m) => m.kind === kind && m.text === text)
    const images = at >= 0 ? pool.splice(at, 1)[0]!.images : []
    return { kind, text, images }
  }
  return [
    ...cleared.steering.map((text) => pick('steering', text)),
    ...cleared.followUp.map((text) => pick('followUp', text))
  ]
}

/** Pull every queued message back out of the engine (text + images), e.g. to restore it into the editor. */
export async function drainQueue(agentId: string): Promise<QueuedMessage[]> {
  // clearQueue flushes queue events, whose subscriber can discard the attachment records.
  const remembered = [...(sent.get(agentId) ?? [])]
  return takeQueued(agentId, await useAgents.getState().clearQueue(agentId), remembered)
}

/**
 * Queue messages again in order. Stops once the agent is no longer running (a queued message would start a
 * new run) or at the first failure, and returns the messages that were not queued, for the editor.
 */
export async function requeue(
  agentId: string,
  messages: QueuedMessage[]
): Promise<QueuedMessage[]> {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!
    const images = message.images.length ? message.images.map(toImageContent) : undefined
    if (useAgents.getState().agents[agentId]?.phase !== 'running') return messages.slice(i)
    try {
      if (message.kind === 'steering')
        await rpc(agentId, { type: 'steer', message: message.text, images })
      else await rpc(agentId, { type: 'follow_up', message: message.text, images })
      rememberQueued(agentId, message)
    } catch {
      return messages.slice(i)
    }
  }
  return []
}
