import type { ProviderInfo } from '@shared/api/settings'
import { providerName } from '../settings/provider-name'
import { SIGN_IN_EXPIRED } from '../settings/provider-status'

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
  /**
   * The provider (its Engine id) refused to renew the Engine's sign-in for it: the title and detail read as in
   * Settings → Providers, where signing in again is the remedy.
   */
  expiredSignIn?: string
}

/**
 * The Engine's failures for a sign-in the provider refused to renew: a request ("… rejected its refresh token
 * (<the token endpoint's error>). Sign in again.") and a prompt or model switch ("… Run '/login <provider>' to sign
 * in again.", a terminal command). Both name the provider first. A compaction and a branch summary report the
 * request's failure behind their own label ("Summarization failed: …", "Turn prefix summarization failed: …",
 * "Branch summarization failed: …").
 */
const EXPIRED_SIGN_IN =
  /^(?:Error:\s*)?(?:(?:Turn prefix s|Branch s|S)ummarization failed:\s*)?Sign-in for (\S+) expired: the provider rejected its refresh token\b/

/** The provider of an Engine error about a sign-in the provider refused to renew; undefined for any other error. */
export function expiredSignInProvider(raw: string | undefined): string | undefined {
  return EXPIRED_SIGN_IN.exec((raw ?? '').trim())?.[1]
}

/**
 * UI name of the provider whose Engine sign-in expired, from the Engine's catalog when given. Only OAuth sign-ins are
 * renewed, so `openai` reads as ChatGPT.
 */
export function expiredSignInName(provider: string, providers?: readonly ProviderInfo[]): string {
  const known = providers?.find((p) => p.id === provider)
  return providerName({
    ...(known ?? { id: provider, name: provider }),
    status: { usingOAuth: true }
  })
}

/** The expired sign-in for a toast: "Sign-in expired for ChatGPT. The provider rejected the saved sign-in. …" */
export function expiredSignInSummary(
  provider: string,
  providers?: readonly ProviderInfo[]
): string {
  return `${SIGN_IN_EXPIRED.label} for ${expiredSignInName(provider, providers)}. ${SIGN_IN_EXPIRED.explanation}`
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
  // Before any status or JSON: the token endpoint's error the Engine quotes would hide the remedy.
  const expiredSignIn = expiredSignInProvider(text)
  if (expiredSignIn)
    return {
      title: SIGN_IN_EXPIRED.label,
      detail: SIGN_IN_EXPIRED.explanation,
      raw: text,
      expiredSignIn
    }
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
