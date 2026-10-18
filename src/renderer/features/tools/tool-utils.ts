import type { ImageContent, ToolCall, ToolResultPayload } from '@shared/engine-types'
import { isWindowsPath } from '../../lib/path-kind'
import type { ToolExecution } from '../../store/agent-state'

/** Display phase of a tool row (adds `aborted` for interrupted/cancelled calls on top of the store's ToolStatus). */
export type ToolPhase = 'streaming' | 'pending' | 'running' | 'done' | 'error' | 'aborted'

/** Result if finished, else the latest partial result. */
export function resultPayload(execution: ToolExecution | undefined): ToolResultPayload | undefined {
  return execution?.result ?? execution?.partialResult
}

export function payloadText(payload: ToolResultPayload | undefined): string {
  if (!payload || !Array.isArray(payload.content)) return ''
  return payload.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

export function payloadImages(payload: ToolResultPayload | undefined): ImageContent[] {
  if (!payload || !Array.isArray(payload.content)) return []
  return payload.content.filter((c): c is ImageContent => c.type === 'image')
}

const ABORTED = /\b(aborted|cancelled|canceled|interrupted)\b/i
/** pi's bash appends this to the output of a command stopped by an abort. */
const SHELL_ABORTED = /\n\nCommand aborted\s*$/

/**
 * Phase shown in the row. Interrupted calls (`ToolExecution.interrupted`: abort, crash, or resumed
 * history without a result) and calls still open while the agent is idle render as aborted, not as errors.
 */
export function toolPhase(execution: ToolExecution | undefined, agentRunning: boolean): ToolPhase {
  if (execution?.interrupted) return 'aborted'
  const status = execution?.status ?? 'pending'
  if (status === 'error') {
    const text = payloadText(execution?.result)
    return (ABORTED.test(text.slice(0, 200)) && text.length < 400) || SHELL_ABORTED.test(text) ? 'aborted' : 'error'
  }
  if (status === 'done') return 'done'
  if (!agentRunning) return execution?.result ? 'done' : 'aborted'
  return status
}

export function isActive(phase: ToolPhase): boolean {
  return phase === 'streaming' || phase === 'pending' || phase === 'running'
}

// ─── Argument helpers (tool arguments are untyped JSON) ───────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The `details` object of a result payload, if it is one. */
export function detailsOf(execution: ToolExecution | undefined): Record<string, unknown> | undefined {
  const details = resultPayload(execution)?.details
  return isRecord(details) ? details : undefined
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/** First line of a text, trimmed. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

const REASON_LINE = /error|failed|fatal|cannot|not found|denied|ENOENT|\u2717|Traceback|Exception/i
/** Lines a failed command prints that say nothing about the failure (`node -v`, `git --version`, Node's hints). */
const NOT_A_REASON = /^(?:Node\.js v\d|git version\b|v?\d+(?:\.\d+)+\S*$|\(Use `node --trace|\^+$)/

/** The line of a failed command's output that best explains it: the first error-like line, else the last real one. */
export function reasonLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const reasons = lines.filter((line) => !NOT_A_REASON.test(line))
  return reasons.find((line) => REASON_LINE.test(line)) ?? reasons[reasons.length - 1] ?? ''
}

/** Node file-system error codes as plain words (the error text names an absolute, often temporary, path). */
const FS_ERROR_PHRASES: Record<string, string> = {
  ENOENT: 'File not found',
  EACCES: 'Permission denied',
  EPERM: 'Permission denied',
  EISDIR: 'This is a folder, not a file',
  ENOTDIR: 'A folder in the path is a file',
  EBUSY: 'The file is in use',
  EMFILE: 'Too many open files'
}

/**
 * A tool's file error in words with the path as the row shows it: `ENOENT: no such file or directory, access
 * '<absolute path>'` reads "File not found: missing.txt". Other errors keep their first line.
 */
export function fileErrorReason(text: string, shownPath: string): string {
  const line = firstLine(text)
  const phrase = FS_ERROR_PHRASES[/^(?:Error:\s*)?(E[A-Z]+)\b/.exec(line)?.[1] ?? '']
  if (!phrase) return line
  return shownPath ? `${phrase}: ${shownPath}` : phrase
}

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * For comparing paths: no trailing slash; Windows paths (see isWindowsPath) also with forward slashes, the Git Bash
 * drive form (`/d/x`) as `d:/x`, and lowercase. POSIX paths keep their case and backslashes.
 */
export function normalizePath(path: string, windows: boolean): string {
  if (!windows) return path.replace(/\/+$/, '')
  return path
    .replace(/\\/g, '/')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Path relative to the workspace when inside it, with forward slashes for display. */
export function displayPath(path: string, cwd: string | undefined): string {
  const bare = path.replace(/^@/, '')
  const windows = isWindowsPath(cwd || bare)
  const p = windows ? bare.replace(/\\/g, '/') : bare
  if (cwd) {
    const base = normalizePath(cwd, windows)
    const full = normalizePath(p, windows)
    // normalizePath keeps character positions, so the prefix length carries over to `p`.
    if (full === base) return '.'
    if (full.startsWith(`${base}/`)) return p.slice(base.length + 1)
  }
  return p
}

/** Whether a display path still points outside the workspace (absolute after `displayPath`). */
export function isAbsolutePath(path: string): boolean {
  return /^([a-z]:)?\//i.test(path)
}

/** A path outside the workspace as `…/parent/name` (the full path belongs in a tooltip); `/etc/hosts` stays whole. */
export function shortPath(path: string): string {
  if (!isAbsolutePath(path)) return path
  const parts = path.replace(/\/+$/, '').split('/')
  // A POSIX path's leading '' is its root, not a name; a Windows path's drive counts as one.
  const segments = isWindowsPath(path) ? parts.length : parts.length - 1
  return segments > 2 ? `\u2026/${parts.slice(-2).join('/')}` : path
}

/** Last segment of a path (either separator). */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) }
}

/**
 * A leading `cd <dir> && ` / `cd <dir>; ` of a shell command. The row subject drops it; `dir` is returned only
 * when it differs from the session's working folder (shown as an "in <dir>" chip).
 */
export function stripCdPrefix(command: string, cwd: string | undefined): { command: string; dir?: string } {
  const match = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*(&&|;)\s*/.exec(command)
  if (!match) return { command }
  const dir = match[2] ?? match[3] ?? match[4] ?? ''
  const rest = command.slice(match[0].length)
  if (!rest.trim()) return { command }
  const windows = cwd !== undefined && isWindowsPath(cwd)
  const same = cwd !== undefined && normalizePath(dir, windows) === normalizePath(cwd, windows)
  return same ? { command: rest } : { command: rest, dir }
}

/** The commands of a shell line, split on `;`, `&&`, `||` (and `|` with `pipes`) outside quotes. */
function shellSegments(command: string, pipes: boolean): string[] {
  const segments: string[] = []
  let quote: string | null = null
  let current = ''
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) quote = null
      current += char
      continue
    }
    if (char === '"' || char === "'") quote = char
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      i++
    } else if (char === ';' || (pipes && char === '|')) {
      segments.push(current)
      current = ''
    } else {
      current += char
    }
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/** A file in a pi-subagents async run folder (`…/async-subagent-runs/<run id>/output-0.log`), quoted or not. */
const SUBAGENT_RUN_FILE = /(["']?)[^"'\s]*async-subagent-runs[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\/][^"'\s]*)?\1/gi
/** `tail -c 900 `, `cat `, `head -n 20 2>&1`: what is left of a peek once its run file is taken out. */
const PEEK_COMMAND = /^(?:tail|head|cat)(?:\s+-{1,2}[\w-]+(?:[=\s]+\+?\d+)?)*(?:\s*\d?>(?:&\d|\/dev\/null))*\s*$/
const SLEEP_COMMAND = /^sleep\s+(\d+(?:\.\d+)?)s?$/
const ECHO_COMMAND = /^echo\b[^<>|]*$/

/** A shell call that only reads background runs' output (after a `cd`, with `sleep`/`echo`): the parent peeking. */
export interface SubagentPeek {
  runIds: string[]
  /** Seconds of `sleep` before or between the reads. */
  waitedS?: number
}

export function describeSubagentPeek(command: string): SubagentPeek | null {
  const runIds: string[] = []
  let waitedS = 0
  for (const segment of shellSegments(stripCdPrefix(command, undefined).command, false)) {
    const sleep = SLEEP_COMMAND.exec(segment)
    if (sleep) {
      waitedS += Number(sleep[1])
      continue
    }
    if (ECHO_COMMAND.test(segment)) continue
    const ids = [...segment.matchAll(SUBAGENT_RUN_FILE)].map((match) => match[2]!.toLowerCase())
    if (ids.length === 0 || !PEEK_COMMAND.test(segment.replace(SUBAGENT_RUN_FILE, ''))) return null
    runIds.push(...ids)
  }
  if (runIds.length === 0) return null
  return { runIds: [...new Set(runIds)], waitedS: waitedS || undefined }
}

/** A drive-letter path in a command (not the `s://` of a URL). */
const DRIVE_PATH = /(?<![\w/\\])[A-Za-z]:[\\/][^\s"'`;|&<>()]*/g
/**
 * An absolute POSIX path of two or more names in a command. Not the `//host/x` of a URL or a path continued from
 * `~`, `.`, `$HOME`, `${x}`, `$(pwd)` or a glob; `:` and `,` end it (`PATH` lists, `sed '/a/,/b/p'` ranges).
 */
const POSIX_PATH = /(?<![\w/\\:.~$}*)-])\/[^\s"'`;|&<>(),:/]+(?:\/[^\s"'`;|&<>(),:/]*)+/g

/** Text of a command, or a background run's file (shown by the run's name instead of its path). */
export type CommandPart = string | { runId: string }

/**
 * A command for display: background run files become run references, workspace paths become relative and
 * other absolute paths `…/parent/name`. Paths are drive-letter paths in a Windows workspace (or without one) and
 * POSIX paths in a macOS or Linux one.
 */
export function humanizeCommand(command: string, cwd: string | undefined): CommandPart[] {
  const paths = cwd && !isWindowsPath(cwd) ? POSIX_PATH : DRIVE_PATH
  const shorten = (text: string) =>
    text.replace(paths, (path) => {
      const shown = displayPath(path, cwd)
      return isAbsolutePath(shown) ? shortPath(shown) : shown
    })
  const parts: CommandPart[] = []
  let last = 0
  for (const match of command.matchAll(SUBAGENT_RUN_FILE)) {
    parts.push(shorten(command.slice(last, match.index)), { runId: match[2]!.toLowerCase() })
    last = match.index + match[0].length
  }
  parts.push(shorten(command.slice(last)))
  return parts.filter((part) => part !== '')
}

/** What exit status 1 of these commands means when they print nothing (or a zero count). */
const QUIET_EXIT_MEANING: Record<string, string> = {
  grep: 'no matches',
  egrep: 'no matches',
  fgrep: 'no matches',
  rg: 'no matches',
  findstr: 'no matches',
  test: 'false',
  '[': 'false'
}

/** Exit code from a shell result: structured output, else the trailing engine note. */
export function shellExitCode(payload: ToolResultPayload | undefined, notes: string[]): number | undefined {
  const structured = payload?.structuredContent
  if (isRecord(structured)) {
    const code = num(structured.exit_code)
    if (code !== undefined) return code
  }
  for (const note of notes) {
    const match = /Command exited with code (-?\d+)/.exec(note)
    if (match) return Number(match[1])
  }
  return undefined
}

/** pi's placeholder result for a command that printed nothing. */
export const NO_OUTPUT = '(no output)'

/**
 * "no matches" / "false" for a shell call that exited 1 only because its last command (`grep -c`, `rg`, `test`)
 * found nothing: the output is empty or a zero count.
 */
export function quietExitMeaning(command: string, payload: ToolResultPayload | undefined): string | undefined {
  const { body: withNotes } = splitLensVerdict(payloadText(payload))
  const { body, notes } = splitTrailingNotes(withNotes)
  if (shellExitCode(payload, notes) !== 1) return undefined
  const output = body.trim()
  if (output !== '' && output !== '0' && output !== NO_OUTPUT) return undefined
  const last = shellSegments(command, true).pop() ?? ''
  const program = baseName(last.split(/\s+/)[0] ?? '').replace(/\.exe$/i, '')
  return QUIET_EXIT_MEANING[program]
}

/** pi-subagents' answer to `command.*` when the child has no shell command to control. */
const NO_COMMAND_CONTROLLER = /No command controller/

/**
 * Errors that are not failures: a `grep`-style exit 1 with no output, and a subagent command check when the
 * child has no command running. Rows render them as done, and groups neither pin nor count them.
 */
export function isBenignFailure(call: ToolCall, execution: ToolExecution | undefined): boolean {
  if (execution?.status !== 'error' || execution.interrupted) return false
  if (call.name === 'bash' || call.name === 'powershell') return quietExitMeaning(str(call.arguments.command) ?? '', execution.result) !== undefined
  if (call.name === 'subagent') return (str(call.arguments.action) ?? '').startsWith('command.') && NO_COMMAND_CONTROLLER.test(payloadText(execution.result))
  return false
}

// ─── Result text ──────────────────────────────────────────────────────────────

/**
 * Separate trailing engine notes (`[Showing lines 1-200 of 900 …]`, `Command exited with code 1`)
 * from tool output so details can render them as footnotes.
 */
export function splitTrailingNotes(text: string): { body: string; notes: string[] } {
  const notes: string[] = []
  let body = text
  for (;;) {
    const match = /\n*\n(\[[^\n]*\]|Command exited with code -?\d+|Command (?:aborted|timed out[^\n]*|terminated[^\n]*))\s*$/.exec(body)
    if (!match) break
    notes.unshift(match[1]!.replace(/^\[|\]$/g, ''))
    body = body.slice(0, match.index)
  }
  return { body, notes }
}

/** Code-intelligence verdict that pi-lens appends to tool results ("TypeScript clean", "STOP: 3 issues"). */
export interface LensVerdict {
  /** Languages reported clean, e.g. "JavaScript/TypeScript". */
  ok: string[]
  issues: number
  warnings: number
  /** First issue line, e.g. "L49 unexpected token". */
  firstIssue?: string
  /** The full verdict block as appended to the result. */
  block: string
}

const LENS_OK = /^\u2713\s+(.+?)\s+clean\b/
const LENS_ISSUES = /^\u{1F534}\s*STOP\s*[\u2014\u2013-]\s*(\d+)\s+issue/u
const LENS_WARNINGS = /^\u{1F7E1}\s*(\d+)\s+warning/u
const LENS_INFO = /^(Post-apply analysis:?|Pi-lens\b.*\bunavailable\b.*)$/i
const ARROW = '\u2192'

function isLensHeader(line: string): boolean {
  return LENS_OK.test(line) || LENS_ISSUES.test(line) || LENS_WARNINGS.test(line) || LENS_INFO.test(line)
}

/**
 * Split the trailing pi-lens verdict block off a tool result. The block is the run of lens header lines (with
 * their indented detail lines) at the end of the text; anything else, including unknown footers, stays in `body`.
 */
export function splitLensVerdict(text: string): { body: string; lens: LensVerdict | null } {
  const lines = text.replace(/\s+$/, '').split('\n')
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (isLensHeader(line.trim())) start = i
    else if (line.trim() !== '' && !/^\s/.test(line) && !line.startsWith(ARROW)) break
  }
  if (start === lines.length) return { body: text, lens: null }
  const blockLines = lines.slice(start)
  const lens: LensVerdict = { ok: [], issues: 0, warnings: 0, block: blockLines.join('\n') }
  let inIssues = false
  for (const raw of blockLines) {
    const line = raw.trim()
    const ok = LENS_OK.exec(line)
    const issues = LENS_ISSUES.exec(line)
    const warnings = LENS_WARNINGS.exec(line)
    if (ok) lens.ok.push(ok[1]!)
    if (issues) lens.issues += Number(issues[1])
    if (warnings) lens.warnings += Number(warnings[1])
    if (isLensHeader(line)) inIssues = !!issues
    else if (inIssues && line && !lens.firstIssue) lens.firstIssue = line.replace(/^(L\d+):\s*/, '$1 ')
  }
  return { body: lines.slice(0, start).join('\n').replace(/\s+$/, ''), lens }
}

export function lineCount(text: string): number {
  if (!text) return 0
  const end = text.endsWith('\n') ? text.length - 1 : text.length
  let lines = 1
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) lines++
  }
  return lines
}

/** `+added −removed` of an edit, from the unified `details.patch` or pi's display `details.diff`. */
export function diffStats(details: unknown): { added: number; removed: number } | null {
  if (!isRecord(details)) return null
  const patch = str(details.patch)
  const source = patch ?? str(details.diff)
  if (!source) return null
  let added = 0
  let removed = 0
  for (const line of source.split('\n')) {
    if (patch && (line.startsWith('+++') || line.startsWith('---'))) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

// ─── Tool families ────────────────────────────────────────────────────────────

/** Tools that only switch other tools on: never rendered and never counted. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['subagents_enable', 'pi_lens_activate_tools', 'web_enable'])

export type ToolKind = 'explore' | 'search' | 'edit' | 'run' | 'web' | 'lens' | 'delegate' | 'manage' | 'other' | 'hidden'

const KIND_BY_NAME: Record<string, ToolKind> = {
  read: 'explore',
  ls: 'explore',
  grep: 'search',
  find: 'search',
  glob: 'search',
  edit: 'edit',
  write: 'edit',
  bash: 'run',
  powershell: 'run',
  codemode: 'run',
  web_search: 'web',
  websearch: 'web',
  WebSearch: 'web',
  fetch_content: 'web',
  get_search_content: 'web',
  source_check: 'web',
  web_fetch: 'web',
  WebFetch: 'web',
  fetch: 'web',
  lens_diagnostics: 'lens',
  read_symbol: 'lens',
  module_report: 'lens',
  lsp_navigation: 'lens',
  ast_grep_search: 'lens',
  lens_diagnostic_mark: 'lens',
  subagent: 'delegate',
  subagents: 'delegate',
  task: 'delegate',
  Task: 'delegate',
  bg_wait: 'manage',
  subagent_supervisor: 'manage',
  contact_supervisor: 'manage'
}

/** Family of a tool by name (the activity summary counts by family). */
export function toolKind(name: string): ToolKind {
  if (HIDDEN_TOOLS.has(name)) return 'hidden'
  return KIND_BY_NAME[name] ?? 'other'
}

/** Family of a call: a shell call that only peeks at background runs is agent management, not a command. */
export function toolCallKind(call: ToolCall): ToolKind {
  const shell = call.name === 'bash' || call.name === 'powershell'
  if (shell && describeSubagentPeek(str(call.arguments.command) ?? '')) return 'manage'
  return toolKind(call.name)
}

/** "lens_diagnostics" / "mcp__github__create_issue" → "Lens diagnostics" / "Create issue". */
export function humanizeToolName(name: string): string {
  const last = name.split('__').pop() ?? name
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : name
}

/**
 * MCP server of a tool call: `details.server` of the result (pi's `McpToolDetails`, exact even when the
 * tool name was sanitized or hashed), else parsed from the `mcp__<server>__<tool>` name.
 */
export function mcpServer(name: string, execution?: ToolExecution): string | null {
  const details = resultPayload(execution)?.details
  if (isRecord(details) && typeof details.server === 'string' && typeof details.tool === 'string') return details.server
  const parts = name.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts[1]! : null
}
