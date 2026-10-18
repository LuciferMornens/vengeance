import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeTreeResult, CreateAgentArgs } from '@shared/api/engine'
import type {
  AgentMessage,
  AssistantMessage,
  EngineEvent,
  FlatTreeNode,
  Model,
  QueueMode,
  RpcSessionState,
  SessionEntry,
  SessionStats,
  SessionTreeNode,
  ThinkingLevel,
  UserMessage
} from '@shared/engine-types'
import { MOCK_MODELS, thinkingLevelsFor } from './mock-data'
import { mockLongSessionEntries, mockSessionHistory } from './mock-sessions'
import { flattenSessionTree } from './session-tree'

export function hex8(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

export function sleep(ms: number, timers: Set<() => void>): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      timers.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timers.add(finish)
  })
}

export function textOf(message: UserMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
}

export abstract class MockSession {
  protected model: Model = MOCK_MODELS[0]!
  protected thinkingLevel: ThinkingLevel = 'medium'
  protected steeringMode: QueueMode = 'one-at-a-time'
  protected followUpMode: QueueMode = 'one-at-a-time'
  protected autoCompaction = true
  protected sessionId = randomUUID()
  protected sessionName: string | undefined
  protected messages: AgentMessage[] = []
  protected entries: SessionEntry[] = []
  protected leafId: string | null = null
  protected runsPlayed = 0
  protected streaming = false
  protected openAssistant: AssistantMessage | null = null
  protected readonly openTools = new Map<string, string>()
  protected steering: string[] = []
  protected followUp: string[] = []
  protected resumedFile: string | undefined

  protected constructor(protected readonly args: CreateAgentArgs) {}

  protected abstract publishSpeed(): void

  protected get sessionFile(): string | undefined {
    if (this.resumedFile) return this.resumedFile
    return this.args.noSession
      ? undefined
      : join(tmpdir(), 'vengeance-mock', `${this.sessionId}.jsonl`)
  }

  /** pi `navigateTree` semantics: a user message moves the leaf to its parent and returns its text. */
  protected navigateTree(
    targetId: string,
    summarize: boolean,
    label: string | undefined
  ): BridgeTreeResult {
    if (this.streaming)
      throw new Error('Wait for the current response to finish before navigating the session tree.')
    const target = this.entries.find((e) => e.id === targetId)
    if (!target) throw new Error(`Entry ${targetId} not found`)
    const oldLeaf = this.leafId
    const isUser = target.type === 'message' && target.message.role === 'user'
    const editorText = isUser && target.message.role === 'user' ? textOf(target.message) : undefined
    const newLeaf = isUser ? target.parentId : targetId
    this.leafId = newLeaf
    const now = new Date().toISOString()
    if (summarize && oldLeaf) {
      this.append({
        type: 'branch_summary',
        id: hex8(),
        parentId: newLeaf,
        timestamp: now,
        fromId: oldLeaf,
        summary:
          '## Abandoned branch\n- Explored the debounced persist path and drafted a dirty-set fix (mock summary).'
      })
    }
    if (label)
      this.append({
        type: 'label',
        id: hex8(),
        parentId: this.leafId,
        timestamp: now,
        targetId: summarize && oldLeaf ? this.leafId! : targetId,
        label
      })
    this.messages = this.branchMessages()
    this.publishSpeed()
    return { cancelled: false, leafId: this.leafId, editorText }
  }

  /** Entries on the path root \u2192 leaf. */
  protected branchPath(): SessionEntry[] {
    const byId = new Map(this.entries.map((e) => [e.id, e]))
    const path: SessionEntry[] = []
    for (let id = this.leafId; id;) {
      const entry = byId.get(id)
      if (!entry) break
      path.unshift(entry)
      id = entry.parentId
    }
    return path
  }

