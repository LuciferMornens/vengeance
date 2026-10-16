import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { until } from '../chat/helpers.mjs'
import { createEngineFixture } from './integration-fixture.mjs'

const PARENT_NAME = 'Lineage parent'
const CHILD_NAME = 'Lineage reviewer'
const GRANDCHILD_NAME = 'Lineage verifier'
const ROOT_NAME = 'Independent native session'
const FORK_NAME = 'Independent child fork'
const PARENT_TASK = 'Run the isolated lineage delegation probe.'
const CHILD_TASK = 'Review the isolated lineage fixture.'
const GRANDCHILD_TASK = 'Verify the isolated lineage fixture.'
const CREATE_ROOT_TASK = 'Create the isolated independent session.'
const ROOT_TASK = 'Reply for the isolated independent session.'
const CHILD_ANSWER = 'Lineage reviewer completed.'
const KERNEL_TIMEOUT_MS = 120_000
const fixture = await createEngineFixture()
let application
let failure
let missingParent

function samePath(first, second) {
  return (
    first?.replace(/^\\\\\?\\/, '').toLowerCase() === second?.replace(/^\\\\\?\\/, '').toLowerCase()
  )
}

function matchesTask(task) {
  return (request) => inspectRequest(request).lastUserText.includes(task)
}

function native(agentId, command, payload = {}) {
  return application.invoke('prime:command', agentId, command, payload)
}

async function listedSessions(cwd) {
  return (await application.invoke('sessions:list', { engine: 'prime', cwd })).sessions
}

async function familyButton(name) {
  const button = application.page.getByRole('button', { name: `Subagents of ${name}`, exact: true })
  await button.waitFor({ timeout: KERNEL_TIMEOUT_MS })
  if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
}

async function requireSavedFamily(cwd, parentPath, childPath, grandchildPath) {
  return until(
    async () => {
      const saved = await listedSessions(cwd)
      const child = saved.find((entry) => samePath(entry.path, childPath))
      const grandchild = saved.find((entry) => samePath(entry.path, grandchildPath))
      if (!child?.lineage?.childId || !grandchild?.lineage?.childId) return false
      assert.ok(samePath(child.lineage.parentSessionPath, parentPath))
      assert.ok(samePath(grandchild.lineage.parentSessionPath, childPath))
      assert.equal(child.lineage.depth, 1)
      assert.equal(grandchild.lineage.depth, 2)
      return saved
    },
    { label: 'ledger-backed saved family', timeoutMs: KERNEL_TIMEOUT_MS }
  )
}

