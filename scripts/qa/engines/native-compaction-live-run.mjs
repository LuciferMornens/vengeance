// Run explicitly. JSON configuration arrives on stdin so secrets never become command arguments.
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from '../lib/app.mjs'
import { snapshotRealConfig } from '../lib/real-guard.mjs'
import { runLiveCompaction } from '../lib/native-compaction-live.mjs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const configuration = JSON.parse(Buffer.concat(chunks).toString())
assert.ok(['pi', 'prime'].includes(configuration.engine))
const guards = await Promise.all(
  ['.pi', '.prime'].map((name) => snapshotRealConfig(join(homedir(), name, 'agent')))
)
try {
  let credentials = { apiKey: configuration.apiKey }
  if (configuration.subscription) {
    const credentialEngine = configuration.credentialEngine ?? configuration.engine
    assert.ok(['pi', 'prime'].includes(credentialEngine))
    const packageRoot = join(
      ROOT,
      '.engine-staging/bundled/pi/node_modules/@earendil-works/pi-coding-agent/dist/core'
    )
    const { ReadOnlyAuthStorage } = await import(
      pathToFileURL(join(packageRoot, 'auth-storage.js'))
    )
    const { ModelRuntime } = await import(pathToFileURL(join(packageRoot, 'model-runtime.js')))
    // The native auth API resolves an existing, unexpired credential. This store cannot refresh,
    // modify or delete it. No credential file is opened, copied or serialized by the test.
    const runtime = await ModelRuntime.create({
      credentials: new ReadOnlyAuthStorage(
        join(homedir(), credentialEngine === 'prime' ? '.prime' : '.pi', 'agent', 'auth.json')
      ),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false
    })
    const provider =
      configuration.engine === 'prime' || configuration.subscription === 'codex'
        ? 'openai-codex'
        : 'openai'
    assert.equal(
      (await runtime.checkAuth(provider))?.type,
      'oauth',
      'An existing subscription login is required'
    )
    const resolved = await runtime.getAuth(provider, { minOAuthValidityMs: 0 })
    assert.ok(
      resolved?.auth.apiKey,
      'Read-only subscription access unavailable; refresh is deliberately disabled'
    )
    const headers = { ...resolved.auth.headers }
    if (provider === 'openai-codex') {
      const claims = JSON.parse(
        Buffer.from(resolved.auth.apiKey.split('.')[1], 'base64url').toString()
      )
      headers['chatgpt-account-id'] = claims['https://api.openai.com/auth'].chatgpt_account_id
    }
    credentials = {
      apiKey: resolved.auth.apiKey,
      headers,
      subscription: configuration.subscription,
      endpoint:
        provider === 'openai'
          ? 'https://api.openai.com/v1/responses'
          : 'https://chatgpt.com/backend-api/codex/responses'
    }
  }
  const result = configuration.prepareOnly
    ? { engine: configuration.engine, subscription: configuration.subscription, available: true }
    : await runLiveCompaction(configuration.engine, credentials)
  console.log(JSON.stringify(result, null, 2))
} finally {
  for (const guard of guards) {
    assert.equal(
      (await guard.verify()).authChanged,
      false,
      'Real account credentials stayed unchanged'
    )
  }
}
