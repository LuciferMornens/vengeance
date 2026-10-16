/** A provider/engine error string reduced to something a human wants to read. */
export interface ParsedProviderError {
  /** Short headline, e.g. "Overloaded" or "Rate limit reached". */
  title: string
  /** Detail sentence from the provider, when different from the title. */
  detail?: string
  /** HTTP status, when present. */
  status?: number
  /** Provider error type/code, e.g. "overloaded_error". */
  code?: string
  /** The original string (for "show details"). */
  raw: string
}

const STATUS_TITLES: Record<number, string> = {
  400: 'The request was rejected',
  401: 'Not signed in to this provider',
  403: 'Access denied by the provider',
  404: 'Model or endpoint not found',
  408: 'The request timed out',
  413: 'The request was too large',
  429: 'Rate limit reached',
  500: 'The provider had an internal error',
  502: 'The provider is unreachable',
  503: 'The provider is unavailable',
  504: 'The provider timed out',
  529: 'The provider is overloaded'
}

const CODE_TITLES: Record<string, string> = {
  overloaded_error: 'The provider is overloaded',
  rate_limit_error: 'Rate limit reached',
  rate_limit_exceeded: 'Rate limit reached',
  insufficient_quota: 'Out of credits for this provider',
  authentication_error: 'Not signed in to this provider',
  invalid_api_key: 'The API key was rejected',
  permission_error: 'Access denied by the provider',
  not_found_error: 'Model or endpoint not found',
  context_length_exceeded: 'The conversation is too long for this model',
  invalid_request_error: 'The request was rejected',
  api_error: 'The provider had an internal error'
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function findJson(text: string): JsonValue | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as JsonValue
    } catch {
      // try a shorter span
    }
  }
  return undefined
}

function pick(obj: JsonValue | undefined, ...keys: string[]): JsonValue | undefined {
  let cur = obj
  for (const key of keys) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined
}

/** The readable headline of an HTML error page (a proxy's `<title>` or first `<h1>`), without the status code. */
function markupHeadline(markup: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markup) ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(markup)
  const text = match?.[1]
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text?.replace(/^\d{3}\s*/, '') || undefined
}

/** Extract status, type and message from strings like `529 {"type":"error","error":{…}}`. */
export function parseProviderError(raw: string | undefined): ParsedProviderError {
  const text = (raw ?? '').trim() || 'The model returned an error.'
  const statusMatch = /^(?:Error:\s*)?(\d{3})\b/.exec(text) ?? /\bstatus(?:\s*code)?[:= ]+(\d{3})\b/i.exec(text)
  const status = statusMatch ? Number(statusMatch[1]) : undefined
  const json = findJson(text)
  let message: string | undefined
  let code: string | undefined
  if (json !== undefined) {
    message =
      asString(pick(json, 'error', 'message')) ??
      asString(pick(json, 'message')) ??
      asString(pick(json, 'error', 'error', 'message')) ??
      asString(pick(json, 'detail')) ??
      asString(pick(json, 'error'))
    code =
      asString(pick(json, 'error', 'type')) ??
      asString(pick(json, 'error', 'code')) ??
      asString(pick(json, 'error', 'status')) ??
      asString(pick(json, 'code')) ??
      (asString(pick(json, 'type')) !== 'error' ? asString(pick(json, 'type')) : undefined)
    // Some providers double-encode the message.
    if (message && message.startsWith('{')) {
      const inner = findJson(message)
      message = asString(pick(inner, 'error', 'message')) ?? asString(pick(inner, 'message')) ?? message
    }
  } else {
    const rest = text.replace(/^(?:Error:\s*)?\d{3}\s*/, '').trim()
    // A proxy's HTML error page: only its headline is readable; the page itself stays in `raw`.
    message = rest.startsWith('<') ? markupHeadline(rest) : rest || undefined
  }
  const known = (code && CODE_TITLES[code]) || (status && STATUS_TITLES[status])
  const title = known || message || (text.startsWith('<') ? 'The provider returned an error page' : text)
  const detail = message && message !== title && message.toLowerCase() !== title.toLowerCase() ? message : undefined
  return { title, detail, status, code, raw: text }
}
