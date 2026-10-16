import type { ToolCall } from '@shared/engine-types'
import type { AgentState, ToolExecution, ToolStatus } from '../../store/agent-state'

/** One tool call of the session in transcript order, joined with its execution record. */
export interface ToolActivity {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolStatus
  isError: boolean
  /** epoch ms (assistant message time, or live start time) */
  at: number
  durationMs?: number
  execution?: ToolExecution
}

/** What tool activity is derived from; memoize on these fields (not the whole agent, which changes every frame). */
export type ActivitySource = Pick<AgentState, 'entries' | 'streaming' | 'tools'>

/** Tool calls in transcript order (completed messages, then the streaming one). */
export function toolActivity(agent: ActivitySource): ToolActivity[] {
  const out: ToolActivity[] = []
  const seen = new Set<string>()
  const messages = agent.entries.map((e) => e.message)
  if (agent.streaming) messages.push(agent.streaming.message)
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'toolCall' || seen.has(block.id)) continue
      seen.add(block.id)
      out.push(fromCall(block, agent.tools[block.id], message.timestamp))
    }
  }
  return out
}

function fromCall(call: ToolCall, execution: ToolExecution | undefined, at: number): ToolActivity {
  const durationMs = execution?.durationMs ?? (execution?.startedAt && execution.endedAt ? execution.endedAt - execution.startedAt : undefined)
  return {
    id: call.id,
    name: call.name,
    args: execution?.args && Object.keys(execution.args).length > 0 ? execution.args : call.arguments,
    status: execution?.status ?? 'pending',
    isError: execution?.isError ?? false,
    at: execution?.startedAt ?? at,
    durationMs,
    execution
  }
}

/** Primary path argument of file tools (pi uses `path`; some tools use `file_path`). */
export function pathArg(args: Record<string, unknown>): string | undefined {
  const value = args.path ?? args.file_path ?? args.filePath
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function resultText(execution: ToolExecution | undefined): string {
  const result = execution?.result ?? execution?.partialResult
  if (!result) return ''
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
}

// ─── Files touched ───────────────────────────────────────────────────────────

export type FileOp = 'read' | 'edit' | 'write'

export interface FileActivity {
  /** Absolute path (resolved against the workspace). */
  path: string
  /** Workspace-relative display path. */
  display: string
  reads: number
  edits: number
  writes: number
  added: number
  removed: number
  errors: number
  lastAt: number
  lastOp: FileOp
  /** Still running. */
  live: boolean
}

const FILE_TOOLS: Record<string, FileOp> = { read: 'read', edit: 'edit', write: 'write' }

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')
}

function joinPath(cwd: string, path: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}\\${path.replace(/^\.[\\/]/, '').replace(/\//g, '\\')}`
}

export function relativeTo(cwd: string, path: string): string {
  const base = cwd.replace(/[\\/]+$/, '').toLowerCase()
  const normalized = path.replace(/\//g, '\\')
  if (normalized.toLowerCase().startsWith(`${base}\\`)) return normalized.slice(base.length + 1).replace(/\\/g, '/')
  return path.replace(/\\/g, '/')
}

function lineCount(text: unknown): number {
  return typeof text === 'string' && text.length > 0 ? text.replace(/\n$/, '').split('\n').length : 0
}

/** +/− for an edit: pi's display diff (`+12 line` / `-12 line` rows) when present, else the edit arguments. */
function editStats(activity: ToolActivity): { added: number; removed: number } {
  const details = activity.execution?.result?.details as { diff?: unknown } | undefined
  if (typeof details?.diff === 'string') {
    let added = 0
    let removed = 0
    for (const line of details.diff.split('\n')) {
      if (/^\+\s*\d/.test(line)) added++
      else if (/^-\s*\d/.test(line)) removed++
    }
    return { added, removed }
  }
  const edits = Array.isArray(activity.args.edits) ? (activity.args.edits as Array<Record<string, unknown>>) : [activity.args]
  let added = 0
  let removed = 0
  for (const edit of edits) {
    added += lineCount(edit.newText ?? edit.new_string)
    removed += lineCount(edit.oldText ?? edit.old_string)
  }
  return { added, removed }
}

/** Files read / edited / written this session (paths resolved against `cwd`), most recently touched first. */
export function fileActivity(cwd: string, activities: ToolActivity[]): FileActivity[] {
  const files = new Map<string, FileActivity>()
  for (const activity of activities) {
    const op = FILE_TOOLS[activity.name]
    const raw = pathArg(activity.args)
    if (!op || !raw) continue
    const path = isAbsolute(raw) ? raw : joinPath(cwd, raw)
    const key = path.replace(/\//g, '\\').toLowerCase()
    const file = files.get(key) ?? { path, display: relativeTo(cwd, path), reads: 0, edits: 0, writes: 0, added: 0, removed: 0, errors: 0, lastAt: 0, lastOp: op, live: false }
    if (op === 'read') file.reads++
    else if (op === 'edit') file.edits++
    else file.writes++
    if (activity.isError) file.errors++
    else if (op === 'edit' && activity.status === 'done') {
      const stats = editStats(activity)
      file.added += stats.added
      file.removed += stats.removed
    } else if (op === 'write' && activity.status === 'done') {
      file.added += lineCount(activity.args.content)
    }
    file.live = file.live || activity.status === 'running' || activity.status === 'streaming'
    if (activity.at >= file.lastAt) {
      file.lastAt = activity.at
      file.lastOp = op
    }
    files.set(key, file)
  }
  return [...files.values()].sort((a, b) => b.lastAt - a.lastAt)
}
