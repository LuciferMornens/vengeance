import { rmSync } from 'node:fs'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { EngineId } from '@shared/api/engine'
import type { AgentMessage, SessionEntry, Usage } from '@shared/engine-types'
import type { SettingsManagerLike } from '../settings/pi-modules'

const MAX_HISTORY_BYTES = 256 * 1024 * 1024
const HISTORY_CUSTOM_TYPE = 'vengeance-engine-history'
const METADATA_ENTRY_TYPES = new Set([
  'model_change',
  'thinking_level_change',
  'service_tier_change',
  'session_info',
  'session_state',
  'label',
  'usage',
  'child_usage_attributed',
  'git_state'
])

export interface EngineHandoffArgs {
  sourceEngine: EngineId
  targetEngine: EngineId
  cwd: string
  name?: string
  sourceSessionPath?: string
  sessionDir?: string
  /** Destination launch environment only; source credentials/configuration are never copied. */
  launchEnv?: Record<string, string>
  /** Full native entry tree; get_messages alone contains only the compacted context window. */
  entries: readonly SessionEntry[]
  leafId: string | null
  messages?: readonly AgentMessage[]
}

interface HandoffEntry {
  id: string
  type: 'message' | 'compaction' | 'branch_summary' | 'custom_message' | 'custom' | 'context_edit'
  fields: Record<string, unknown>
}

export interface EngineHandoffHistory {
  version: 1
  cwd: string
  name?: string
  sourceEngine: EngineId
  sourceSessionPath?: string
  entries: HandoffEntry[]
}

interface PiHandoffManager {
  getSessionFile(): string | undefined
  getLeafId(): string | null
  appendMessage(message: AgentMessage): string
  appendCompaction(
    summary: string,
    firstKeptEntryId: string | null,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string
  appendCustomEntry(customType: string, data?: unknown): string
  appendCustomMessageEntry(
    customType: string,
    content: unknown,
    display: boolean,
    details?: unknown
  ): string
  appendContextEdit(targetId: string, replacement: unknown): string
  appendSessionInfo(name: string): string
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
    usage?: Usage
  ): string
}

