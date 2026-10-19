import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { TRASH_NAME } from '../lib/platform.mjs'
import { isAlive } from '../lib/processes.mjs'
import { waitFor } from '../settings/settings-ui.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'

const SUITE_NAME = 'engine2-resident-close'
const SESSION_NAME = 'Release follow-up'
const HISTORY_PROMPT = 'Save a short reply for the close-tab check.'
const HISTORY_REPLY = 'This conversation stays saved when its tab closes.'
const SCHEDULE_PROMPT = 'Recheck the release tomorrow.'
const BUSY_PROMPT = 'Keep this reply running while I close the tab.'
const BUSY_REPLY = 'The session keeps working after its tab closes.'
const CLOSE_TOOLTIP = 'Close tab — session keeps running in Background sessions'
const READY_TIMEOUT_MS = 60_000

function openRow(application) {
  return application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: SESSION_NAME })
}

function backgroundSection(application) {
  return application.page.getByRole('region', { name: 'Background sessions' })
}

async function residentDescriptor(application, agentId) {
  const descriptor = (await application.invoke('engine:list')).find(
    (agent) => agent.agentId === agentId
  )
  assert.ok(descriptor?.nativeAgentId, 'the native identity is public')
  assert.ok(descriptor.pid, 'the native worker is public')
  return descriptor
}

async function closeTab(application, agentId) {
  const row = openRow(application)
  await row.hover()
  await row.locator('xpath=..').getByRole('button', { name: 'Close tab', exact: true }).click()
  await waitFor(
    async () =>
      !(await application.invoke('engine:list')).some((agent) => agent.agentId === agentId),
    'closed tab releases its app handle'
  )
  await backgroundSection(application)
    .getByRole('button', { name: `Resume ${SESSION_NAME}`, exact: true })
    .waitFor({ timeout: READY_TIMEOUT_MS })
}

async function resumeTab(application, nativeAgentId) {
  await backgroundSection(application)
    .getByRole('button', { name: `Resume ${SESSION_NAME}`, exact: true })
    .click()
  return waitFor(
    async () => {
      const descriptor = (await application.invoke('engine:list')).find(
        (agent) => agent.nativeAgentId === nativeAgentId && agent.status === 'ready'
      )
      return descriptor?.agentId
    },
    'resident reattaches through its background row',
    READY_TIMEOUT_MS
  )
}

async function stopDialog(application) {
  const section = backgroundSection(application)
  await section.getByRole('button', { name: `Resume ${SESSION_NAME}`, exact: true }).hover()
  await section.getByRole('button', { name: `Stop session ${SESSION_NAME}`, exact: true }).click()
  return application.page.getByRole('dialog', { name: 'Stop this session?', exact: true })
}

console.log(`▶ ${SUITE_NAME} (native Engine 2 and a local fake provider)`)
const fixture = await createEngineFixture()
let application
let failure

