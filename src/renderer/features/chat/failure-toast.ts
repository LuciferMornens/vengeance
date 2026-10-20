import { toast } from '../../ui'
import { revealSetting } from '../palette/settings-sections'
import { SIGN_IN_EXPIRED } from '../settings/provider-status'
import { knownEngineProviders } from './catalog-providers'
import { expiredSignInProvider, expiredSignInSummary } from './provider-error'

/** Settings → Providers at the provider's row, where an Engine sign-in the provider refused to renew is renewed. */
export function openSignIn(provider: string): void {
  revealSetting('providers', `provider.${provider}`, 'pi')
}

/**
 * Error toast for a command that failed. An Engine sign-in the provider refused to renew reads as in Settings →
 * Providers, with Sign in again and the provider's name from the Engine's catalog, instead of the Engine's own text,
 * which names a terminal command.
 */
export function toastFailure(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const provider = expiredSignInProvider(message)
  if (!provider) {
    toast({ level: 'error', title, description: message })
    return
  }
  toast({
    level: 'error',
    title,
    description: expiredSignInSummary(provider, knownEngineProviders()),
    action: { label: SIGN_IN_EXPIRED.action, onClick: () => openSignIn(provider) }
  })
}