  /** Messages on the path root \u2192 leaf (what pi rebuilds the context from). */
  protected branchMessages(): AgentMessage[] {
    return this.branchPath().flatMap((entry): AgentMessage[] => {
      if (entry.type === 'message') return [entry.message]
      if (entry.type === 'custom_message')
        return [
          {
            role: 'custom',
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      if (entry.type === 'branch_summary')
        return [
          {
            role: 'branchSummary',
            summary: entry.summary,
            fromId: entry.fromId,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      if (entry.type === 'compaction')
        return [
          {
            role: 'compactionSummary',
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            timestamp: Date.parse(entry.timestamp)
          }
        ]
      return []
    })
  }

  // ─── Session model ─────────────────────────────────────────────────────────

  /** Track what the client would see so state queries stay consistent with the event stream. */
  protected observe(event: EngineEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.streaming = true
        break
      case 'agent_settled':
        this.streaming = false
        break
      case 'message_start':
        if (event.message.role === 'assistant') this.openAssistant = structuredClone(event.message)
        break
      case 'message_update': {
        const open = this.openAssistant
        const update = event.assistantMessageEvent
        if (!open || !('contentIndex' in update)) break
        const i = update.contentIndex
        if (update.type === 'text_start') open.content[i] = { type: 'text', text: '' }
        else if (update.type === 'text_delta') {
          const block = open.content[i]
          if (block?.type === 'text') block.text += update.delta
        } else if (update.type === 'thinking_start')
          open.content[i] = { type: 'thinking', thinking: '' }
        else if (update.type === 'thinking_delta') {
          const block = open.content[i]
          if (block?.type === 'thinking') block.thinking += update.delta
        } else if (update.type === 'toolcall_end') open.content[i] = update.toolCall
        break
      }
      case 'message_end':
        if (event.message.role === 'assistant') this.openAssistant = null
        this.record(event.message)
        break
      case 'tool_execution_start':
        this.openTools.set(event.toolCallId, event.toolName)
        break
      case 'tool_execution_end':
        this.openTools.delete(event.toolCallId)
        break
      case 'compaction_end':
        if (event.result) {
          this.append({
            type: 'compaction',
            id: hex8(),
            parentId: this.leafId,
            timestamp: new Date().toISOString(),
            summary: event.result.summary,
            firstKeptEntryId: event.result.firstKeptEntryId,
            tokensBefore: event.result.tokensBefore
          })
          this.messages.push({
            role: 'compactionSummary',
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            timestamp: Date.now()
          })
        }
        break
      default:
        break
    }
  }

  protected record(message: AgentMessage): void {
    this.messages.push(message)
    const base = { id: hex8(), parentId: this.leafId, timestamp: new Date().toISOString() }
    // Like pi's SessionManager: extension messages are `custom_message` entries.
    if (message.role === 'custom') {
      const { customType, content, details, display } = message
      this.append({ type: 'custom_message', ...base, customType, content, details, display })
    } else this.append({ type: 'message', ...base, message })
  }

  protected append(entry: SessionEntry): void {
    this.entries.push(entry)
    this.leafId = entry.id
  }

  protected resetEntries(): void {
    this.entries = []
    this.leafId = null
    const now = new Date().toISOString()
    this.append({
      type: 'model_change',
      id: hex8(),
      parentId: null,
      timestamp: now,
      provider: this.model.provider,
      modelId: this.model.id
    })
    this.append({
      type: 'thinking_level_change',
      id: hex8(),
      parentId: this.leafId,
      timestamp: now,
      thinkingLevel: this.thinkingLevel
    })
  }

  /** A resumed/forked listed mock session starts with its persisted history (one exchange, or a long session). */
  protected seedHistory(sessionPath: string): void {
    const history = mockSessionHistory(sessionPath)
    if (!history) return
    if (history.name && !this.args.forkFrom) this.sessionName = history.name
    // Later prompts in a resumed session play the short script.
    this.runsPlayed = 1
    if (history.turns) {
      this.seedLongHistory(mockLongSessionEntries(history, history.turns, this.leafId))
      return
    }
    const user: UserMessage = {
      role: 'user',
      content: history.firstMessage,
      timestamp: history.at - 90_000
    }
    const reply: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: history.reply }],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: {
        input: 12_400,
        output: 380,
        cacheRead: 9_600,
        cacheWrite: 0,
        totalTokens: 22_380,
        cost: { input: 0.0372, output: 0.0057, cacheRead: 0.00288, cacheWrite: 0, total: 0.04578 }
      },
      stopReason: 'stop',
      timestamp: history.at
    }
    this.record(user)
    this.record(reply)
  }

