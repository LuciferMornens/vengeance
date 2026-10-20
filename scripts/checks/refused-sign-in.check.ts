import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderInfo } from '@shared/api/settings'
import type { Model, RpcCommand, RpcResponse, RpcSuccessResponse } from '@shared/engine-types'
import { cycleToOffered } from '../../src/main/engine/manager'
import { authSignature } from '../../src/main/features/settings/config-areas'
import {
  rejectedSignIns,
  rejectedSignInsAt,
  rejectedSignInsChange,
  storedCredential,
  withoutRejectedSignIns
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

const ref = (key: string) => {
  const [provider = '', id = ''] = key.split('/')
  return { provider, id }
}

/** The keys of `models` a filter keeps (null: every one). */
function kept(
  filter: ((model: { provider: string; id: string }) => boolean) | null,
  models: string[]
) {
  return filter ? models.filter((key) => filter(ref(key))) : models
}

const MODELS = ['openai/gpt-a', 'openai/gpt-b', 'anthropic/claude', 'groq/llama']

/** Two agent dirs in a fresh temp folder, removed after `run`. */
function withAgentDirs(run: (dirs: { a: string; b: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'vengeance-refused-sign-in-'))
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    run({ a, b })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await check(
  'refused sign-in: model lists leave out the marked providers of the auth.json a conversation reads',
  () => {
    withAgentDirs(({ a, b }) => {
      const authA = join(a, 'auth.json')
      const authB = join(b, 'auth.json')
      writeFileSync(
        authA,
        JSON.stringify({
          openai: oauth({ refreshRejectedAt: REJECTED_AT }),
          anthropic: oauth(),
          groq: { type: 'api_key', key: 'k' }
        })
      )
      writeFileSync(authB, JSON.stringify({ openai: oauth() }))
      assert.deepEqual([...rejectedSignInsAt(authA)], ['openai'])
      assert.deepEqual(kept(withoutRejectedSignIns(null, rejectedSignInsAt(authA)), MODELS), [
        'anthropic/claude',
        'groq/llama'
      ])
      // Another agent dir's sign-in is its own: the mark in a never hides b's models.
      assert.deepEqual([...rejectedSignInsAt(authB)], [])
      assert.equal(withoutRejectedSignIns(null, rejectedSignInsAt(authB)), null)
      // A new sign-in replaces the credential: the next read sees the file changed.
      writeFileSync(authA, JSON.stringify({ openai: oauth({ access: 'new-access-token-0003' }) }))
      assert.deepEqual([...rejectedSignInsAt(authA)], [])
      writeFileSync(authB, JSON.stringify({ openai: oauth({ refreshRejectedAt: REJECTED_AT }) }))
      assert.deepEqual([...rejectedSignInsAt(authB)], ['openai'])
    })
  }
)

await check('refused sign-in: a missing, unreadable or malformed auth.json hides nothing', () => {
  withAgentDirs(({ a, b }) => {
    const auth = join(a, 'auth.json')
    assert.equal(rejectedSignInsAt(auth).size, 0, 'missing')
    mkdirSync(join(b, 'auth.json'))
    assert.equal(rejectedSignInsAt(join(b, 'auth.json')).size, 0, 'not a file')
    writeFileSync(auth, JSON.stringify({ openai: oauth({ refreshRejectedAt: REJECTED_AT }) }))
    assert.equal(rejectedSignInsAt(auth).size, 1)
    // Mid-write or hand-broken: nothing is hidden, not even what the last read found.
    writeFileSync(auth, '{"openai": {"type": "oauth", "refreshRejectedAt": 17')
    assert.equal(rejectedSignInsAt(auth).size, 0, 'malformed')
    writeFileSync(auth, '[]')
    assert.equal(rejectedSignInsAt(auth).size, 0, 'not an object')
    assert.equal(withoutRejectedSignIns(null, rejectedSignInsAt(auth)), null)
    const marked = JSON.stringify({ anthropic: oauth({ refreshRejectedAt: REJECTED_AT }) })
    writeFileSync(auth, `\uFEFF${marked}`)
    assert.deepEqual([...rejectedSignInsAt(auth)], ['anthropic'], 'a byte order mark is no error')
  })
})

await check('refused sign-in: the marks combine with the ChatGPT account’s models', () => {
  const account = (model: { provider: string; id: string }) =>
    model.provider !== 'openai' || model.id === 'gpt-a'
  assert.equal(
    withoutRejectedSignIns(account, new Set()),
    account,
    'no marks: the account filter alone'
  )
  assert.deepEqual(kept(withoutRejectedSignIns(account, new Set(['anthropic'])), MODELS), [
    'openai/gpt-a',
    'groq/llama'
  ])
  assert.deepEqual(kept(withoutRejectedSignIns(account, new Set(['openai'])), MODELS), [
    'anthropic/claude',
    'groq/llama'
  ])
})

function cycled(key: string): RpcSuccessResponse<'cycle_model'> {
  const { provider, id } = ref(key)
  const model: Model = {
    provider,
    id,
    name: id,
    api: 'openai-responses',
    baseUrl: 'http://127.0.0.1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000
  }
  return {
    type: 'response',
    command: 'cycle_model',
    success: true,
    data: { model, thinkingLevel: 'off', isScoped: false }
  }
}

/** An Engine whose forward cycle walks `ring` after `first`; records each cycle_model it is sent. */
function cycleEngine(ring: string[]) {
  const sent: RpcCommand[] = []
  let at = 0
  const send = async (command: RpcCommand): Promise<RpcResponse> => {
    sent.push(command)
    at = (at + 1) % ring.length
    return cycled(ring[at]!)
  }
  return { sent, send, first: cycled(ring[0]!) }
}

const landedOn = (response: RpcResponse) =>
  response.success && response.command === 'cycle_model' && response.data
    ? `${response.data.model.provider}/${response.data.model.id}`
    : null

await check('refused sign-in: the model cycle steps over hidden models', async () => {
  const offered = withoutRejectedSignIns(
    (model) => model.provider !== 'openai' || model.id === 'gpt-a',
    new Set(['anthropic'])
  )
  assert.ok(offered)
  const engine = cycleEngine(['anthropic/claude', 'openai/gpt-b', 'groq/llama', 'openai/gpt-a'])
  assert.equal(landedOn(await cycleToOffered(engine.send, engine.first, offered)), 'groq/llama')
  assert.equal(engine.sent.length, 2)
  assert.ok(engine.sent.every((command) => command.type === 'cycle_model'))
  // An offered landing is kept as it is.
  const direct = cycleEngine(['groq/llama', 'anthropic/claude'])
  assert.equal(landedOn(await cycleToOffered(direct.send, direct.first, offered)), 'groq/llama')
  assert.equal(direct.sent.length, 0)
  // Every model hidden: the cycle comes back to where it started and stops there.
  const hidden = cycleEngine(['anthropic/claude', 'anthropic/haiku'])
  assert.equal(
    landedOn(await cycleToOffered(hidden.send, hidden.first, offered)),
    'anthropic/claude'
  )
  assert.equal(hidden.sent.length, 2)
  // A cycle the Engine refuses ends on the last model it reached.
  const refused = cycleEngine(['anthropic/claude', 'openai/gpt-b'])
  const send = async (command: RpcCommand): Promise<RpcResponse> =>
    refused.sent.length === 0
      ? refused.send(command)
      : { type: 'response', command: 'cycle_model', success: false, error: 'No models' }
  assert.equal(landedOn(await cycleToOffered(send, refused.first, offered)), 'openai/gpt-b')
})
