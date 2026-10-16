import assert from 'node:assert/strict'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const SUITE_NAME = 'engine2-side-questions'
const PRIMARY_NAME = 'Engine2 side question owner'
const PEER_NAME = 'Engine2 foreground peer'
const BACKGROUND_ANSWER =
  'This native side answer finished while its session was in the background.'
const FOLLOW_UP_ANSWER = 'This follow-up kept the completed side conversation.'
const STREAM_DELAY_MS = 75
const WAIT_TIMEOUT_MS = 60_000

async function activateSession(application, name) {
  await application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: name })
    .click()
  await application.composer()
}

async function openSideQuestion(application) {
  await application.page.getByRole('button', { name: 'Controls', exact: true }).click()
  await application.page.getByRole('tab', { name: 'Side question', exact: true }).click()
  return application.page.getByRole('dialog', { name: 'Engine 2 session controls' })
}

async function askSideQuestion(dialog, question) {
  await dialog.getByRole('textbox', { name: 'Side question' }).fill(question)
  await dialog.getByRole('button', { name: 'Ask side question', exact: true }).click()
}

console.log(`▶ ${SUITE_NAME} (native Engine2 and a local fake provider)`)
const fixture = await createEngineFixture()
let application
let failure

try {
  const workspace = await fixture.root.folder('workspace')
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('engines')
  })
  const primary = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: PRIMARY_NAME
    }
  })
  const peer = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: PEER_NAME,
      noSession: true
    }
  })
  await activateSession(application, PRIMARY_NAME)
  const before = await application.rpc({ type: 'get_messages' }, primary.agentId)
  const firstRequestIndex = fixture.primeServer.requests.length
  fixture.primeServer.queue(
    turn.text(BACKGROUND_ANSWER, { chunkSize: 1, delayMs: STREAM_DELAY_MS })
  )
  let dialog = await openSideQuestion(application)
  await askSideQuestion(dialog, 'Explain the side-question decision briefly')
  const backgroundRequest = await fixture.primeServer.waitForRequest(undefined, {
    from: firstRequestIndex
  })
  await application.page.keyboard.press('Escape')
  await activateSession(application, PEER_NAME)
  assert.equal(await application.activeAgentId(), peer.agentId)
  assert.equal(backgroundRequest.outcome, 'streaming', 'switch before the side answer finishes')
  assert.equal(await fixture.primeServer.waitForOutcome(backgroundRequest), 'completed')
  assert.equal(await application.activeAgentId(), peer.agentId)

  await activateSession(application, PRIMARY_NAME)
  dialog = await openSideQuestion(application)
  await dialog.getByText(BACKGROUND_ANSWER, { exact: true }).waitFor({ timeout: WAIT_TIMEOUT_MS })
  await dialog.getByText('complete', { exact: true }).waitFor({ timeout: WAIT_TIMEOUT_MS })
  assert.equal(await dialog.getByRole('textbox', { name: 'Side question' }).isEnabled(), true)
  await application.screenshot('engine2-side-question-background-complete')
  console.log('  ✓ side answer completed in the background and returned with usable controls')

  const followUpRequestIndex = fixture.primeServer.requests.length
  fixture.primeServer.queue(turn.text(FOLLOW_UP_ANSWER, { chunkSize: 1, delayMs: STREAM_DELAY_MS }))
  await dialog.getByRole('textbox', { name: 'Side question' }).fill('Explain the alternative')
  assert.equal(
    await dialog.getByRole('button', { name: 'Ask side question', exact: true }).isEnabled(),
    true
  )
  await dialog.getByRole('button', { name: 'Ask side question', exact: true }).click()
  const followUpRequest = await fixture.primeServer.waitForRequest(undefined, {
    from: followUpRequestIndex
  })
  assert.ok(
    JSON.stringify(followUpRequest.body).includes(BACKGROUND_ANSWER),
    'the native follow-up receives its completed side conversation'
  )
  await application.page.keyboard.press('Escape')
  assert.equal(followUpRequest.outcome, 'streaming', 'close the panel during the follow-up')
  assert.equal(await fixture.primeServer.waitForOutcome(followUpRequest), 'completed')
  dialog = await openSideQuestion(application)
  await dialog.getByText(FOLLOW_UP_ANSWER, { exact: true }).waitFor({ timeout: WAIT_TIMEOUT_MS })
  await dialog.getByText('complete', { exact: true }).waitFor({ timeout: WAIT_TIMEOUT_MS })
  assert.equal(await dialog.getByRole('textbox', { name: 'Side question' }).isEnabled(), true)
  assert.deepEqual(await application.rpc({ type: 'get_messages' }, primary.agentId), before)
  assert.equal(fixture.primeServer.requests.length - firstRequestIndex, 2)
  await application.screenshot('engine2-side-question-panel-reopened')
  await application.page.keyboard.press('Escape')
  application.assertNoErrors()
  console.log('  ✓ panel reopening keeps the follow-up answer and leaves the main history intact')
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
