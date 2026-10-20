import { strict as assert } from 'node:assert'
import type { ProviderInfo } from '@shared/api/settings'
import { authSignature } from '../../src/main/features/settings/config-areas'
import {
  rejectedSignIns,
  rejectedSignInsChange,
  storedCredential
} from '../../src/main/features/settings/stored-credential'
import { providerName } from '../../src/renderer/features/settings/provider-name'
import {
  hasCredential,
  providerUsable,
  SIGN_IN_EXPIRED,
  signInExpired
} from '../../src/renderer/features/settings/provider-status'
import { check } from './harness'

const REJECTED_AT = 1_790_000_000_000
const ACCESS = 'access-token-secret-0001'
const REFRESH = 'refresh-token-secret-0002'

function oauth(extra: Record<string, unknown> = {}) {
  return { type: 'oauth', access: ACCESS, refresh: REFRESH, expires: 1_700_000_000_000, ...extra }
}

function provider(overrides: Partial<ProviderInfo>): ProviderInfo {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    oauth: { name: 'Anthropic (Claude Pro/Max)', subscription: true },
    status: { configured: true, source: 'stored', usingOAuth: true },
    envVars: [],
    modelCount: 12,
    availableCount: 12,
    ...overrides
  }
}

await check(
  'refused sign-in: storedCredential carries the Engine’s refreshRejectedAt mark, never the tokens',
  () => {
    const stored = storedCredential(oauth({ refreshRejectedAt: REJECTED_AT }))
    assert.deepEqual(stored, {
      type: 'oauth',
      expiresAt: 1_700_000_000_000,
      refreshRejectedAt: REJECTED_AT
    })
    assert.ok(!JSON.stringify(stored).includes(ACCESS) && !JSON.stringify(stored).includes(REFRESH))
    assert.deepEqual(storedCredential(oauth()), { type: 'oauth', expiresAt: 1_700_000_000_000 })
  }
)

await check(
  'refused sign-in: any number marks it, as for the Engine; anything else is no mark',
  () => {
    for (const value of [0, -1]) {
      assert.equal(storedCredential(oauth({ refreshRejectedAt: value }))?.refreshRejectedAt, value)
    }
    for (const value of ['2026-10-20', null, true, {}]) {
      const stored = storedCredential(oauth({ refreshRejectedAt: value }))
      assert.equal(stored?.refreshRejectedAt, undefined, `refreshRejectedAt: ${String(value)}`)
    }
    // Only OAuth sign-ins are renewed; a key never reads as expired.
    const key = storedCredential({
      type: 'api_key',
      key: 'sk-test-0000000000000000',
      refreshRejectedAt: REJECTED_AT
    })
    assert.equal(key?.refreshRejectedAt, undefined)
  }
)

await check(
  'refused sign-in: a new mark is a live auth.json change, a cleared one a sign-in',
  () => {
    const before = JSON.stringify({
      openai: oauth(),
      anthropic: oauth(),
      groq: { type: 'api_key', key: 'k' }
    })
    const marked = JSON.stringify({
      groq: { type: 'api_key', key: 'k', refreshRejectedAt: REJECTED_AT },
      openai: oauth({ refreshRejectedAt: REJECTED_AT }),
      anthropic: oauth({ refreshRejectedAt: REJECTED_AT + 1 })
    })
    assert.equal(authSignature(marked), authSignature(before), 'the provider set is unchanged')
    assert.deepEqual(rejectedSignIns(before), [])
    assert.deepEqual(rejectedSignIns(marked), ['anthropic', 'openai'])
    assert.deepEqual(rejectedSignIns(`\uFEFF${marked}`), ['anthropic', 'openai'])
    assert.equal(rejectedSignIns('{"half": '), null)
    assert.equal(rejectedSignIns('[]'), null)
    assert.equal(rejectedSignIns(null), null)
    // Only new marks are live; a cleared one is a new sign-in, which open sessions pick up after a restart.
    assert.equal(rejectedSignInsChange([], ['openai']), 'added')
    assert.equal(rejectedSignInsChange(['anthropic'], ['anthropic', 'openai']), 'added')
    assert.equal(rejectedSignInsChange(['openai'], []), 'cleared')
    assert.equal(rejectedSignInsChange(['openai'], ['anthropic']), 'cleared')
    assert.equal(rejectedSignInsChange(['anthropic', 'openai'], ['anthropic', 'openai']), null)
  }
)

await check(
  'refused sign-in: Settings shows it expired; it counts as usable only through another credential',
  () => {
    const expired = provider({
      stored: { type: 'oauth', refreshRejectedAt: REJECTED_AT },
      availableCount: 0
    })
    assert.equal(signInExpired(expired), true)
    assert.equal(providerUsable(expired), false, 'no models: not connected in onboarding')
    assert.equal(hasCredential(expired), true, 'listed with the connected providers')
    // An engine that still lists the models but uses the stored (refused) sign-in for them.
    assert.equal(providerUsable({ ...expired, availableCount: 12 }), false)
    // The Engine reports the provider unconfigured: still listed, so Sign in again stays where the sign-in was.
    const unconfigured = { ...expired, status: { configured: false, usingOAuth: false } }
    assert.equal(hasCredential(unconfigured), true)
    assert.equal(providerUsable(unconfigured), false)
    // An environment key still gives the Engine the provider's models.
    const environment = {
      ...expired,
      status: { configured: true, source: 'environment' as const, usingOAuth: false },
      availableCount: 4
    }
    assert.equal(providerUsable(environment), true)

    const working = provider({ stored: { type: 'oauth', expiresAt: 1 } })
    assert.equal(signInExpired(working), false)
    assert.equal(providerUsable(working), true)
    assert.equal(signInExpired(provider({ stored: { type: 'api_key', hint: 'sk-…0000' } })), false)
    assert.equal(
      hasCredential(provider({ status: { configured: false, usingOAuth: false } })),
      false
    )
  }
)

await check(
  'refused sign-in: an expired ChatGPT sign-in keeps its name, and the copy names no backend',
  () => {
    const chatgpt = {
      id: 'openai',
      name: 'OpenAI',
      stored: { type: 'oauth' as const, refreshRejectedAt: REJECTED_AT },
      status: { usingOAuth: false }
    }
    assert.equal(providerName(chatgpt), 'ChatGPT')
    assert.equal(providerName({ ...chatgpt, stored: { type: 'api_key' } }), 'OpenAI')
    assert.equal(SIGN_IN_EXPIRED.label, 'Sign-in expired')
    assert.equal(SIGN_IN_EXPIRED.action, 'Sign in again')
    for (const text of Object.values(SIGN_IN_EXPIRED)) assert.doesNotMatch(text, /\bpi\b/i)
  }
)
