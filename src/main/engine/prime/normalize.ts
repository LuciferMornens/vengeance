import type {
  AgentMessage,
  AssistantMessage,
  FlatSessionTree,
  FlatTreeNode,
  Model,
  RpcCommand,
  RpcResponseDataMap,
  RpcSessionState,
  RpcSlashCommand,
  SessionEntry,
  ThinkingLevel,
  Usage
} from '@shared/engine-types'
import { THINKING_LEVELS } from '@shared/engine-types'
import { flattenSessionTree } from '../session-tree'
import { asRecord, asRecords, stringValue, type PrimeRecord } from './transport'

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function thinkingLevel(value: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : 'off'
}

export function normalizeUsage(value: unknown): Usage {
  const usage = asRecord(value)
  const cost = asRecord(usage.cost)
  return {
    ...usage,
    input: numberValue(usage.input),
    output: numberValue(usage.output),
    cacheRead: numberValue(usage.cacheRead),
    cacheWrite: numberValue(usage.cacheWrite),
    totalTokens: numberValue(usage.totalTokens),
    cost: {
      input: numberValue(cost.input),
      output: numberValue(cost.output),
      cacheRead: numberValue(cost.cacheRead),
      cacheWrite: numberValue(cost.cacheWrite),
      total: numberValue(cost.total)
    }
  }
}

export function normalizeModel(value: unknown): Model {
  const model = asRecord(value)
  const cost = asRecord(model.cost)
  const levels = asRecord(model.thinkingLevelMap)
  const thinkingLevelMap: Model['thinkingLevelMap'] = {}
  for (const level of THINKING_LEVELS) {
    if (typeof levels[level] === 'string' || levels[level] === null)
      thinkingLevelMap[level] = levels[level]
  }
  return {
    id: stringValue(model.id) ?? '',
    name: stringValue(model.name) ?? stringValue(model.id) ?? 'Model',
    api: stringValue(model.api) ?? '',
    provider: stringValue(model.provider) ?? '',
    baseUrl: stringValue(model.baseUrl) ?? '',
    reasoning: model.reasoning === true,
    input:
      Array.isArray(model.input) && model.input.length > 0
        ? model.input.includes('image')
          ? ['text', 'image']
          : ['text']
        : [],
    cost: {
      input: numberValue(cost.input),
      output: numberValue(cost.output),
      cacheRead: numberValue(cost.cacheRead),
      cacheWrite: numberValue(cost.cacheWrite)
    },
    contextWindow: numberValue(model.contextWindow),
    maxTokens: numberValue(model.maxTokens),
    type: model.type === 'chat' ? 'chat' : undefined,
    thinkingLevelMap
  }
}

export async function resolveStateModel(
  state: PrimeRecord,
  readCatalog: () => Promise<PrimeRecord>
): Promise<PrimeRecord> {
  if (!state.model) return state
  const model = asRecord(state.model)
  if (Array.isArray(model.input)) return state
  const provider = stringValue(model.provider)
  const id = stringValue(model.id)
  if (!provider || !id) return state

  // Use the connected resident's catalog, not the selected install's catalog.
  const catalog: PrimeRecord = await readCatalog().catch(() => ({}))
  const selected = asRecords(catalog.models).find(
    (candidate) => candidate.provider === provider && candidate.id === id
  )
  return {
    ...state,
    model: normalizeModel({ ...selected, ...model, baseUrl: model.baseUrl })
  }
}

export function sanitizeNativeModels(value: PrimeRecord): PrimeRecord {
  return asRecord(sanitizeNativeValue(value))
}

function sanitizeNativeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(sanitizeNativeValue)
    return items.some((item, index) => item !== value[index]) ? items : value
  }
  if (!value || typeof value !== 'object') return value
  const record = asRecord(value)
  if (
    typeof record.id === 'string' &&
    typeof record.provider === 'string' &&
    Array.isArray(record.input)
  ) {
    return normalizeModel(record)
  }
  let changed: PrimeRecord | undefined
  for (const [key, item] of Object.entries(record)) {
    const safe = sanitizeNativeValue(item)
    if (safe !== item) {
      changed ??= { ...record }
      changed[key] = safe
    }
  }
  return changed ?? value
}

export function normalizeMessage(value: unknown): AgentMessage {
  const message = asRecord(value)
  if (message.role === 'assistant') {
    // Native provider blocks and optional metadata share the agent-message wire contract.
    return {
      ...message,
      role: 'assistant',
      content: Array.isArray(message.content) ? message.content : [],
      api: stringValue(message.api) ?? '',
      provider: stringValue(message.provider) ?? '',
      model: stringValue(message.model) ?? '',
      usage: normalizeUsage(message.usage),
      stopReason: message.stopReason ?? 'pending',
      timestamp: numberValue(message.timestamp, Date.now())
    } as AssistantMessage
  }
  // Session storage may add new message roles; generic renderers retain their native payload.
  return { ...message, timestamp: numberValue(message.timestamp, Date.now()) } as AgentMessage
}

