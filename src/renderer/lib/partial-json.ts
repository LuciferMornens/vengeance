/**
 * Best-effort parse of a truncated JSON object (streaming tool-call arguments).
 * Closes open strings/arrays/objects; returns undefined when nothing parseable yet.
 */
export function parsePartialJson(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // Fall through to repair.
  }
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let repaired = text
  if (inString) repaired += escaped ? '\\"' : '"'
  repaired = repaired.replace(/[,:]\s*$/, '').replace(/,\s*"[^"]*"?\s*$/, '')
  repaired += stack.reverse().join('')
  try {
    const value = JSON.parse(repaired) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
