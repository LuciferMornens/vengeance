import { strict as assert } from 'node:assert'
import { agentDirArea, areaOf, authSignature, isCredentialFile } from '../../src/main/features/settings/config-areas'
import { check } from './harness'

const split = (path: string) => path.split('/')

await check('config areas (N1): engine-written credential files never count as config changes', () => {
  assert.equal(agentDirArea(['mcp-auth.json']), null)
  for (const name of ['mcp-auth.json', 'oauth-tokens.json', 'github-copilot-token.json', 'token.json', 'credentials.json', 'mcp-auth.json.4821.tmp']) {
    assert.equal(isCredentialFile(name), true, name)
  }
  assert.equal(areaOf(split('extensions/my-ext/token.json')), null)
  assert.equal(areaOf(split('extensions/my-ext/.cache/oauth.json')), null)
  assert.equal(areaOf(split('mcp-auth.json')), null)
})

await check('config areas: real config still maps to its area', () => {
  assert.equal(agentDirArea(['auth.json']), 'auth')
  assert.equal(agentDirArea(['models.json']), 'models')
  assert.equal(agentDirArea(['settings.json']), 'settings')
  assert.equal(agentDirArea(['mcp.json']), 'mcp')
  assert.equal(agentDirArea(['trust.json']), 'trust')
  assert.equal(agentDirArea(['AGENTS.md']), 'instructions')
  assert.equal(areaOf(split('extensions/my-ext/index.ts')), 'resources')
  // Source files that merely mention auth are code, not token stores.
  assert.equal(areaOf(split('extensions/my-ext/auth.ts')), 'resources')
  assert.equal(areaOf(split('npm/package.json')), 'packages')
  assert.equal(areaOf(split('git/github.com/u/repo/index.ts')), 'packages')
})

await check('authSignature (N1): token refreshes keep the signature, sign-in/out changes it', () => {
  const before = authSignature(JSON.stringify({ anthropic: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 }, openai: { type: 'api_key', key: 'k' } }))
  const refreshed = authSignature(JSON.stringify({ openai: { type: 'api_key', key: 'k' }, anthropic: { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2 } }))
  const signedIn = authSignature(JSON.stringify({ anthropic: { type: 'oauth', access: 'a2' }, openai: { type: 'api_key', key: 'k' }, google: { type: 'oauth' } }))
  const signedOut = authSignature(JSON.stringify({ openai: { type: 'api_key', key: 'k' } }))
  assert.notEqual(before, null)
  assert.equal(refreshed, before)
  assert.notEqual(signedIn, before)
  assert.notEqual(signedOut, before)
  assert.equal(authSignature('{"half": '), null)
  assert.equal(authSignature(null), null)
})
