import type { SubagentInspectMessage } from '@shared/subagents'

/** Activity rows shown in the Agents detail (newest last). */
const MAX_ACTIVITY = 14

export interface ToolActivity {
  kind: 'tool'
  name: string
  /** The tool result's text; undefined while the call runs. */
  result?: string
  isError?: boolean
}

export type ActivityItem = ToolActivity | { kind: 'text'; text: string }

/** What one row says: `Edited` `SessionTree.tsx` `2 blocks`, or the failure reason. */
export interface ActivityLine {
  verb: string
  subject?: string
  meta?: string
  reason?: string
}

const VERBS: Record<string, { live: string; done: string }> = {
  read: { live: 'Reading', done: 'Read' },
  edit: { live: 'Editing', done: 'Edited' },
  write: { live: 'Writing', done: 'Wrote' },
  bash: { live: 'Running a command', done: 'Ran a command' },
  grep: { live: 'Searching', done: 'Searched' },
  find: { live: 'Finding files', done: 'Found files' },
  ls: { live: 'Listing', done: 'Listed a folder' }
}

/** The line of a failure that says what went wrong, else its first line. */
const REASON = /error|failed|fatal|cannot|not found|denied|ENOENT|Traceback|Exception/i
/** `path:line:` or `path-line-` prefixes of grep output lines. */
const GREP_LINE = /^(.+?)[:-](\d+)[:-]/
const EDIT_RESULT = /^Successfully replaced (\d+) block\(s\) in (.+?)\.?$/
const WRITE_RESULT = /wrote .* to (.+?)\.?$/i

/**
 * Inspect parts as rows: a tool call takes the result that follows it; assistant text stays a block. The
 * child's task prompt (its first user message) is shown in Task, not here.
 */
export function activityItems(messages: SubagentInspectMessage[]): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const message of messages) {
    const last = items[items.length - 1]
    if (message.kind === 'toolCall') {
      items.push({ kind: 'tool', name: message.name ?? 'tool' })
    } else if (message.role === 'toolResult' || message.kind === 'toolResult') {
      if (last?.kind === 'tool' && last.result === undefined) {
        last.result = message.text.replace(/^\[tool result:?\s*|\]$/g, '').trim()
        last.isError = message.isError
      }
    } else if (message.role === 'assistant' && message.text.trim()) {
      items.push({ kind: 'text', text: message.text.trim() })
    }
  }
  return items.slice(-MAX_ACTIVITY)
}

function baseName(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? path
}

function reasonLine(text: string): string | undefined {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => REASON.test(line)) ?? lines[0]
}

/** `Searched` `· 2 matches in SessionTree.tsx` from grep's `path:line:text` output. */
function grepLine(result: string): Pick<ActivityLine, 'subject' | 'meta'> {
  const files = new Set<string>()
  let matches = 0
  for (const line of result.split('\n')) {
    const match = GREP_LINE.exec(line)
    if (!match) continue
    matches += 1
    files.add(baseName(match[1]!))
  }
  if (matches === 0) return { meta: 'no matches' }
  const where = files.size === 1 ? [...files][0]! : `${files.size} files`
  return { meta: `${matches === 1 ? '1 match' : `${matches} matches`} in ${where}` }
}

/** The row text of a child's tool call, derived from the result alone (inspect carries no arguments). */
export function activityLine(item: ToolActivity, running: boolean): ActivityLine {
  const verbs = VERBS[item.name] ?? { live: `Using ${item.name.replace(/_/g, ' ')}`, done: `Used ${item.name.replace(/_/g, ' ')}` }
  const verb = running ? verbs.live : verbs.done
  const result = item.result ?? ''
  if (item.isError) return { verb, reason: reasonLine(result) }
  const firstLine = result.split('\n')[0]?.trim() ?? ''
  switch (item.name) {
    case 'edit': {
      const match = EDIT_RESULT.exec(firstLine)
      if (!match) return { verb }
      const blocks = Number(match[1])
      return { verb, subject: baseName(match[2]!), meta: `${blocks} ${blocks === 1 ? 'block' : 'blocks'}` }
    }
    case 'write': {
      const match = WRITE_RESULT.exec(firstLine)
      return match ? { verb, subject: baseName(match[1]!) } : { verb }
    }
    case 'grep':
      return item.result === undefined ? { verb } : { verb, ...grepLine(result) }
    default:
      return { verb }
  }
}