export interface PiHandoffModule {
  getDefaultSessionDir(cwd: string, agentDir?: string): string
  SessionManager: {
    create(cwd: string, sessionDir?: string, options?: { parentSession?: string }): PiHandoffManager
    open(path: string): {
      getEntries(): SessionEntry[]
      buildSessionContext(): { messages: AgentMessage[] }
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function historicalEntry(entry: Record<string, unknown>, sourceEngine: EngineId): HandoffEntry {
  const role = record(entry.message).role
  const description = typeof role === 'string' ? `${role} message` : `${entry.type} entry`
  return {
    id: String(entry.id),
    type: 'custom_message',
    fields: {
      customType: HISTORY_CUSTOM_TYPE,
      content:
        `Historical ${description} from ${sourceEngine === 'pi' ? 'Engine' : 'Engine 2'}. ` +
        'This records the earlier conversation; the current engine supplies its own tools and ' +
        `system instructions.\n\n${JSON.stringify(entry)}`,
      display: true,
      details: { sourceEngine, sourceEntry: entry }
    }
  }
}

function activeBranch(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
  const byId = new Map<string, SessionEntry>()
  for (const entry of entries) {
    if (!entry.id || byId.has(entry.id))
      throw new Error('The source history has duplicate entry IDs')
    byId.set(entry.id, entry)
  }
  const branch: SessionEntry[] = []
  const visited = new Set<string>()
  let current = leafId
  while (current) {
    if (visited.has(current)) throw new Error('The source history has a circular parent chain')
    visited.add(current)
    const entry = byId.get(current)
    if (!entry) throw new Error('The source history has an incomplete parent chain')
    branch.push(entry)
    current = entry.parentId
  }
  return branch.reverse()
}

function portableMessage(message: Record<string, unknown>): boolean {
  switch (message.role) {
    case 'user':
    case 'custom':
      return typeof message.content === 'string' || Array.isArray(message.content)
    case 'bashExecution':
      return typeof message.command === 'string' && typeof message.output === 'string'
    case 'toolResult':
      return typeof message.toolCallId === 'string' && Array.isArray(message.content)
    case 'assistant':
      return (
        Array.isArray(message.content) &&
        message.content.every((block: unknown) =>
          ['text', 'thinking', 'toolCall'].includes(String(record(block).type))
        ) &&
        ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(message.stopReason)) &&
        typeof message.provider === 'string' &&
        typeof message.model === 'string' &&
        typeof message.api === 'string'
      )
    default:
      return false
  }
}

/** Convert the complete active branch; native checkpoints and control state stay historical data. */
export function buildEngineHandoffHistory(args: EngineHandoffArgs): EngineHandoffHistory {
  const branch = activeBranch(args.entries, args.leafId)
  if (!branch.length && args.messages?.length) {
    throw new Error('The engine did not provide the complete conversation history')
  }
  const edits = new Map<string, unknown>()
  if (args.targetEngine === 'prime') {
    for (const entry of branch) {
      if (entry.type === 'context_edit') edits.set(entry.targetId, entry.replacement)
    }
  }

  const entries = branch.flatMap((source): HandoffEntry[] => {
    const entry = record(source)
    const fields = { ...entry }
    delete fields.id
    delete fields.parentId
    delete fields.timestamp
    delete fields.type

    if (entry.type === 'message') {
      const message = record(entry.message)
      if (!portableMessage(message)) return [historicalEntry(entry, args.sourceEngine)]
      if (edits.has(source.id)) {
        const replacement = edits.get(source.id)
        const archived: HandoffEntry = {
          id: `${source.id}-unmodified`,
          type: 'custom',
          fields: { customType: HISTORY_CUSTOM_TYPE, data: { sourceEntry: entry } }
        }
        if (replacement === null) {
          return [{ ...archived, id: source.id }]
        }
        const content = record(replacement).content
        fields.message = {
          ...message,
          content:
            typeof content === 'string' &&
            (message.role === 'assistant' || message.role === 'toolResult')
              ? [{ type: 'text', text: content }]
              : content
        }
        return [archived, { id: source.id, type: 'message', fields }]
      }
      return [{ id: source.id, type: 'message', fields }]
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return [
        {
          id: source.id,
          type: entry.type,
          fields: {
            summary: fields.summary,
            ...(entry.type === 'compaction'
              ? { firstKeptEntryId: fields.firstKeptEntryId, tokensBefore: fields.tokensBefore }
              : { fromId: fields.fromId }),
            usage: fields.usage,
            // Opaque provider checkpoints and harness state belong to the source runtime.
            details: { sourceEngine: args.sourceEngine, sourceEntry: entry }
          }
        }
      ]
    }
    if (entry.type === 'custom_message') {
      const converted: HandoffEntry = {
        id: source.id,
        type: 'custom_message',
        fields: {
          ...fields,
          customType: HISTORY_CUSTOM_TYPE,
          details: { sourceEngine: args.sourceEngine, sourceEntry: entry }
        }
      }
      if (!edits.has(source.id)) return [converted]
      const archived: HandoffEntry = {
        id: `${source.id}-unmodified`,
        type: 'custom',
        fields: { customType: HISTORY_CUSTOM_TYPE, data: { sourceEntry: entry } }
      }
      const replacement = edits.get(source.id)
      if (replacement === null) return [{ ...archived, id: source.id }]
      converted.fields.content = record(replacement).content
      return [archived, converted]
    }
    if (entry.type === 'context_edit' && args.targetEngine === 'pi') {
      return [{ id: source.id, type: 'context_edit', fields }]
    }
    if (
      entry.type === 'context_edit' ||
      entry.type === 'custom' ||
      METADATA_ENTRY_TYPES.has(String(entry.type))
    ) {
      return [
        {
          id: source.id,
          type: 'custom',
          fields: { customType: HISTORY_CUSTOM_TYPE, data: { sourceEntry: entry } }
        }
      ]
    }
    return [historicalEntry(entry, args.sourceEngine)]
  })
  return {
    version: 1,
    cwd: args.cwd,
    name: args.name,
    sourceEngine: args.sourceEngine,
    sourceSessionPath: args.sourceSessionPath,
    entries
  }
}

function referencedEntry(
  entry: HandoffEntry,
  field: string,
  ids: Map<string, string>,
  allowSelf = false
): string | null {
  const value = entry.fields[field]
  if (allowSelf && value === entry.id) return null
  if (typeof value !== 'string' || !ids.has(value)) {
    throw new Error(`The source ${entry.type} has an invalid ${field}`)
  }
  return ids.get(value)!
}

/** The module boundary mirrors the selected pi build's session-manager.d.ts. */
export function writePiHandoffHistory(
  native: PiHandoffModule,
  history: EngineHandoffHistory,
  sessionDir?: string
): string {
  const manager = native.SessionManager.create(history.cwd, sessionDir, {
    parentSession: history.sourceSessionPath
  })
  try {
    return appendPiHandoffHistory(manager, history)
  } catch (error) {
    const path = manager.getSessionFile()
    if (path) rmSync(path, { force: true })
    throw error
  }
}

function appendPiHandoffHistory(manager: PiHandoffManager, history: EngineHandoffHistory): string {
  const ids = new Map<string, string>()
  manager.appendCustomEntry(HISTORY_CUSTOM_TYPE, {
    sourceEngine: history.sourceEngine,
    sourceSessionPath: history.sourceSessionPath
  })
  const hasConversation = history.entries.some((entry) => {
    const role = record(entry.fields.message).role
    return entry.type === 'message' && (role === 'user' || role === 'assistant')
  })
  if (!hasConversation) {
    // The native SDK delays its first disk write until it sees a user or assistant message.
    manager.appendMessage({
      role: 'user',
      content: 'The earlier engine history follows. Continue from it when I send another message.',
      timestamp: Date.now()
    })
  }
  for (const entry of history.entries) {
    const fields = entry.fields
    let identifier: string
    switch (entry.type) {
      case 'message':
        identifier = manager.appendMessage(fields.message as AgentMessage)
        break
      case 'compaction':
        identifier = manager.appendCompaction(
          String(fields.summary),
          referencedEntry(entry, 'firstKeptEntryId', ids, true),
          Number(fields.tokensBefore),
          fields.details,
          true,
          fields.usage as Usage | undefined
        )
        break
      case 'branch_summary':
        identifier = manager.branchWithSummary(
          manager.getLeafId(),
          String(fields.summary),
          fields.details,
          true,
          fields.usage as Usage | undefined
        )
        break
      case 'custom_message':
        identifier = manager.appendCustomMessageEntry(
          String(fields.customType),
          fields.content,
          fields.display === true,
          fields.details
        )
        break
      case 'context_edit':
        identifier = manager.appendContextEdit(
          referencedEntry(entry, 'targetId', ids)!,
          fields.replacement
        )
        break
      case 'custom':
        identifier = manager.appendCustomEntry(String(fields.customType), fields.data)
        break
    }
    ids.set(entry.id, identifier)
  }
  if (history.name) manager.appendSessionInfo(history.name)
  const path = manager.getSessionFile()
  if (!path) throw new Error('The Engine did not create a destination session')
  return path
}

export async function createEngineHandoff(
  args: EngineHandoffArgs,
  overridePath: string | null
): Promise<{ path: string; cwd: string; engine: EngineId }> {
  const history = buildEngineHandoffHistory(args)
  const serialized = JSON.stringify(history)
  if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) {
    throw new Error('The conversation is too large to transfer safely')
  }
  if (args.targetEngine === 'prime') {
    const [{ nativePrimeSessionCommand }, { primeSessionRoot }] = await Promise.all([
      import('../../engine/prime/sessions-native'),
      import('../../engine/prime/sessions')
    ])
    const directory = await mkdtemp(join(tmpdir(), 'vengeance-handoff-'))
    try {
      const inputPath = join(directory, 'history.json')
      await writeFile(inputPath, serialized, { encoding: 'utf8', mode: 0o600 })
      const path = await nativePrimeSessionCommand(
        {
          operation: 'handoff',
          inputPath,
          sessionDir:
            args.sessionDir ??
            (await primeSessionRoot(args.cwd, {
              env: args.launchEnv,
              agentDir: args.launchEnv?.PRIME_AGENT_CODING_AGENT_DIR
            }))
        },
        args.launchEnv
      )
      return { path, cwd: args.cwd, engine: args.targetEngine }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const [{ locateEngine }, { importPiFile }, { sessionStorage }] = await Promise.all([
    import('../../engine/locate'),
    import('../../engine/runtime'),
    import('./service')
  ])
  const location = await locateEngine(overridePath)
  const native = await importPiFile<PiHandoffModule>(
    join(location.packageDir, 'dist', 'core', 'session-manager.js')
  )
  const storage = await sessionStorage(overridePath)
  if (args.launchEnv?.PI_CODING_AGENT_DIR) {
    storage.agentDir = storage.normalizePath(args.launchEnv.PI_CODING_AGENT_DIR)
  }
  const settingsModule = await importPiFile<{
    SettingsManager: { create(cwd: string, agentDir: string): SettingsManagerLike }
  }>(join(location.packageDir, 'dist', 'core', 'settings-manager.js'))
  const configuredDirectory = settingsModule.SettingsManager.create(
    args.cwd,
    storage.agentDir
  ).getSessionDir()
  const environmentDirectory =
    args.launchEnv?.PI_CODING_AGENT_SESSION_DIR ?? process.env.PI_CODING_AGENT_SESSION_DIR
  const selectedDirectory = args.sessionDir ?? environmentDirectory ?? configuredDirectory
  const sessionDir = selectedDirectory
    ? resolve(args.cwd, storage.normalizePath(selectedDirectory))
    : native.getDefaultSessionDir(args.cwd, storage.agentDir)
  let path: string | undefined
  try {
    path = writePiHandoffHistory(native, history, sessionDir)
    const file = await stat(path)
    if (!file.isFile() || !file.size) throw new Error('The destination session was not saved')
    const reloaded = native.SessionManager.open(path).getEntries()
    if (reloaded.length < history.entries.length) {
      throw new Error('The Engine did not save the complete conversation')
    }
    return { path, cwd: args.cwd, engine: args.targetEngine }
  } catch (error) {
    if (path) await rm(path, { force: true })
    throw error
  }
}
