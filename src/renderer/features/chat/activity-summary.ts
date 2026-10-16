import type { ToolCall } from '@shared/engine-types'
import type { ToolExecution } from '../../store/agent-state'
import { describeSubagentPeek, diffStats, humanizeToolName, isRecord, plural, records, str, toolCallKind, toolKind } from '../tools/tool-utils'

const MCP_RESOURCES = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
const TODO_TOOLS = new Set(['todo', 'todos', 'todo_write', 'TodoWrite'])
/** pi-compaction-recall (`history_*`) and pi-sessions (`session_*`) tools. */
const isHistoryTool = (name: string) => name.startsWith('history_') || name.startsWith('session_')
/** Tools a group summary names by their own phrase instead of counting them as "other tools". */
const hasOwnPhrase = (name: string) => MCP_RESOURCES.has(name) || TODO_TOOLS.has(name) || name === 'tool_search' || isHistoryTool(name)
/** Names a delegate summary lists before folding the rest into "+N". */
const MAX_NAMED_AGENTS = 2
/** Agent-management phrases a summary lists before folding the rest into "+N more". */
const MAX_MANAGE_PHRASES = 2

function distinctPaths(calls: ToolCall[]): number {
  return new Set(calls.map((c) => (typeof c.arguments.path === 'string' ? c.arguments.path : c.id))).size
}

/** A `subagent` call that starts work (no `action`): a launch or a workflow, not a status/steer/list. */
export function isSubagentLaunch(call: ToolCall): boolean {
  return toolKind(call.name) === 'delegate' && !str(call.arguments.action)
}

/** "worker, reviewer" / "worker, reviewer +2". */
function agentNames(calls: ToolCall[]): string {
  return labelList(calls.map((c) => str(c.arguments.agent) ?? (c.arguments.workflow !== undefined ? 'a workflow' : 'an agent')))
}

const PAST = { explore: 'explored', edit: 'edited', run: 'ran', delegate: 'delegated to', todo: 'updated todos', history: 'searched history', use: 'used' }
const PRESENT: typeof PAST = { explore: 'exploring', edit: 'editing', run: 'running', delegate: 'delegating to', todo: 'updating todos', history: 'searching history', use: 'using' }

/** Display name of a run by id (from the subagents store); unknown runs read as "agent". */
export type RunLabel = (runId: string) => string | undefined

/** Past and present phrase of an agent-management action, `{}` standing for the agent it targets. */
const MANAGE_PHRASES: Record<string, [past: string, present: string]> = {
  steer: ['told {}', 'telling {}'],
  status: ['checked on {}', 'checking on {}'],
  transcript: ['looked at {}\u2019s transcript', 'looking at {}\u2019s transcript'],
  resume: ['resumed {}', 'resuming {}'],
  stop: ['stopped {}', 'stopping {}'],
  interrupt: ['paused {}', 'pausing {}'],
  list: ['listed agents', 'listing agents'],
  guide: ['read the subagents guide', 'reading the subagents guide'],
  command: ['checked {}\u2019s command', 'checking {}\u2019s command'],
  reply: ['answered {}', 'answering {}'],
  questions: ['checked open questions', 'checking open questions'],
  wait: ['waited for {}', 'waiting for {}'],
  peek: ['peeked at {}', 'peeking at {}'],
  ask: ['asked the supervisor', 'asking the supervisor'],
  other: ['managed agents', 'managing agents']
}

/** "worker" / "worker, reviewer" / "worker, reviewer +2". */
function labelList(labels: string[]): string {
  const unique = [...new Set(labels)]
  const named = unique.slice(0, MAX_NAMED_AGENTS).join(', ')
  return unique.length > MAX_NAMED_AGENTS ? `${named} +${unique.length - MAX_NAMED_AGENTS}` : named
}

/** Which phrase a management call gets, and the agents it is about. */
function manageAction(call: ToolCall, execution: ToolExecution | undefined, labelFor: RunLabel): { phrase: string; agents: string[] } {
  const details = isRecord(execution?.result?.details) ? execution.result.details : undefined
  const label = (runId: string | undefined) => (runId ? labelFor(runId) : undefined) ?? 'agent'
  if (call.name === 'bash' || call.name === 'powershell') {
    return { phrase: 'peek', agents: (describeSubagentPeek(str(call.arguments.command) ?? '')?.runIds ?? []).map(label) }
  }
  if (call.name === 'bg_wait') {
    const names = records(details?.completions).map((completion) => str(completion.agent) ?? label(str(completion.runId)))
    return { phrase: 'wait', agents: names.length > 0 ? names : ['background agents'] }
  }
  if (call.name === 'subagent_supervisor') {
    if ((str(call.arguments.action) ?? 'reply') !== 'reply') return { phrase: 'questions', agents: [] }
    return { phrase: 'reply', agents: [str(details?.agent) ?? label(str(details?.runId))] }
  }
  if (call.name === 'contact_supervisor') return { phrase: 'ask', agents: [] }
  const action = str(call.arguments.action) ?? ''
  const target = [label(str(call.arguments.id))]
  const options = isRecord(call.arguments.options) ? call.arguments.options : {}
  if (action === 'status' && str(options.view) === 'transcript') return { phrase: 'transcript', agents: target }
  if (action.startsWith('command.')) return { phrase: 'command', agents: target }
  return { phrase: action in MANAGE_PHRASES ? action : 'other', agents: target }
}