export function normalizeState(snapshot: PrimeRecord, summary: PrimeRecord): RpcSessionState {
  const state = { ...snapshot, ...summary }
  const actions = asRecord(state.sessionActions)
  return {
    model: state.model ? normalizeModel(state.model) : undefined,
    thinkingLevel: thinkingLevel(state.thinkingLevel),
    isStreaming: state.isStreaming === true,
    isCompacting: state.isCompacting === true,
    steeringMode: state.steeringMode === 'one-at-a-time' ? 'one-at-a-time' : 'all',
    followUpMode: state.followUpMode === 'all' ? 'all' : 'one-at-a-time',
    sessionFile: stringValue(state.sessionFile),
    sessionId: stringValue(state.sessionId) ?? '',
    sessionName: stringValue(state.sessionName) ?? stringValue(state.name),
    autoCompactionEnabled: state.autoCompactionEnabled !== false,
    messageCount: numberValue(state.messageCount),
    pendingMessageCount: numberValue(actions.queuedCount)
  }
}

export function normalizeResponse(
  type: RpcCommand['type'],
  result: PrimeRecord,
  sessionFile?: string,
  sessionId?: string
): RpcResponseDataMap[RpcCommand['type']] {
  switch (type) {
    case 'get_messages':
      return {
        messages: Array.isArray(result.messages) ? result.messages.map(normalizeMessage) : []
      }
    case 'get_commands':
      return { commands: normalizeCommands(result.commands) }
    case 'get_available_models':
      return { models: asRecords(result.models).map(normalizeModel) }
    case 'set_model':
      return normalizeModel(result.model ?? result)
    case 'cycle_model':
      return result.model
        ? {
            model: normalizeModel(result.model),
            thinkingLevel: thinkingLevel(result.thinkingLevel),
            isScoped: result.isScoped === true
          }
        : null
    case 'cycle_thinking_level':
      return result.level || result.thinkingLevel
        ? { level: thinkingLevel(result.level ?? result.thinkingLevel) }
        : null
    case 'prompt':
      return {
        disposition:
          result.disposition === 'queued'
            ? 'queued'
            : result.disposition === 'handled'
              ? 'handled'
              : 'started'
      }
    case 'steer':
    case 'follow_up':
      return { disposition: result.disposition === 'handled' ? 'handled' : 'queued' }
    case 'fork':
      return {
        cancelled: result.cancelled === true,
        text: stringValue(result.text ?? result.selectedText) ?? ''
      }
    case 'get_session_stats': {
      const tokens = asRecord(result.tokens)
      return {
        sessionFile: stringValue(result.sessionFile) ?? sessionFile,
        sessionId: stringValue(result.sessionId) ?? sessionId ?? '',
        userMessages: numberValue(result.userMessages),
        assistantMessages: numberValue(result.assistantMessages),
        toolCalls: numberValue(result.toolCalls),
        toolResults: numberValue(result.toolResults),
        totalMessages: numberValue(result.totalMessages),
        cost: numberValue(result.cost),
        tokens: {
          input: numberValue(tokens.input),
          output: numberValue(tokens.output),
          cacheRead: numberValue(tokens.cacheRead),
          cacheWrite: numberValue(tokens.cacheWrite),
          total: numberValue(tokens.total)
        },
        contextUsage: result.contextUsage as RpcResponseDataMap['get_session_stats']['contextUsage']
      }
    }
    default:
      // SAFETY: all remaining native commands share the common response payload shape.
      return result as unknown as RpcResponseDataMap[RpcCommand['type']]
  }
}

export function normalizeTree(data: PrimeRecord): FlatSessionTree {
  if (Array.isArray(data.tree)) {
    // Older native releases return the same nested tree shape as the first engine.
    return {
      nodes: flattenSessionTree(data.tree as Parameters<typeof flattenSessionTree>[0]),
      leafId: stringValue(data.leafId) ?? null
    }
  }
  const nodes: FlatTreeNode[] = asRecords(data.flatNodes ?? data.nodes).map((node) => {
    const entry = asRecord(node.entry)
    // Unknown entry kinds remain available to the renderer's generic history row.
    return {
      entry: entry as unknown as SessionEntry,
      parentId: stringValue(node.parentId) ?? stringValue(entry.parentId) ?? null,
      label: stringValue(node.label),
      labelTimestamp: stringValue(node.labelTimestamp)
    }
  })
  return { nodes, leafId: stringValue(data.leafId) ?? null }
}

export function normalizeCommands(value: unknown): RpcSlashCommand[] {
  return asRecords(value).map((command) => {
    const source = asRecord(command.sourceInfo)
    return {
      name: stringValue(command.name) ?? '',
      description: stringValue(command.description),
      source: command.source === 'skill' ? 'skill' : 'prompt',
      sourceInfo: {
        path: stringValue(source.path) ?? '',
        source: stringValue(source.source) ?? 'local',
        scope: source.scope === 'project' ? 'project' : 'user',
        origin: source.origin === 'package' ? 'package' : 'top-level',
        baseDir: stringValue(source.baseDir)
      }
    }
  })
}
