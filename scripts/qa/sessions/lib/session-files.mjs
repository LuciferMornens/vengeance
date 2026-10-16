// Session files on disk for the sessions QA suites: locate them in the temp engine dir, parse them and check
// them against the engine's session-format.md (v3), and build fixture files shaped like real ones.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertTempPath } from '../../lib/agent-dir.mjs'

export const SESSION_VERSION = 3

/** Entry types of session-format.md (pi 1.1.0). */
const ENTRY_TYPES = new Set([
  'message',
  'model_change',
  'thinking_level_change',
  'usage',
  'compaction',
  'context_edit',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info'
])
const MESSAGE_ROLES = new Set([
  'system',
  'user',
  'assistant',
  'toolResult',
  'bashExecution',
  'custom',
  'compactionSummary',
  'branchSummary'
])

/** pi's default per-workspace folder name: `--<cwd without leading separator, / \ : → ->--`. */
export function encodedCwd(cwd) {
  return `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`
}

/** `<agentDir>/sessions/--<cwd>--` */
export function workspaceSessionDir(agentDir, cwd) {
  return join(agentDir.dir, 'sessions', encodedCwd(cwd))
}

/** Every `.jsonl` under `dir` (recursive), sorted. */
export async function listJsonl(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listJsonl(path)))
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out.sort()
}

/** Parsed session file: header, entries, raw text. Throws on a line that is not JSON. */
export async function readSession(path) {
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`${path}: line ${index + 1} is not JSON (${error.message})`)
    }
  })
  const [header, ...entries] = records
  return { path, text, header, entries }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * Problems of a parsed session against session-format.md: header first (type session, version 3, id, ISO
 * timestamp, cwd), then entries with known types, unique ids, a parent that is null or an earlier entry,
 * ISO timestamps, and the per-type required fields. Empty when the file is valid.
 */
export function sessionFormatProblems({ text, header, entries }) {
  const problems = []
  if (text.includes('\r')) problems.push('file contains CR characters (JSONL must be LF only)')
  if (!text.endsWith('\n')) problems.push('file does not end with a newline')
  if (!header || header.type !== 'session') problems.push('first line is not a session header')
  else {
    if (header.version !== SESSION_VERSION)
      problems.push(`header version ${header.version}, expected 3`)
    if (typeof header.id !== 'string' || !header.id) problems.push('header id missing')
    if (!isIsoTimestamp(header.timestamp)) problems.push('header timestamp is not ISO')
    if (typeof header.cwd !== 'string') problems.push('header cwd missing')
    if (header.parentSession !== undefined && typeof header.parentSession !== 'string') {
      problems.push('header parentSession is not a string')
    }
  }
  const seen = new Set()
  entries.forEach((entry, index) => {
    const where = `entry ${index + 2} (${entry?.type}/${entry?.id})`
    if (!ENTRY_TYPES.has(entry?.type)) problems.push(`${where}: unknown type`)
    if (typeof entry.id !== 'string' || !entry.id) problems.push(`${where}: id missing`)
    if (seen.has(entry.id)) problems.push(`${where}: duplicate id`)
    if (entry.parentId !== null && !seen.has(entry.parentId)) {
      problems.push(`${where}: parentId ${entry.parentId} is not an earlier entry`)
    }
    if (!isIsoTimestamp(entry.timestamp)) problems.push(`${where}: timestamp is not ISO`)
    switch (entry.type) {
      case 'message':
        if (!MESSAGE_ROLES.has(entry.message?.role))
          problems.push(`${where}: unknown role ${entry.message?.role}`)
        if (typeof entry.message?.timestamp !== 'number')
          problems.push(`${where}: message timestamp not ms`)
        break
      case 'model_change':
        if (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string') {
          problems.push(`${where}: provider/modelId missing`)
        }
        break
      case 'thinking_level_change':
        if (typeof entry.thinkingLevel !== 'string')
          problems.push(`${where}: thinkingLevel missing`)
        break
      case 'compaction':
        if (typeof entry.summary !== 'string') problems.push(`${where}: summary missing`)
        if (typeof entry.firstKeptEntryId !== 'string')
          problems.push(`${where}: firstKeptEntryId missing`)
        if (typeof entry.tokensBefore !== 'number') problems.push(`${where}: tokensBefore missing`)
        break
      case 'branch_summary':
        if (typeof entry.summary !== 'string') problems.push(`${where}: summary missing`)
        if (typeof entry.fromId !== 'string') problems.push(`${where}: fromId missing`)
        break
      case 'label':
        if (typeof entry.targetId !== 'string' || !seen.has(entry.targetId)) {
          problems.push(`${where}: targetId is not an earlier entry`)
        }
        if (entry.label !== undefined && typeof entry.label !== 'string')
          problems.push(`${where}: label not a string`)
        break
      case 'session_info':
        if (entry.name !== undefined && typeof entry.name !== 'string')
          problems.push(`${where}: name not a string`)
        break
      case 'custom':
      case 'custom_message':
        if (typeof entry.customType !== 'string') problems.push(`${where}: customType missing`)
        break
    }
    seen.add(entry.id)
  })
  return problems
}

