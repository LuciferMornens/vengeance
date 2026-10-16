import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { createEngineFixture, storeApiKey } from '../engines/integration-fixture.mjs'
import { providerRow, stubMainNetwork, waitUntil } from './helpers.mjs'

const SUITE_NAME = 'auth-subscription-access'
const SAVED_KEY = 'qa-anthropic-key-not-real'
const FLOW_TIMEOUT_MS = 15_000
const AUTH_EVENT_BINDING = 'observeSubscriptionAuth'

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

async function chooseEngine(application, label) {
  await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
  await application.page.getByRole('option', { name: label, exact: true }).click()
}

async function observeAuth(application) {
  const events = []
  await application.page.exposeFunction(AUTH_EVENT_BINDING, (event) => events.push(event))
  await application.page.evaluate((binding) => {
    window.vengeance.on('settings:auth-event', (event) => window[binding](event))
  }, AUTH_EVENT_BINDING)
  return events
}

async function waitForCancellation(events, loginId) {
  const completion = await waitUntil(
    () => events.find((event) => event.loginId === loginId && event.kind === 'done'),
    { label: 'native sign-in cancellation', timeoutMs: FLOW_TIMEOUT_MS }
  )
  assert.equal(completion.ok, false)
  assert.equal(completion.cancelled, true)
  assert.equal(completion.error, undefined)
}

async function browserLogin(application, events, providerId, dialogName) {
  const eventStart = events.length
  await providerRow(application.page, providerId)
    .getByRole('button', { name: 'Sign in', exact: true })
    .click()
  const dialog = application.page.getByRole('dialog', { name: dialogName, exact: true })
  await dialog.getByText('Your browser opened the sign-in page').waitFor()
  const notice = await waitUntil(
    () =>
      events
        .slice(eventStart)
        .find((event) => event.kind === 'notice' && event.notice.type === 'auth_url'),
    { label: 'the native authorization URL', timeoutMs: FLOW_TIMEOUT_MS }
  )
  assert.equal(notice.engine, 'prime')
  assert.match(notice.loginId, /^prime-oauth-/)
  const authorizationUrl = new URL(notice.notice.url)
  assert.equal(authorizationUrl.protocol, 'https:')
  assert.ok(authorizationUrl.searchParams.get('code_challenge'))
  return { dialog, loginId: notice.loginId, authorizationUrl }
}

console.log(`▶ ${SUITE_NAME} (isolated native sign-in, no credentials submitted)`)
const fixture = await createEngineFixture()
let application
let failure

try {
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('subscription-access')
  })
  const network = await stubMainNetwork(application)
  const events = await observeAuth(application)
  await application.openWorkspace({ args: { engine: 'pi', name: 'Subscription access QA' } })

  await step('saved API keys expose both subscription sign-in and key actions', async () => {
    for (const engine of ['pi', 'prime']) {
      await storeApiKey(application, engine, 'anthropic', SAVED_KEY)
    }
    await application.test('openSettings', 'providers')
    const row = providerRow(application.page, 'anthropic')
    for (const label of ['Engine', 'Engine 2']) {
      await chooseEngine(application, label)
      await row.getByRole('button', { name: 'Replace key', exact: true }).waitFor()
      await row.getByRole('button', { name: 'Remove key', exact: true }).waitFor()
      await row.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
      assert.equal(await row.getByRole('button', { name: 'Reconnect', exact: true }).count(), 0)
    }
    await application.screenshot('subscription-anthropic-key-and-signin')
  })

  const authPath = join(fixture.primeDirectory, 'auth.json')
  const authBefore = await readFile(authPath, 'utf8')
  const piAuthBefore = await fixture.piDirectory.readText('auth.json')

  await step(
    'Anthropic subscription sign-in starts its native helper and cancels safely',
    async () => {
      const { dialog, loginId } = await browserLogin(
        application,
        events,
        'anthropic',
        'Sign in to Anthropic'
      )
      await application.screenshot('subscription-anthropic-native-browser')
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await waitForCancellation(events, loginId)
      assert.equal(await readFile(authPath, 'utf8'), authBefore)
      assert.equal(await fixture.piDirectory.readText('auth.json'), piAuthBefore)
    }
  )

  await step(
    'ChatGPT Codex is discoverable and starts native OpenAI subscription sign-in',
    async () => {
      const subscription = providerRow(application.page, 'openai-codex')
      await subscription.getByText('ChatGPT · Codex', { exact: true }).waitFor()
      assert.equal(await subscription.getByText(/legacy/i).count(), 0)
      const { dialog, loginId, authorizationUrl } = await browserLogin(
        application,
        events,
        'openai-codex',
        'Sign in to ChatGPT · Codex'
      )
      assert.equal(authorizationUrl.hostname, 'auth.openai.com')
      assert.ok((await network.opened()).includes(authorizationUrl.href))
      await application.screenshot('subscription-chatgpt-native-browser')
      await application.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      await waitForCancellation(events, loginId)
      assert.equal(await readFile(authPath, 'utf8'), authBefore)
    }
  )

  await step(
    'an externally opened workspace unmounts and cancels the old native sign-in',
    async () => {
      const { dialog, loginId } = await browserLogin(
        application,
        events,
        'anthropic',
        'Sign in to Anthropic'
      )
      const workspace = await application.createWorkspace()
      await application.test('openWorkspace', workspace, {
        engine: 'pi',
        name: 'Second auth scope'
      })
      await dialog.waitFor({ state: 'detached' })
      await waitForCancellation(events, loginId)
      await application.page
        .getByRole('combobox', { name: 'Settings engine' })
        .getByText('Engine', { exact: true })
        .waitFor()
      assert.equal(await readFile(authPath, 'utf8'), authBefore)
      assert.equal(await fixture.piDirectory.readText('auth.json'), piAuthBefore)
      assert.equal(await application.page.getByText('Sign-in failed', { exact: true }).count(), 0)
      await application.screenshot('subscription-workspace-cancelled')
    }
  )

  assert.equal(fixture.piServer.requests.length, 0)
  assert.equal(fixture.primeServer.requests.length, 0)
  application.assertNoErrors()
} catch (error) {
  failure = error
  await application?.screenshot(`${SUITE_NAME}-FAILED`, { settleMs: 0 }).catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
}

if (failure) {
  console.error(`  ✗ ${failure.stack ?? failure}`)
  console.error(`✗ ${SUITE_NAME} failed`)
  process.exitCode = 1
} else {
  console.log(`✓ ${SUITE_NAME} passed`)
}
