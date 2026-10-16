/** rpc-process.ts: `Engine exited unexpectedly (code 1, SIGTERM): <stderr tail>`. */
const UNEXPECTED_EXIT = /^Engine exited unexpectedly \([^)]*\):?\s*/
/** A stderr line that says what went wrong (not noise, not a stack frame). */
const REASON_LINE = /error|failed|cannot|could not|not found|denied|refused|invalid|ENOENT|EACCES|EPERM/i
const STACK_FRAME = /^\s*at\s/
const FILE_URL_PREFIX = /file:\/\/\/?/g
/**
 * A quoted Windows path, an unquoted Windows path (folders may contain spaces, the last segment may not: `spawn
 * C:\Program Files\nodejs\node.exe ENOENT`), or a POSIX path with 2+ segments.
 */
const ABSOLUTE_PATH =
  /"[A-Za-z]:[\\/][^"]*"|[A-Za-z]:[\\/](?:[^\\/\s"'`)]+(?: [^\\/\s"'`)]+)*[\\/])*[^\\/\s"'`)]*|(?<![\w:/.])\/(?:[\w.@-]+\/)+[\w.@-]+/g
/** A bare drive root used as a label says nothing (the extension loader's `ParseError: D:\: Missing semicolon.`). */
const DRIVE_ROOT_LABEL = /(?<![\w"])[A-Za-z]:[\\/]:\s*/g
/** Path segments kept for display: the file and its folder say enough (`extensions/broken.ts`). */
const DISPLAY_SEGMENTS = 2

function displayPath(path: string): string {
  const quoted = path.startsWith('"')
  const bare = quoted ? path.slice(1, -1) : path
  const short = bare.split(/[\\/]+/).filter(Boolean).slice(-DISPLAY_SEGMENTS).join('/')
  return quoted ? `"${short}"` : short
}

function shortenPaths(text: string): string {
  return text.replace(FILE_URL_PREFIX, '').replace(DRIVE_ROOT_LABEL, '').replace(ABSOLUTE_PATH, displayPath)
}

/**
 * One calm line for the engine crash card: the reason without absolute paths, stack frames or stderr noise.
 * The raw text stays available in Diagnostics.
 */
export function friendlyEngineError(raw: string | undefined): string {
  if (!raw?.trim()) return 'The engine process exited unexpectedly.'
  const exit = UNEXPECTED_EXIT.exec(raw)
  if (!exit) return shortenPaths(raw.trim().split('\n')[0]!.trim())
  const reason = raw
    .slice(exit[0].length)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !STACK_FRAME.test(line) && REASON_LINE.test(line))
  return reason ? shortenPaths(reason) : 'The engine process exited unexpectedly.'
}
