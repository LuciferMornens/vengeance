import type { ProviderInfo } from '@shared/api/settings'

/** How the app names a sign-in the provider refused to renew, and what to do about it. */
export const SIGN_IN_EXPIRED = {
  label: 'Sign-in expired',
  explanation: 'The provider rejected the saved sign-in. Sign in again to use its models.',
  action: 'Sign in again'
} as const

/**
 * The provider refused to renew the saved sign-in (the Engine's `refreshRejectedAt` mark): the Engine no longer uses
 * it until a new sign-in replaces it.
 */
export function signInExpired(p: Pick<ProviderInfo, 'stored'>): boolean {
  return p.stored?.type === 'oauth' && p.stored.refreshRejectedAt !== undefined
}

/**
 * Whether the engine can use the provider now. With an expired sign-in it counts only while the engine reports
 * another credential (an environment key) that still offers the provider's models: the stored one is refused.
 */
export function providerUsable(
  p: Pick<ProviderInfo, 'status' | 'stored' | 'availableCount'>
): boolean {
  if (!p.status.configured) return false
  if (!signInExpired(p)) return true
  return p.status.source !== 'stored' && p.availableCount > 0
}

/** A credential is saved for the provider, working or not: Settings lists it with the connected ones. */
export function hasCredential(p: Pick<ProviderInfo, 'status' | 'stored'>): boolean {
  return p.status.configured || signInExpired(p)
}
