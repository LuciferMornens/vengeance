import type { ProviderInfo } from '@shared/api/settings'

/**
 * When the provider refused to renew a stored OAuth sign-in: the Engine records `refreshRejectedAt` (epoch ms) on the
 * credential in auth.json once the token endpoint definitively rejects the refresh token (`invalid_grant`), keeps
 * every other field, and stops using the sign-in until a new one replaces the credential. Like the Engine
 * (`isOAuthRefreshRejected`), any number marks it; engines without the mark never write the field.
 */
export function refreshRejectedAt(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as { type?: unknown; refreshRejectedAt?: unknown }
  return entry.type === 'oauth' && typeof entry.refreshRejectedAt === 'number'
    ? entry.refreshRejectedAt
    : undefined
}

/** Masked description of a credential in the Engine's auth.json (never the secret itself). */
export function storedCredential(raw: unknown): ProviderInfo['stored'] {
  if (!raw || typeof raw !== 'object') return undefined
  const entry = raw as { type?: unknown; key?: unknown; expires?: unknown }
  if (entry.type === 'oauth') {
    const rejectedAt = refreshRejectedAt(raw)
    return {
      type: 'oauth',
      expiresAt: typeof entry.expires === 'number' ? entry.expires : undefined,
      ...(rejectedAt !== undefined ? { refreshRejectedAt: rejectedAt } : {})
    }
  }
  if (entry.type !== 'api_key') return undefined
  const key = typeof entry.key === 'string' ? entry.key : ''
  if (key.startsWith('!')) return { type: 'api_key', command: true, hint: 'Command' }
  if (/^\$\{?[A-Z0-9_]+\}?$/i.test(key)) return { type: 'api_key', hint: key }
  if (key.length >= 12) return { type: 'api_key', hint: `${key.slice(0, 4)}…${key.slice(-4)}` }
  return { type: 'api_key', hint: key ? '••••' : undefined }
}

/**
 * The providers of an auth.json text whose sign-in carries the Engine's refusal mark, sorted. Null when the text is
 * missing or cannot be parsed (mid-write).
 */
export function rejectedSignIns(text: string | null): string[] | null {
  if (text === null) return null
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return Object.entries(data as Record<string, unknown>)
      .filter(([, credential]) => refreshRejectedAt(credential) !== undefined)
      .map(([provider]) => provider)
      .sort()
  } catch {
    return null
  }
}

/**
 * How the refused sign-ins changed between two reads of auth.json: `cleared` when a mark went (a new sign-in replaced
 * the credential), `added` when the Engine only marked more, null when they are the same.
 */
export function rejectedSignInsChange(
  previous: string[],
  next: string[]
): 'added' | 'cleared' | null {
  if (previous.some((provider) => !next.includes(provider))) return 'cleared'
  return next.some((provider) => !previous.includes(provider)) ? 'added' : null
}