try {
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Resident close QA\nOnly isolated files live here.\n'
  })
  application = await launchApp({
    ...packagedLaunchOptions(fixture.environment),
    agentDir: fixture.piDirectory.dir,
    outDir: reportShotsDir('resident-close')
  })
  await recordPackagedTarget(application)
  let { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: SESSION_NAME
    }
  })
  fixture.primeServer.queue(turn.text(HISTORY_REPLY))
  await application.send(HISTORY_PROMPT)
  await application.waitForSettle()
  const before = await residentDescriptor(application, agentId)
  const stateBefore = await application.rpc({ type: 'get_state' }, agentId)
  const messagesBefore = await application.rpc({ type: 'get_messages' }, agentId)
  await application.invoke('prime:command', agentId, 'cron_add', {
    schedule: 'every 1d',
    prompt: SCHEDULE_PROMPT
  })
  const schedulesBefore = await application.invoke('prime:command', agentId, 'cron_list', {})
  assert.ok(schedulesBefore.jobs.some((job) => job.prompt === SCHEDULE_PROMPT))
  const requestsBeforeClose = fixture.primeServer.requests.length
  const closeButton = openRow(application)
    .locator('xpath=..')
    .getByRole('button', { name: 'Close tab', exact: true })
  await openRow(application).hover()
  await closeButton.hover()
  await application.page.getByRole('tooltip').getByText(CLOSE_TOOLTIP, { exact: true }).waitFor()
  await application.screenshot('engine2-close-tab-keeps-running-dark')
  await openRow(application).click({ button: 'right' })
  await application.page
    .getByRole('menuitem', { name: 'Close tab — keep session running', exact: true })
    .waitFor()
  await application.page.keyboard.press('Escape')

  await closeTab(application, agentId)
  const idleResidents = await application.invoke('engine:background-list', 'prime')
  const idleResident = idleResidents.find((resident) => resident.id === before.nativeAgentId)
  assert.ok(idleResident, 'idle residents remain discoverable')
  assert.equal(idleResident.busy, false)
  assert.equal(idleResident.status, 'idle')
  assert.ok(isAlive(before.pid), 'Close tab does not terminate a saved worker')
  assert.equal(fixture.primeServer.requests.length, requestsBeforeClose)
  const backgroundRow = backgroundSection(application).getByRole('button', {
    name: `Resume ${SESSION_NAME}`,
    exact: true
  })
  assert.match(await backgroundRow.innerText(), /Idle/)
  await application.screenshot('engine2-background-session-idle-dark')
  await application.test('setPrefs', { theme: 'light' })
  await application.screenshot('engine2-background-session-idle-bone')
  const keepDialog = await stopDialog(application)
  await keepDialog.getByRole('button', { name: 'Keep running', exact: true }).click()
  assert.ok(
    (await application.invoke('engine:background-list', 'prime')).some(
      (resident) => resident.id === before.nativeAgentId
    ),
    'dismissing Stop keeps the resident'
  )
  console.log(
    '  ✓ idle Close keeps the worker, future schedule and discoverable background session'
  )

  agentId = await resumeTab(application, before.nativeAgentId)
  await application.waitForSettle()
  const resumed = await residentDescriptor(application, agentId)
  assert.equal(resumed.nativeAgentId, before.nativeAgentId)
  assert.equal(resumed.pid, before.pid)
  const stateAfter = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(stateAfter.sessionId, stateBefore.sessionId)
  assert.equal(stateAfter.sessionFile, stateBefore.sessionFile)
  assert.deepEqual(await application.rpc({ type: 'get_messages' }, agentId), messagesBefore)
  assert.deepEqual(
    await application.invoke('prime:command', agentId, 'cron_list', {}),
    schedulesBefore
  )
  await application.page.getByText(HISTORY_REPLY, { exact: true }).waitFor()
  assert.equal(
    await backgroundSection(application).count(),
    0,
    'reattach removes the duplicate row'
  )
  assert.equal(fixture.primeServer.requests.length, requestsBeforeClose)
  console.log('  ✓ background Resume restores the same native identity, history and schedule')

  await application.test('setPrefs', { theme: 'dark' })
  fixture.primeServer.queue(
    turn.hang({
      text: BUSY_REPLY,
      when: (request) => inspectRequest(request).lastUserText === BUSY_PROMPT
    })
  )
  await application.send(BUSY_PROMPT)
  const busyRequest = await fixture.primeServer.waitForRequest(
    (request) => inspectRequest(request).lastUserText === BUSY_PROMPT,
    { from: requestsBeforeClose }
  )
  await waitFor(
    async () => (await application.agentState(agentId)).phase === 'running',
    'resident starts its turn'
  )
  await closeTab(application, agentId)
  assert.equal(busyRequest.outcome, 'streaming', 'Close tab never aborts saved work')
  assert.equal(
    (await application.invoke('engine:background-list', 'prime')).find(
      (resident) => resident.id === before.nativeAgentId
    ).busy,
    true
  )
  await backgroundSection(application)
    .getByText('Working in background', { exact: false })
    .waitFor()
  await application.screenshot('engine2-background-session-working-dark')
  agentId = await resumeTab(application, before.nativeAgentId)
  await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
  assert.equal(await fixture.primeServer.waitForOutcome(busyRequest), 'aborted')
  await application.waitForSettle()
  assert.ok(isAlive(before.pid), 'composer Stop ends the turn, not the resident')
  console.log('  ✓ working Close keeps the request alive; composer Stop ends only its turn')

  await closeTab(application, agentId)
  const confirmation = await stopDialog(application)
  await confirmation.getByText(/saved conversation remains in your history/).waitFor()
  await application.screenshot('engine2-background-session-stop-confirm-dark')
  await confirmation.getByRole('button', { name: 'Stop session', exact: true }).click()
  await waitFor(
    async () =>
      !(await application.invoke('engine:background-list', 'prime')).some(
        (resident) => resident.id === before.nativeAgentId
      ),
    'explicit Stop removes the native resident'
  )
  await waitFor(() => !isAlive(before.pid), 'explicit Stop ends the native worker')
  const history = await application.invoke('sessions:list', { engine: 'prime', cwd: workspace })
  assert.ok(history.sessions.some((session) => session.path === stateBefore.sessionFile))

  const deleting = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: 'Delete resident conversation'
    }
  })
  fixture.primeServer.queue(turn.text('Ready for the deletion check.'))
  await application.send('Reply briefly.')
  await application.waitForSettle()
  const deleteDescriptor = await residentDescriptor(application, deleting.agentId)
  const deleteState = await application.rpc({ type: 'get_state' }, deleting.agentId)
  const deleteRow = application.page
    .locator('section[aria-label="Open sessions"] [data-session-row]', {
      hasText: 'Delete resident conversation'
    })
    .locator('xpath=..')
  await deleteRow.hover()
  await deleteRow.getByRole('button', { name: 'Delete session', exact: true }).click()
  const deleteConfirmation = application.page.getByRole('dialog', {
    name: 'Delete this session?',
    exact: true
  })
  await deleteConfirmation.getByText(/Its running work and schedules will stop/).waitFor()
  await deleteConfirmation
    .getByRole('button', { name: `Move to ${TRASH_NAME}`, exact: true })
    .click()
  await waitFor(() => !existsSync(deleteState.sessionFile), 'Delete removes the saved session')
  await waitFor(() => !isAlive(deleteDescriptor.pid), 'Delete stops the native worker')
  await waitFor(
    async () =>
      !(await application.invoke('engine:list')).some(
        (agent) => agent.agentId === deleting.agentId
      ),
    'Delete closes the app tab after the native operation succeeds'
  )
  assert.ok(
    !(await application.invoke('engine:background-list', 'prime')).some(
      (resident) => resident.id === deleteDescriptor.nativeAgentId
    ),
    'Delete does not move the conversation into Background sessions'
  )
  console.log('  ✓ Delete stops the worker, removes saved history and closes its tab')
  application.assertNoErrors()
  console.log('  ✓ explicit Stop ends the worker and keeps saved conversation history')
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
