import type {
  AssistantMessage,
  AssistantMessageEvent,
  EngineEvent,
  ToolResultPayload
} from '@shared/engine-types'
import { normalizeMessage, normalizeUsage, sanitizeNativeModels } from './normalize'
import { asRecord, stringValue, type PrimeRecord } from './transport'

interface ToolMetadata {
  name: string
  args: PrimeRecord
}

const COMMON_EVENTS = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished'
])

export class PrimeEventAdapter {
  private assistant: AssistantMessage | undefined
  private readonly tools = new Map<string, ToolMetadata>()
  private aborted = false
  private busy = false

  constructor(private readonly emit: (event: EngineEvent) => void) {}

  markAborted(): void {
    this.aborted = true
  }

  restore(state: PrimeRecord, messages: unknown[]): void {
    this.busy =
      state.isStreaming === true || state.isCompacting === true || state.isBashRunning === true
    this.aborted = false
    this.tools.clear()
    const last = messages.findLast((value) => asRecord(value).role === 'assistant')
    const message = last ? normalizeMessage(last) : undefined
    this.assistant = undefined
    if (message?.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall')
          this.tools.set(block.id, { name: block.name, args: block.arguments })
      }
    }
  }

  accept(event: PrimeRecord): void {
    const type = stringValue(event.type) ?? 'unknown'
    if (type === 'message_start' || type === 'message_end') {
      const message = normalizeMessage(event.message)
      if (message.role === 'assistant') {
        this.assistant = type === 'message_start' ? message : undefined
      }
      this.emit({ type, message })
      return
    }
    if (type === 'message_update') {
      this.updateMessage(event)
      return
    }
    if (type.startsWith('tool_execution_')) {
      this.updateTool(type, event)
      return
    }
    if (type === 'agent_end') {
      this.emit({
        type: 'agent_end',
        messages: Array.isArray(event.messages) ? event.messages.map(normalizeMessage) : [],
        willRetry: event.willRetry === true
      })
      return
    }
    if (type === 'session_action_update') {
      const actions = asRecord(event.actions)
      this.emit({
        type: 'queue_update',
        steering: stringArray(actions.steering),
        followUp: stringArray(actions.followUps ?? actions.followUp)
      })
      if (!actions.active && !actions.queuedCount && this.busy) this.settle()
    } else if (type === 'compaction_start' || type === 'compaction_end') {
      const reason =
        event.reason === 'overflow' || event.reason === 'threshold' ? event.reason : 'manual'
      // Native compaction results use the common summary/usage payload.
      this.emit({ ...event, type, reason } as EngineEvent)
      return
    } else if (type === 'bash_execution_update') {
      this.emit({
        type,
        id: stringValue(event.runId) ?? stringValue(event.id),
        delta: stringValue(event.delta) ?? stringValue(event.output) ?? ''
      })
      return
    } else if (COMMON_EVENTS.has(type)) {
      if (type === 'agent_start') {
        this.busy = true
        this.aborted = false
      }
      // These native event names share their documented common wire payloads.
      this.emit(event as unknown as EngineEvent)
      return
    }
    this.emit({
      type: 'engine_native_event',
      engine: 'prime',
      name: type,
      data: sanitizeNativeModels(event)
    })
  }

  settle(): void {
    if (!this.busy) return
    this.busy = false
    this.emit({ type: 'agent_settled', aborted: this.aborted })
  }

  private updateMessage(event: PrimeRecord): void {
    const message = normalizeMessage(event.message)
    if (message.role !== 'assistant') return
    if (!this.assistant) {
      this.emit({ type: 'message_start', message: { ...message, content: [] } })
    }
    const before = this.assistant?.content ?? []
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const block = message.content[contentIndex]!
      const previous = before[contentIndex]
      let update: AssistantMessageEvent | undefined
      if (block.type === 'text') {
        const oldText = previous?.type === 'text' ? previous.text : ''
        // Empty provider blocks still occupy an index before subsequent text or tool calls.
        if (previous?.type === 'text' && block.text === oldText) continue
        update = block.text.startsWith(oldText)
          ? { type: 'text_delta', contentIndex, delta: block.text.slice(oldText.length) }
          : { type: 'text_end', contentIndex, content: block.text }
      } else if (block.type === 'thinking') {
        const oldThinking = previous?.type === 'thinking' ? previous.thinking : ''
        if (previous?.type === 'thinking' && block.thinking === oldThinking) continue
        update = block.thinking.startsWith(oldThinking)
          ? {
              type: 'thinking_delta',
              contentIndex,
              delta: block.thinking.slice(oldThinking.length)
            }
          : { type: 'thinking_end', contentIndex, content: block.thinking }
      } else if (block.type === 'toolCall') {
        if (previous?.type !== 'toolCall') {
          this.emit({
            type: 'message_update',
            usage: message.usage,
            assistantMessageEvent: {
              type: 'toolcall_start',
              contentIndex,
              id: block.id,
              toolName: block.name
            }
          })
        }
        update = { type: 'toolcall_end', contentIndex, toolCall: block }
      }
      if (update) {
        this.emit({ type: 'message_update', usage: message.usage, assistantMessageEvent: update })
      }
    }
    this.assistant = message
    if (message.content.length === 0) {
      this.emit({
        type: 'message_update',
        usage: normalizeUsage(message.usage),
        assistantMessageEvent: { type: 'start' }
      })
    }
  }

  private updateTool(type: string, event: PrimeRecord): void {
    const toolCallId = stringValue(event.toolCallId)
    if (!toolCallId) return
    const metadata = this.tools.get(toolCallId)
    const toolName = stringValue(event.toolName) ?? metadata?.name ?? 'tool'
    const args = event.args ? asRecord(event.args) : (metadata?.args ?? {})
    if (type === 'tool_execution_start') {
      this.tools.set(toolCallId, { name: toolName, args })
      this.emit({ type, toolCallId, toolName, args })
    } else if (type === 'tool_execution_update') {
      this.emit({
        type,
        toolCallId,
        toolName,
        args,
        partialResult: toolResult(event.partialResult)
      })
    } else if (type === 'tool_execution_end') {
      this.tools.delete(toolCallId)
      this.emit({
        type,
        toolCallId,
        toolName,
        result: toolResult(event.result),
        isError: event.isError === true
      })
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function toolResult(value: unknown): ToolResultPayload {
  const result = asRecord(value)
  // Tool payload content is an open native text/image protocol boundary.
  return {
    ...result,
    content: Array.isArray(result.content)
      ? result.content
      : [{ type: 'text', text: String(value ?? '') }]
  } as ToolResultPayload
}
