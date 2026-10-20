// A sign-in whose refresh token the provider rejects (RFC 6749 `invalid_grant`), end to end with the real
// Engine and app: the Engine's built-in Kimi Code OAuth flow refreshes against a local token endpoint
// (`KIMI_CODE_OAUTH_HOST`) that answers 400 `{"error":"invalid_grant"}`, the shape of the provider error
// behind "Auto-title failed: OAuth refresh failed for openai". A fixture extension picks a title model the
// way session auto-title packages do (fixtures/qa-title-probe.ts).
//   - the first use marks `refreshRejectedAt` in the temp auth.json and keeps every other field;
//   - get_available_models and the extension's model choice leave the provider out, so the next title
//     comes from the working QA provider;
//   - later requests for the provider fail at once, without another token request;
//   - a second open conversation, which never used the sign-in, stops listing the provider without a
//     restart: in its model list, in its extensions' model choice and for RPC set_model;
//   - Settings → Providers shows Sign-in expired, and Sign in again (the real device-code flow against
//     the local auth server) replaces the credential, which clears the mark.
// Kimi's model requests are routed to the fake LLM; nothing leaves 127.0.0.1. The app runs with a temp HOME
// and USERPROFILE. The real ~/.pi and ~/.prime account folders are only fingerprinted (auth.json only
// stat()ed) to prove they stayed untouched.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { launchApp } from '../lib/app.mjs'
import { inspectRequest, startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { snapshotRealConfig } from '../lib/real-guard.mjs'
import { tempRoot } from '../lib/tmp.mjs'
import {
  engineModelKeys,
  LAUNCH,
  openAnotherWorkspace,
  openSettings,
  providerRow,
  readTempAuth,
  routeProviderToFake,
  stubMainNetwork,
  visibleComposer,
  waitUntil
} from './helpers.mjs'

const SUITE_NAME = 'auth-refused-sign-in'
const PROVIDER = 'kimi-coding'
const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'qa-title-probe.ts')
/** Fake Kimi Code sign-ins (never real secrets): the stored one expired an hour ago. */
const DEAD_SIGN_IN = {
  type: 'oauth',
  access: 'qa-kimi-dead-access',
  refresh: 'qa-kimi-dead-refresh',
  expires: Date.now() - 3_600_000,
  accountId: 'qa-kimi-account'
}
const NEW_SIGN_IN = { access: 'qa-kimi-new-access', refresh: 'qa-kimi-new-refresh' }
const DEVICE = { device_code: 'qa-kimi-device', user_code: 'QAKI-2026' }
const REJECTION = 'QA refresh token revoked'
/** What the Engine reports for a refusal it just recorded, and for every later request. */
const FIRST_FAILURE = `Sign-in for ${PROVIDER} expired: the provider rejected its refresh token (Kimi Code token refresh unauthorized (status 400): ${REJECTION}). Sign in again.`
const LATER_FAILURE = `Sign-in for ${PROVIDER} expired: the provider rejected its refresh token. Sign in again.`
/** What RPC set_model reports for the provider while the Engine still lists it. */
const SELECT_FAILURE = `set_model: Sign-in for ${PROVIDER} expired: the provider rejected its refresh token. Run '/login ${PROVIDER}' to sign in again.`
/** A request that fails at once has no network round trip to wait for. */
const FAIL_FAST_MS = 1_000

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

/**
 * Kimi Code's OAuth host on 127.0.0.1: a refresh grant is refused with `invalid_grant` (HTTP 400); the
 * device-code sign-in issues `NEW_SIGN_IN`. Every token request is recorded.
 */