/** "answered worker · told worker ×2 · +1 more": what a group did to its agents, in call order. */
function managePhrases(calls: ToolCall[], executions: Record<string, ToolExecution | undefined>, active: boolean, labelFor: RunLabel): string[] {
  const counts = new Map<string, number>()
  for (const call of calls) {
    const { phrase, agents } = manageAction(call, executions[call.id], labelFor)
    const text = MANAGE_PHRASES[phrase]![active ? 1 : 0].replace('{}', labelList(agents))
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  const phrases = [...counts].map(([text, count]) => (count > 1 ? `${text} \u00d7${count}` : text))
  if (phrases.length <= MAX_MANAGE_PHRASES) return phrases
  return [...phrases.slice(0, MAX_MANAGE_PHRASES), `+${phrases.length - MAX_MANAGE_PHRASES} more`]
}

/**
 * One-line summary of a tool group: "Explored 6 files · 3 searches · ran 4 commands · edited 2 files +34 −8".
 * Present tense ("Exploring 3 files…") while `active`. Hidden plumbing tools are not counted. Agent management
 * is named per action ("answered worker · told worker"), with run names from `labelFor`.
 */
export function summarizeCalls(
  calls: ToolCall[],
  executions: Record<string, ToolExecution | undefined>,
  active: boolean,
  labelFor: RunLabel = () => undefined
): string {
  const verb = active ? PRESENT : PAST
  const of = (predicate: (call: ToolCall) => boolean) => calls.filter(predicate)
  const named = (...names: string[]) => of((c) => names.includes(c.name))
  const parts: string[] = []

  const reads = named('read')
  const lists = named('ls')
  if (reads.length || lists.length) {
    const things = [reads.length ? plural(distinctPaths(reads), 'file') : '', lists.length ? plural(distinctPaths(lists), 'folder') : ''].filter(Boolean)
    parts.push(`${verb.explore} ${things.join(', ')}`)
  }
  const searches = named('grep', 'find', 'glob').length
  if (searches) parts.push(plural(searches, 'search', 'searches'))
  const toolSearches = named('tool_search').length
  if (toolSearches) parts.push(plural(toolSearches, 'tool search', 'tool searches'))
  const resources = of((c) => MCP_RESOURCES.has(c.name)).length
  if (resources) parts.push(plural(resources, 'resource lookup'))
  const lens = of((c) => toolKind(c.name) === 'lens').length
  if (lens) parts.push(plural(lens, 'code check'))
  const web = of((c) => toolKind(c.name) === 'web').length
  if (web) parts.push(plural(web, 'web lookup'))

  const edits = of((c) => toolKind(c.name) === 'edit')
  if (edits.length) {
    let added = 0
    let removed = 0
    for (const call of edits) {
      const stats = call.name === 'edit' ? diffStats(executions[call.id]?.result?.details) : null
      added += stats?.added ?? 0
      removed += stats?.removed ?? 0
    }
    const stats = added || removed ? ` +${added} \u2212${removed}` : ''
    parts.push(`${verb.edit} ${plural(distinctPaths(edits), 'file')}${stats}`)
  }

  const commands = of((c) => (c.name === 'bash' || c.name === 'powershell') && toolCallKind(c) === 'run').length
  if (commands) parts.push(`${verb.run} ${plural(commands, 'command')}`)
  const scripts = named('codemode').length
  if (scripts) parts.push(`${verb.run} ${plural(scripts, 'script')}`)

  const launches = of(isSubagentLaunch)
  if (launches.length) parts.push(`${verb.delegate} ${agentNames(launches)}`)
  const managed = of((c) => (toolKind(c.name) === 'delegate' && !isSubagentLaunch(c)) || toolCallKind(c) === 'manage')
  if (managed.length) parts.push(...managePhrases(managed, executions, active, labelFor))
  if (of((c) => TODO_TOOLS.has(c.name)).length) parts.push(verb.todo)
  if (of((c) => isHistoryTool(c.name)).length) parts.push(verb.history)

  const others = of((c) => toolKind(c.name) === 'other' && !hasOwnPhrase(c.name))
  if (others.length === 1) {
    // A lone extra tool is named ("used Linear create issue") rather than counted.
    const only = others[0]!
    parts.push(`${verb.use} ${humanizeToolName(typeof only.arguments.tool === 'string' ? only.arguments.tool : only.name)}`)
  } else if (others.length) parts.push(plural(others.length, 'other tool'))

  const text = parts.join(' \u00b7 ')
  return text ? text[0]!.toUpperCase() + text.slice(1) : plural(calls.length, 'tool call')
}