  protected seedLongHistory({
    entries,
    leafId
  }: {
    entries: SessionEntry[]
    leafId: string | null
  }): void {
    this.entries.push(...entries)
    this.leafId = leafId
    this.messages = this.branchMessages()
  }

  /** An earlier, abandoned branch so get_tree has real structure. */
  protected seedAbandonedBranch(): void {
    const root = this.leafId
    const at = Date.now() - 6 * 60_000
    // The session started before the branch was abandoned: the entries it grows from date a minute earlier.
    const start = new Date(at - 60_000).toISOString()
    for (const entry of this.branchPath()) entry.timestamp = start
    const user: UserMessage = {
      role: 'user',
      content: 'How is the session store persisted?',
      timestamp: at
    }
    const userEntry: SessionEntry = {
      type: 'message',
      id: hex8(),
      parentId: root,
      timestamp: new Date(at).toISOString(),
      message: user
    }
    const reply: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Sessions are written by `SessionStore.persist`, a 250 ms debounced call to `writeSessionFile`.'
        }
      ],
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: {
        input: 8_200,
        output: 64,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8_264,
        cost: { input: 0.0246, output: 0.00096, cacheRead: 0, cacheWrite: 0, total: 0.02556 }
      },
      stopReason: 'stop',
      timestamp: at + 4_000
    }
    this.entries.push(userEntry, {
      type: 'message',
      id: hex8(),
      parentId: userEntry.id,
      timestamp: new Date(at + 4_000).toISOString(),
      message: reply
    })
    // The active branch continues from the root, not from the abandoned reply.
    this.leafId = root
  }

  protected tree(): FlatTreeNode[] {
    const labels = new Map<string, { label: string; at: string }>()
    for (const entry of this.entries) {
      if (entry.type !== 'label') continue
      if (entry.label) labels.set(entry.targetId, { label: entry.label, at: entry.timestamp })
      else labels.delete(entry.targetId)
    }
    const nodes = new Map<string, SessionTreeNode>()
    for (const entry of this.entries) {
      const label = labels.get(entry.id)
      nodes.set(
        entry.id,
        label
          ? { entry, children: [], label: label.label, labelTimestamp: label.at }
          : { entry, children: [] }
      )
    }
    const roots: SessionTreeNode[] = []
    for (const entry of this.entries) {
      const node = nodes.get(entry.id)!
      const parent = entry.parentId ? nodes.get(entry.parentId) : undefined
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
    return flattenSessionTree(roots)
  }

  protected state(): RpcSessionState {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.streaming,
      isCompacting: false,
      steeringMode: this.steeringMode,
      followUpMode: this.followUpMode,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      autoCompactionEnabled: this.autoCompaction,
      messageCount: this.messages.length,
      pendingMessageCount: this.steering.length + this.followUp.length
    }
  }

  protected contextTokens(): number {
    const last = [...this.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === 'assistant')
    return last
      ? last.usage.input + last.usage.output + last.usage.cacheRead + last.usage.cacheWrite
      : 0
  }

  protected stats(): SessionStats {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    let cost = 0
    let toolCalls = 0
    for (const m of this.messages) {
      if (m.role !== 'assistant') continue
      tokens.input += m.usage.input
      tokens.output += m.usage.output
      tokens.cacheRead += m.usage.cacheRead
      tokens.cacheWrite += m.usage.cacheWrite
      cost += m.usage.cost.total
      toolCalls += m.content.filter((c) => c.type === 'toolCall').length
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    const contextTokens = this.contextTokens()
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages: this.messages.filter((m) => m.role === 'user').length,
      assistantMessages: this.messages.filter((m) => m.role === 'assistant').length,
      toolCalls,
      toolResults: this.messages.filter((m) => m.role === 'toolResult').length,
      totalMessages: this.messages.length,
      tokens,
      cost,
      contextUsage: {
        tokens: contextTokens,
        contextWindow: this.model.contextWindow,
        percent: Math.round((contextTokens / this.model.contextWindow) * 1000) / 10
      }
    }
  }

  protected clampThinking(): void {
    const levels = thinkingLevelsFor(this.model)
    if (!levels.includes(this.thinkingLevel))
      this.thinkingLevel = levels[levels.length - 1] ?? 'off'
  }
}