async function startKimiAuth() {
  const tokenRequests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const form = new URLSearchParams(body)
    const reply = (status, json) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(json))
    }
    if (request.method === 'POST' && request.url === '/api/oauth/device_authorization') {
      reply(200, {
        ...DEVICE,
        verification_uri: `${url}/device`,
        verification_uri_complete: `${url}/device?user_code=${DEVICE.user_code}`,
        interval: 1,
        expires_in: 120
      })
      return
    }
    if (request.method === 'POST' && request.url === '/api/oauth/token') {
      const grant = form.get('grant_type')
      tokenRequests.push({ grant, refreshToken: form.get('refresh_token') })
      if (grant === 'refresh_token') {
        reply(400, { error: 'invalid_grant', error_description: REJECTION })
        return
      }
      if (form.get('device_code') === DEVICE.device_code) {
        reply(200, {
          access_token: NEW_SIGN_IN.access,
          refresh_token: NEW_SIGN_IN.refresh,
          expires_in: 3600
        })
        return
      }
    }
    reply(404, { error: 'not_found' })
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    refreshes: () => tokenRequests.filter((entry) => entry.grant === 'refresh_token'),
    tokenRequests: () => [...tokenRequests],
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  }
}

/** The fixture extension's title attempts so far. */
async function titleAttempts(agentDir) {
  const text = await readFile(agentDir.path('qa-title-log.jsonl'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Run `/qa-title [model]` in the visible session and return its attempt. */
async function titleAttempt(app, agentDir, args = '') {
  const before = (await titleAttempts(agentDir)).length
  const composer = visibleComposer(app.page)
  await composer.fill(`/qa-title${args ? ` ${args}` : ''}`)
  await composer.press('Enter')
  const attempts = await waitUntil(
    async () => {
      const all = await titleAttempts(agentDir)
      return all.length > before && all
    },
    { timeoutMs: 30_000, label: 'the title attempt' }
  )
  return attempts[before]
}

/** Run `/qa-title` in an open session that is not on screen and return its attempt. */
async function titleAttemptIn(app, agentDir, agentId) {
  const before = (await titleAttempts(agentDir)).length
  await app.rpc({ type: 'prompt', message: '/qa-title' }, agentId)
  const attempts = await waitUntil(
    async () => {
      const all = await titleAttempts(agentDir)
      return all.length > before && all
    },
    { timeoutMs: 30_000, label: 'the title attempt' }
  )
  return attempts[before]
}

const isProvider = (modelKey) => modelKey.startsWith(`${PROVIDER}/`)

console.log(`▶ ${SUITE_NAME} (fake)`)
const started = performance.now()
const failures = []
const kimiAuth = await startKimiAuth()
const server = await startFakeLlm()
const agentDir = await createAgentDir({
  server,
  files: {
    'auth.json': { [PROVIDER]: DEAD_SIGN_IN },
    'extensions/qa-title-probe.ts': await readFile(PROBE, 'utf8')
  }
})
await routeProviderToFake(agentDir, server, PROVIDER)
const realAccounts = await Promise.all(
  ['.pi', '.prime'].map((folder) => snapshotRealConfig(join(homedir(), folder, 'agent')))
)
// Fake mode gives the app a temp HOME; on Windows its profile paths follow USERPROFILE, so that is temp too.
const profile = await tempRoot('vengeance-qa-refused-home-')
const home = await profile.folder('home')
let app = null

try {
  app = await launchApp({
    ...LAUNCH,
    agentDir: agentDir.dir,
    env: {
      KIMI_CODE_OAUTH_HOST: kimiAuth.url,
      KIMI_OAUTH_HOST: undefined,
      KIMI_API_KEY: undefined,
      HOME: home,
      USERPROFILE: home
    }
  })
  const page = app.page
  let firstSession
  let otherSession
  let otherPid
  let kimiModels

  await step('before any use, both open conversations list the dead sign-in’s models', async () => {
    // The other conversation opens first, so the first one is on screen and finds out the refusal.
    otherSession = (await app.openWorkspace()).agentId
    firstSession = await openAnotherWorkspace(app)
    kimiModels = (await engineModelKeys(app, firstSession)).filter(isProvider)
    assert.ok(kimiModels.length > 0, 'the Engine offers the signed-in provider')
    assert.deepEqual((await engineModelKeys(app, otherSession)).filter(isProvider), kimiModels)
    assert.ok((await app.agentState()).commands.some((command) => command.name === 'qa-title'))
    otherPid = (await app.agentState(otherSession)).info.pid
    assert.ok(otherPid, 'the other conversation’s Engine runs')
    assert.deepEqual(kimiAuth.tokenRequests(), [], 'starting refreshes nothing')
  })

  await step(
    'first use: the title model is the dead sign-in; its refusal marks the credential',
    async () => {
      const markedAfter = Date.now()
      const attempt = await titleAttempt(app, agentDir)
      assert.ok(isProvider(attempt.model), `picked ${attempt.model}`)
      assert.equal(attempt.ok, false)
      assert.equal(attempt.error, FIRST_FAILURE)
      assert.deepEqual(kimiAuth.refreshes(), [
        { grant: 'refresh_token', refreshToken: DEAD_SIGN_IN.refresh }
      ])
      const { refreshRejectedAt, ...kept } = (await readTempAuth(agentDir))[PROVIDER]
      assert.deepEqual(kept, DEAD_SIGN_IN, 'every other field is kept')
      assert.ok(refreshRejectedAt >= markedAfter && refreshRejectedAt <= Date.now())
      assert.equal(server.requests.length, 0, 'no model request was made')
    }
  )

  await step('get_available_models leaves the provider out; the QA models stay', async () => {
    const keys = await engineModelKeys(app, firstSession)
    assert.deepEqual(keys.filter(isProvider), [])
    assert.ok(keys.includes('qa/qa-reasoning'))
  })

  await step(
    'the next title comes from the working provider, without a token request',
    async () => {
      server.queue(turn.text('Refused sign-in title'))
      const attempt = await titleAttempt(app, agentDir)
      assert.ok(attempt.model.startsWith('qa/'), `picked ${attempt.model}`)
      assert.deepEqual(attempt.available.filter(isProvider), [])
      assert.equal(attempt.ok, true, attempt.error)
      assert.equal(attempt.title, 'Refused sign-in title')
      assert.equal(server.requests.length, 1)
      assert.equal(kimiAuth.refreshes().length, 1)
    }
  )

  await step('requests for the expired sign-in fail at once, without a token request', async () => {
    const attempt = await titleAttempt(app, agentDir, kimiModels[0])
    assert.equal(attempt.ok, false)
    assert.equal(attempt.error, LATER_FAILURE)
    assert.ok(attempt.ms < FAIL_FAST_MS, `failed after ${attempt.ms} ms`)
    // RPC set_model only accepts available models.
    const [provider, ...id] = kimiModels[0].split('/')
    await assert.rejects(
      app.rpc({ type: 'set_model', provider, modelId: id.join('/') }, firstSession),
      new RegExp(`Model not found: ${kimiModels[0]}`)
    )
    assert.equal(kimiAuth.refreshes().length, 1)
    assert.equal(server.requests.length, 1)
  })

  await step(
    'the other open conversation stops offering the provider too, without a restart',
    async () => {
      const keys = await engineModelKeys(app, otherSession)
      assert.deepEqual(keys.filter(isProvider), [], 'its model list leaves the provider out')
      assert.ok(keys.includes('qa/qa-reasoning'))
      // Until its bridge re-reads the sign-ins, its Engine still lists the provider, and set_model names the
      // expired sign-in without changing that list. Only the re-read makes it answer "Model not found". A
      // request for the provider would drop it from the list by itself, so none is made before the re-read.
      const [provider, ...id] = kimiModels[0].split('/')
      await waitUntil(
        async () => {
          try {
            await app.rpc({ type: 'set_model', provider, modelId: id.join('/') }, otherSession)
          } catch (error) {
            if (error.message === `set_model: Model not found: ${kimiModels[0]}`) return true
            assert.equal(error.message, SELECT_FAILURE)
            return false
          }
          assert.fail('set_model chose the expired sign-in')
        },
        { timeoutMs: 15_000, label: 'the other conversation’s bridge to re-read the sign-ins' }
      )
      // Its extensions read that registry: the first title attempt already leaves the provider out.
      server.queue(turn.text('Other conversation title'))
      const attempt = await titleAttemptIn(app, agentDir, otherSession)
      assert.deepEqual(attempt.available.filter(isProvider), [])
      assert.ok(attempt.model.startsWith('qa/'), `picked ${attempt.model}`)
      assert.equal(attempt.ok, true, attempt.error)
      assert.equal(attempt.title, 'Other conversation title')
      assert.equal((await app.agentState(otherSession)).info.pid, otherPid, 'never restarted')
      assert.equal(await page.getByText('Restart to apply').count(), 0)
      assert.equal(server.requests.length, 2)
      assert.equal(kimiAuth.refreshes().length, 1)
    }
  )

  await step('Settings → Providers: Sign-in expired, Sign in again, no restart offer', async () => {
    await openSettings(app, 'providers', 'Providers & accounts')
    const row = providerRow(page, PROVIDER)
    await row.getByText('Sign-in expired', { exact: true }).waitFor()
    await row.getByRole('button', { name: 'Sign in again', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: 'Reconnect', exact: true }).count(), 0)
    assert.equal(await page.getByText('Restart to apply').count(), 0)
    await row.scrollIntoViewIfNeeded()
    await app.screenshot('refused-sign-in-01-expired', { settleMs: 600 })
  })

  await step('Sign in again: a new device-code sign-in replaces the credential', async () => {
    const network = await stubMainNetwork(app)
    const row = providerRow(page, PROVIDER)
    await row.getByRole('button', { name: 'Sign in again', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /^Sign in to / })
    await dialog.getByText(DEVICE.user_code, { exact: true }).waitFor()
    await app.screenshot('refused-sign-in-02-device-code', { settleMs: 300 })
    const credential = await waitUntil(
      async () => {
        const stored = (await readTempAuth(agentDir))?.[PROVIDER]
        return stored?.access === NEW_SIGN_IN.access && stored
      },
      { timeoutMs: 30_000, label: 'the new sign-in in auth.json' }
    )
    assert.equal(credential.refresh, NEW_SIGN_IN.refresh)
    assert.equal('refreshRejectedAt' in credential, false, 'the mark is gone')
    await row.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(await row.getByText('Sign-in expired', { exact: true }).count(), 0)
    // Open sessions dropped the provider; they list it again after a restart.
    await page.getByText('Restart to apply').waitFor()
    assert.equal(kimiAuth.refreshes().length, 1)
    assert.ok((await network.opened()).every((opened) => opened.startsWith(kimiAuth.url)))
    // A finished sign-in closes its dialog by itself.
    await dialog.waitFor({ state: 'detached' })
    await row.scrollIntoViewIfNeeded()
    await app.screenshot('refused-sign-in-03-signed-in-again', { settleMs: 600 })
  })

  await step('a new session lists the provider again and uses the new sign-in', async () => {
    await app.test('closeSettings')
    const session = await openAnotherWorkspace(app)
    assert.ok((await engineModelKeys(app, session)).includes(kimiModels[0]))
    server.queue(turn.text('Kimi title'))
    const from = server.requests.length
    const attempt = await titleAttempt(app, agentDir, kimiModels[0])
    assert.equal(attempt.ok, true, attempt.error)
    assert.equal(attempt.title, 'Kimi title')
    const request = server.requests[from]
    assert.equal(inspectRequest(request).model, kimiModels[0].slice(PROVIDER.length + 1))
    assert.equal(request.headers.authorization, `Bearer ${NEW_SIGN_IN.access}`)
    assert.equal(kimiAuth.refreshes().length, 1, 'one token request for the refused refresh')
  })

  app.assertNoErrors()
} catch (error) {
  failures.push(error)
  await app?.screenshot(`${SUITE_NAME}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await app?.close().catch((error) => failures.push(error))
  await server.close().catch((error) => failures.push(error))
  await kimiAuth.close().catch((error) => failures.push(error))
  await agentDir.cleanup().catch((error) => failures.push(error))
  await profile.cleanup().catch((error) => failures.push(error))
  for (const account of realAccounts) {
    await account.verify().catch((error) => failures.push(error))
  }
}

const seconds = ((performance.now() - started) / 1000).toFixed(1)
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE_NAME} failed (${seconds}s)`)
  process.exitCode = 1
} else {
  console.log('  ✓ both real account configurations remained unchanged')
  console.log(`✓ ${SUITE_NAME} passed (${seconds}s)`)
}
