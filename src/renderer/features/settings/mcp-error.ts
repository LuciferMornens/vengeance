/**
 * A short reason for an MCP server that failed to start. Its error is often the server's raw stderr: a
 * broken pipe, Node's source excerpt, a stack trace and Node's version banner around one useful line.
 */

/** `Error: Cannot find module …`, `TypeError: …`: the message, up to where a stack or error object starts. */
const ERROR_STATEMENT = /\b(?:[A-Z][A-Za-z]*)?Error: (.+?)(?=\s+at\s|\s+\{|\s+Node\.js v\d|$)/

/** Lines that never explain the failure on their own. */
const NOISE = [
  /^write E[A-Z]+$/,
  /^at\s/,
  /node:internal\//,
  /^Node\.js v\d/,
  /^[\^~\s]+$/,
  /^throw\b/,
  /^[{}[\]]/
]

/** A quoted absolute path, shortened to its file name: `'D:\x\server.mjs'` → `'server.mjs'`. */
const QUOTED_PATH = /(['"])(?:[A-Za-z]:)?[\\/](?:[^'"]*[\\/])?([^'"\\/]+)\1/g

export function mcpFailureReason(error: string): string {
  const lines = error
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const statement = lines
    .map((line) => ERROR_STATEMENT.exec(line)?.[1])
    .find((message) => message !== undefined)
  const reason =
    statement ??
    lines.find((line) => !NOISE.some((pattern) => pattern.test(line))) ??
    lines[0] ??
    error
  return reason.replace(QUOTED_PATH, '$1$2$1')
}
