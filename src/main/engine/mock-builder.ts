import { structuredPatch } from 'diff'
import type {
  AgentMessage,
  AssistantContent,
  AssistantMessage,
  EngineEvent,
  ExtensionUIDialogRequest,
  Model,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
  ToolResultPayload,
  Usage,
  UserMessage
} from '@shared/engine-types'

/** One scripted mock step: emit an event, or block on an extension dialog until the client answers. */
export type MockStep =
  | { kind: 'event'; label?: string; delay: number; event: EngineEvent }
  | {
      kind: 'dialog'
      label?: string
      delay: number
      request: ExtensionUIDialogRequest
      /** Steps to run after the answer (null = cancelled/timeout). */
      then: (response: RpcExtensionUIResponse | null) => MockStep[]
    }

export interface ScriptContext {
  model: Model
  thinkingLevel: ThinkingLevel
  cwd: string
  prompt: string
  now: number
}

type Part =
  | { thinking: string; labelAt?: string }
  | { text: string; labelAt?: string }
  | { tool: ToolCall }

let idCounter = 0
export function uid(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(4, '0')}`
}

/** Split text into token-like chunks (1–3 words incl. whitespace). */
function chunkWords(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [text]
  const chunks: string[] = []
  for (let i = 0; i < words.length; ) {
    const take = 1 + ((i * 7) % 3)
    chunks.push(words.slice(i, i + take).join(''))
    i += take
  }
  return chunks
}

function chunkChars(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

export class ScriptBuilder {
  readonly steps: MockStep[] = []
  /** Messages produced by this run (for agent_end). */
  readonly produced: AgentMessage[] = []
  private nextLabel: string | undefined
  private nextDelay = 0
  private clock: number
  private turnInput: number

  constructor(private readonly ctx: ScriptContext) {
    this.clock = ctx.now
    this.turnInput = 9_400 + Math.round(ctx.prompt.length * 0.3)
  }

  label(name: string): this {
    this.nextLabel = name
    return this
  }

  wait(ms: number): this {
    this.nextDelay += ms
    return this
  }

  emit(event: EngineEvent, delay = 0): this {
    const total = this.nextDelay + delay
    this.steps.push({ kind: 'event', event, delay: total, label: this.takeLabel() })
    this.nextDelay = 0
    this.clock += total
    return this
  }

  ui(request: RpcExtensionUIRequest, delay = 0): this {
    return this.emit(request, delay)
  }

  dialog(request: ExtensionUIDialogRequest, then: (response: RpcExtensionUIResponse | null) => MockStep[], delay = 0): this {
    this.steps.push({ kind: 'dialog', request, then, delay: this.nextDelay + delay, label: this.takeLabel() })
    this.nextDelay = 0
    return this
  }

  user(text: string): UserMessage {
    const message: UserMessage = { role: 'user', content: text, timestamp: this.clock }
    this.emit({ type: 'message_start', message })
    this.emit({ type: 'message_end', message }, 16)
    this.produced.push(message)
    return message
  }

  usage(output: number): Usage {
    const input = 1_200 + Math.round(output * 0.1)
    const cacheRead = this.turnInput
    const cost = this.ctx.model.cost
    const c = {
      input: (input * cost.input) / 1e6,
      output: (output * cost.output) / 1e6,
      cacheRead: (cacheRead * cost.cacheRead) / 1e6,
      cacheWrite: 0
    }
    return {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output + cacheRead,
      cost: { ...c, total: c.input + c.output + c.cacheRead + c.cacheWrite }
    }
  }

  assistant(parts: Part[], stopReason: AssistantMessage['stopReason'] = 'toolUse', errorMessage?: string): AssistantMessage {
    const base: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: this.ctx.model.api,
      provider: this.ctx.model.provider,
      model: this.ctx.model.id,
      thinkingLevel: this.ctx.thinkingLevel,
      usage: this.usage(0),
      stopReason: 'pending',
      timestamp: this.clock
    }
    this.emit({ type: 'message_start', message: base }, 260)
    const content: AssistantContent[] = []
    let output = 0
    const update = (assistantMessageEvent: Extract<EngineEvent, { type: 'message_update' }>['assistantMessageEvent'], delay: number) => {
      this.emit({ type: 'message_update', usage: this.usage(output), assistantMessageEvent }, delay)
    }
    parts.forEach((part, contentIndex) => {
      if ('thinking' in part) {
        update({ type: 'thinking_start', contentIndex }, 40)
        const chunks = chunkWords(part.thinking)
        chunks.forEach((delta, i) => {
          if (part.labelAt && i === Math.floor(chunks.length / 2)) this.label(part.labelAt)
          output += 2
          update({ type: 'thinking_delta', contentIndex, delta }, 16)
        })
        update({ type: 'thinking_end', contentIndex, content: part.thinking }, 20)
        content.push({ type: 'thinking', thinking: part.thinking, thinkingSignature: 'sig_mock' })
      } else if ('text' in part) {
        update({ type: 'text_start', contentIndex }, 30)
        const chunks = chunkWords(part.text)
        chunks.forEach((delta, i) => {
          if (part.labelAt && i === Math.floor(chunks.length / 2)) this.label(part.labelAt)
          output += 2
          update({ type: 'text_delta', contentIndex, delta }, 24)
        })
        update({ type: 'text_end', contentIndex, content: part.text }, 16)
        content.push({ type: 'text', text: part.text })
      } else {
        const call = part.tool
        update({ type: 'toolcall_start', contentIndex, id: call.id, toolName: call.name }, 60)
        for (const delta of chunkChars(JSON.stringify(call.arguments), 48)) {
          output += 6
          update({ type: 'toolcall_delta', contentIndex, delta }, 8)
        }
        update({ type: 'toolcall_end', contentIndex, toolCall: call }, 12)
        content.push(call)
      }
    })
    const final: AssistantMessage = { ...base, content, usage: this.usage(output), stopReason, errorMessage }
    this.emit({ type: 'message_end', message: final }, 30)
    this.produced.push(final)
    this.turnInput += output + 1_800
    return final
  }

  tool(
    call: ToolCall,
    result: ToolResultPayload,
    opts: { durationMs: number; isError?: boolean; updates?: ToolResultPayload[]; during?: (b: ScriptBuilder) => void }
  ): ToolResultMessage {
    const isError = opts.isError ?? false
    this.emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments }, 40)
    for (const partial of opts.updates ?? []) {
      this.emit(
        { type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args: call.arguments, partialResult: partial },
        Math.round(opts.durationMs / ((opts.updates?.length ?? 0) + 1))
      )
    }
    opts.during?.(this)
    this.emit(
      { type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError, durationMs: opts.durationMs },
      opts.updates ? 120 : Math.min(opts.durationMs, 900)
    )
    const message: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      details: result.details,
      isError,
      durationMs: opts.durationMs,
      timestamp: this.clock
    }
    this.emit({ type: 'message_start', message })
    this.emit({ type: 'message_end', message })
    this.produced.push(message)
    return message
  }

  turn(body: () => { message: AssistantMessage; results: ToolResultMessage[] }): void {
    this.emit({ type: 'turn_start' })
    const { message, results } = body()
    this.emit({ type: 'turn_end', message, toolResults: results }, 20)
  }

  private takeLabel(): string | undefined {
    const label = this.nextLabel
    this.nextLabel = undefined
    return label
  }
}

export function call(name: string, args: Record<string, unknown>): ToolCall {
  return { type: 'toolCall', id: uid('toolu'), name, arguments: args }
}

export function text(value: string): ToolResultPayload {
  return { content: [{ type: 'text', text: value }], details: {} }
}

/** pi's display-oriented edit diff: `±<line> <content>` rows with `...` between hunks. */
export function displayDiff(oldText: string, newText: string): string {
  const patch = structuredPatch('a', 'b', oldText, newText, undefined, undefined, { context: 3 })
  const width = String(Math.max(oldText.split('\n').length, newText.split('\n').length)).length
  const rows: string[] = []
  for (const hunk of patch.hunks) {
    rows.push(`${' '.repeat(width + 1)}...`)
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const line of hunk.lines) {
      const sign = line[0]
      const body = line.slice(1)
      if (sign === '-') rows.push(`-${String(oldLine++).padStart(width)} ${body}`)
      else if (sign === '+') rows.push(`+${String(newLine++).padStart(width)} ${body}`)
      else if (sign === ' ') {
        rows.push(` ${String(newLine).padStart(width)} ${body}`)
        oldLine++
        newLine++
      }
    }
  }
  return rows.join('\n')
}

