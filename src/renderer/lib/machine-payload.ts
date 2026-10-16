import { stripAnsi } from './ansi'

/** `PREFIX:{…}` / `PREFIX:[…]` envelopes such as `PI_SUBAGENT_ASYNC_JSON:{…}`. */
const PREFIXED_ENVELOPE = /^[A-Z][A-Z0-9_]{2,}:\s*[[{]/
/** Lines longer than this are checked for JSON punctuation density. */
const LONG_LINE = 300
/** Share of `{}[]":,` above which a long line reads as serialized data, not prose. */
const JSON_PUNCTUATION_SHARE = 0.12
const JSON_PUNCTUATION = /[{}[\]":,]/g

function isJsonText(text: string): boolean {
  const wrapped = (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
  if (!wrapped) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function isDenseLine(line: string): boolean {
  if (line.length <= LONG_LINE) return false
  return (line.match(JSON_PUNCTUATION)?.length ?? 0) / line.length > JSON_PUNCTUATION_SHARE
}

/**
 * True when extension status/widget text is data for a host (a JSON envelope), not words for a person. Such
 * payloads are kept for the inspector and never printed above the composer.
 */
export function isMachinePayload(lines: readonly string[]): boolean {
  const text = stripAnsi(lines.join('\n')).trim()
  if (!text) return false
  if (PREFIXED_ENVELOPE.test(text) || isJsonText(text)) return true
  return text.split('\n').some(isDenseLine)
}