/** Read and validate; throws with every problem listed. */
export async function assertValidSession(path) {
  const session = await readSession(path)
  const problems = sessionFormatProblems(session)
  if (problems.length)
    throw new Error(`${path} violates session-format.md:\n  ${problems.join('\n  ')}`)
  return session
}

/** Validate every session file under `dir`; returns the parsed sessions. */
export async function assertAllValid(dir) {
  const sessions = []
  for (const path of await listJsonl(dir)) sessions.push(await assertValidSession(path))
  return sessions
}

/** The latest session_info name on the file (what pi lists), or undefined. */
export function sessionName(session) {
  const info = session.entries.filter((entry) => entry.type === 'session_info')
  return info.length ? info[info.length - 1].name : undefined
}

/** Path root → `leafId` through parent links. */
export function pathTo(session, leafId) {
  const byId = new Map(session.entries.map((entry) => [entry.id, entry]))
  const path = []
  for (let id = leafId; id; id = byId.get(id)?.parentId) {
    const entry = byId.get(id)
    if (!entry) break
    path.unshift(entry)
  }
  return path
}

export function messageText(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** User message texts in file order. */
export function userTexts(session) {
  return session.entries
    .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
    .map((entry) => messageText(entry.message))
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const id8 = () => randomBytes(4).toString('hex')

const ZERO_USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/**
 * Builds a session file entry by entry, like pi's SessionManager writes it: v3 header, 8-hex ids, every
 * entry parented on the current leaf (or an explicit `parentId`), ISO entry timestamps and ms message
 * timestamps that advance by `stepMs`. By default a session starts an hour ago, but never before
 * today's local midnight: sidebar date groups ("Today") must not depend on when the suite runs.
 */
export class SessionBuilder {
  constructor({
    cwd,
    id = randomUUID(),
    startedAt = Math.max(Date.now() - 3_600_000, new Date().setHours(0, 0, 0, 0)),
    stepMs = 1000,
    parentSession
  } = {}) {
    this.header = {
      type: 'session',
      version: SESSION_VERSION,
      id,
      timestamp: new Date(startedAt).toISOString(),
      cwd
    }
    if (parentSession) this.header.parentSession = parentSession
    this.entries = []
    this.entryIds = new Set()
    this.leafId = null
    this.clock = startedAt
    this.stepMs = stepMs
  }

  add(fields, { parentId = this.leafId } = {}) {
    let entryId = fields.id ?? id8()
    if (fields.id !== undefined && this.entryIds.has(entryId)) {
      throw new Error(`Duplicate fixture entry id: ${entryId}`)
    }
    while (this.entryIds.has(entryId)) {
      entryId = id8()
    }
    this.clock += this.stepMs
    const entry = {
      parentId,
      timestamp: new Date(this.clock).toISOString(),
      ...fields,
      id: entryId
    }
    this.entryIds.add(entry.id)
    this.entries.push(entry)
    this.leafId = entry.id
    return entry
  }

  modelChange(provider = 'qa', modelId = 'qa-reasoning') {
    return this.add({ type: 'model_change', provider, modelId })
  }

  thinking(level) {
    return this.add({ type: 'thinking_level_change', thinkingLevel: level })
  }

  user(text, options) {
    return this.add(
      {
        type: 'message',
        message: { role: 'user', content: text, timestamp: this.clock + this.stepMs }
      },
      options
    )
  }

  assistant(text, { model = 'qa-reasoning', toolCalls = [], ...options } = {}) {
    const content = [
      { type: 'text', text },
      ...toolCalls.map((call) => ({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: call.args ?? {}
      }))
    ]
    return this.add(
      {
        type: 'message',
        message: {
          role: 'assistant',
          content,
          api: 'anthropic-messages',
          provider: 'qa',
          model,
          usage: ZERO_USAGE,
          stopReason: toolCalls.length ? 'toolUse' : 'stop',
          timestamp: this.clock + this.stepMs
        }
      },
      options
    )
  }

  toolResult(toolCallId, toolName, text) {
    return this.add({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: this.clock + this.stepMs
      }
    })
  }

  name(name) {
    return this.add({ type: 'session_info', name })
  }

  label(targetId, label) {
    return this.add({ type: 'label', targetId, label })
  }

  compaction(summary, firstKeptEntryId, tokensBefore = 50_000) {
    return this.add({ type: 'compaction', summary, firstKeptEntryId, tokensBefore })
  }

  customMessage(customType, content, details, display = true) {
    return this.add({ type: 'custom_message', customType, content, display, details })
  }

  text() {
    return `${[this.header, ...this.entries].map((line) => JSON.stringify(line)).join('\n')}\n`
  }

  /** File name like pi's: `<ISO timestamp with - for : and .>_<session id>.jsonl`. */
  fileName() {
    return `${this.header.timestamp.replace(/[:.]/g, '-')}_${this.header.id}.jsonl`
  }

  /** Write into `dir` (temp only); returns the path. */
  async write(dir, fileName = this.fileName()) {
    const path = assertTempPath(join(dir, fileName))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, this.text(), 'utf8')
    return path
  }
}