try {
  application = await launchApp({
    exe: process.env.QA_PACKAGED_EXE,
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('engine2-subagent-lineage')
  })
  const cwd = await fixture.root.folder('lineage-workspace', { 'README.md': '# Lineage QA\n' })
  const parent = await application.openWorkspace({
    cwd,
    args: { engine: 'prime', name: PARENT_NAME }
  })
  await native(parent.agentId, 'set_rlm_max_depth', { maxDepth: 2, global: false })
  await application.send('Reply with exactly: ready')
  await application.waitForSettle()
  const toolName = inspectRequest(fixture.primeServer.requests[0]).tools.find(
    (name) => name === 'ipython' || name === 'python'
  )
  assert.ok(toolName, 'the native Python runtime exposes delegation')
  const parentState = await application.rpc({ type: 'get_state' }, parent.agentId)
  const parentNative = await native(parent.agentId, 'get_state')
  const spawnChild = [
    'import rlm',
    `child = await rlm.spawn(${JSON.stringify(CHILD_TASK)}, name=${JSON.stringify(CHILD_NAME)})`,
    'print(child.rlm_child_id)'
  ].join('\n')
  const spawnGrandchild = [
    'import rlm',
    `child = await rlm.spawn(${JSON.stringify(GRANDCHILD_TASK)}, name=${JSON.stringify(GRANDCHILD_NAME)})`,
    'print(child.rlm_child_id)'
  ].join('\n')
  fixture.primeServer.queue(
    turn.toolCall(toolName, { code: spawnChild }, { when: matchesTask(PARENT_TASK) }),
    turn.toolCall(toolName, { code: spawnGrandchild }, { when: matchesTask(CHILD_TASK) }),
    turn.text('Lineage verifier completed.', { when: matchesTask(GRANDCHILD_TASK) }),
    turn.text(CHILD_ANSWER, { when: matchesTask(CHILD_TASK) }),
    turn.text('Lineage parent completed.', { when: matchesTask(PARENT_TASK) })
  )
  await application.send(PARENT_TASK)
  const child = await until(
    async () => {
      const children = (await native(parent.agentId, 'get_rlm_children')).children
      return children.find((entry) => entry.sessionName === CHILD_NAME && entry.status === 'done')
    },
    { label: 'native nested delegation completed', timeoutMs: KERNEL_TIMEOUT_MS }
  )
  const residents = await application.invoke('engine:background-list', 'prime')
  const childResident = residents.find((entry) => entry.id === child.activeSessionId)
  const grandchildResident = residents.find((entry) => entry.name === GRANDCHILD_NAME)
  assert.ok(childResident?.sessionPath)
  assert.ok(grandchildResident?.sessionPath)
  assert.equal(childResident.lineage.parentNativeAgentId, parentNative.activeSessionId)
  assert.equal(childResident.lineage.parentSessionId, parentState.sessionId)
  await requireSavedFamily(
    cwd,
    parentState.sessionFile,
    childResident.sessionPath,
    grandchildResident.sessionPath
  )
  await application.waitForSettle()
  await familyButton(PARENT_NAME)
  await familyButton(CHILD_NAME)
  assert.equal(await application.page.locator('[data-prime-subagent]').count(), 2)
  await application.screenshot('nested-native-family')
  console.log('PASS native child and grandchild remain accessible under their parent.')

  const requestsBeforeInspect = fixture.primeServer.requests.length
  await Promise.all([
    application.test('openSession', childResident.sessionPath, 'prime'),
    application.test('resumeBackground', childResident)
  ])
  const opened = (await application.invoke('engine:list')).filter(
    (entry) => entry.nativeAgentId === childResident.id
  )
  assert.equal(opened.length, 1, 'resident and file opens share one app tab')
  const childAgentId = opened[0].agentId
  assert.ok(
    JSON.stringify(await application.rpc({ type: 'get_messages' }, childAgentId)).includes(
      CHILD_ANSWER
    )
  )
  assert.equal(
    fixture.primeServer.requests.length,
    requestsBeforeInspect,
    'listing and transcript inspection do not ask the provider'
  )
  assert.equal((await application.agentState(childAgentId)).info.lineage.childId, child.id)
  application = await application.relaunch()
  const restoredChild = await until(
    async () => {
      const activeId = await application.activeAgentId()
      const active = activeId && (await application.agentState(activeId))
      return active?.status === 'ready' &&
        samePath(active.info.sessionFile, childResident.sessionPath)
        ? active
        : false
    },
    { label: 'explicit child tab restored', timeoutMs: KERNEL_TIMEOUT_MS }
  )
  assert.equal(restoredChild.info.lineage.childId, child.id)
  await application.screenshot('restored-child-family')
  console.log(
    'PASS concurrent opens and app relaunch retain one child tab, lineage and committed output.'
  )

  await application.test('openSession', parentState.sessionFile, 'prime')
  fixture.primeServer.queue(
    turn.toolCall(
      toolName,
      {
        code: [
          'import rlm',
          `root = await rlm.create_session(${JSON.stringify(ROOT_TASK)}, name=${JSON.stringify(ROOT_NAME)})`,
          'print(root.active_session_id)'
        ].join('\n')
      },
      { when: matchesTask(CREATE_ROOT_TASK) }
    ),
    turn.text('Independent session completed.', { when: matchesTask(ROOT_TASK) }),
    turn.text('Independent session created.', { when: matchesTask(CREATE_ROOT_TASK) })
  )
  await application.send(CREATE_ROOT_TASK)
  await application.waitForSettle({ timeoutMs: KERNEL_TIMEOUT_MS })
  const independent = await until(
    async () =>
      (await application.invoke('engine:background-list', 'prime')).find(
        (entry) => entry.name === ROOT_NAME
      ),
    { label: 'independent native root', timeoutMs: KERNEL_TIMEOUT_MS }
  )
  assert.equal(independent.lineage.depth, 0)
  assert.equal(independent.lineage.runtimeKind, 'top-level')
  await application.test('resumeBackground', independent)
  assert.equal(
    await application.page.locator('[data-prime-subagent]', { hasText: ROOT_NAME }).count(),
    0
  )

  const fork = await application.openWorkspace({
    cwd,
    args: { engine: 'prime', forkFrom: childResident.sessionPath, name: FORK_NAME }
  })
  const forkState = await application.rpc({ type: 'get_state' }, fork.agentId)
  assert.equal(forkState.lineage.depth, childResident.lineage.depth)
  assert.equal(
    await application.page.locator('[data-prime-subagent]', { hasText: FORK_NAME }).count(),
    0
  )
  await application.screenshot('independent-root-and-fork')
  console.log('PASS create_session and same-depth fork remain ordinary independent sessions.')

  for (const agent of await application.invoke('engine:list')) {
    await application.test('closeSession', agent.agentId)
  }
  assert.equal((await application.invoke('engine:list')).length, 0)
  await fixture.stopNativeDaemon()
  const providerRequests = fixture.primeServer.requests.length
  await requireSavedFamily(
    cwd,
    parentState.sessionFile,
    childResident.sessionPath,
    grandchildResident.sessionPath
  )
  assert.equal(
    (await application.invoke('engine:background-list', 'prime')).length,
    0,
    'offline saved discovery does not launch a daemon'
  )
  missingParent = { path: parentState.sessionFile, backup: `${parentState.sessionFile}.qa-backup` }
  await rename(missingParent.path, missingParent.backup)
  await until(
    async () => {
      const sessions = await listedSessions(cwd)
      return (
        !sessions.some((entry) => samePath(entry.path, missingParent.path)) &&
        sessions.some(
          (entry) => samePath(entry.path, childResident.sessionPath) && entry.lineage?.childId
        )
      )
    },
    { label: 'surviving orphan child history', timeoutMs: KERNEL_TIMEOUT_MS }
  )
  await application.page.getByRole('textbox', { name: 'Search sessions' }).fill(CHILD_NAME)
  await application.page.getByRole('region', { name: 'Subagent sessions' }).waitFor()
  await application.screenshot('recoverable-orphan-child')
  assert.equal(fixture.primeServer.requests.length, providerRequests)
  assert.equal((await application.invoke('engine:background-list', 'prime')).length, 0)
  console.log(
    'PASS offline and missing-parent discovery keeps child work recoverable without workers or model calls.'
  )
  await application.test('openSession', childResident.sessionPath, 'prime')
  const reopenedOrphan = (await application.invoke('engine:list')).find((entry) =>
    samePath(entry.sessionFile, childResident.sessionPath)
  )
  assert.ok(reopenedOrphan, 'the saved orphan can open in a fresh daemon')
  assert.equal(reopenedOrphan.lineage.childId, child.id)
  assert.ok(
    JSON.stringify(
      await application.rpc({ type: 'get_messages' }, reopenedOrphan.agentId)
    ).includes(CHILD_ANSWER)
  )
  assert.equal(fixture.primeServer.requests.length, providerRequests)
  await application.screenshot('reopened-orphan-child')
  console.log(
    'PASS reopening an orphan in a fresh daemon retains ledger identity and committed output.'
  )
  application.assertNoErrors()
} catch (error) {
  failure = error
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  if (missingParent) await rename(missingParent.backup, missingParent.path).catch(() => undefined)
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
}

if (failure) {
  console.error(failure)
  process.exitCode = 1
}
