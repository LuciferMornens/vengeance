import assert from 'node:assert/strict'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { waitFor } from './settings-ui.mjs'
import {
  createEngineFixture,
  engineSettings,
  PRIME_MODELS,
  PRIME_PROVIDER
} from '../engines/integration-fixture.mjs'

const SUITE_NAME = 'system-prompts'
const WATCHER_SETTLE_MS = 1800
const RESTART_TIMEOUT_MS = 90_000
const MAX_INSTRUCTION_BYTES = 1024 * 1024
const fixture = await createEngineFixture()
let application

async function file(engine, cwd, kind, scope = 'global') {
  return engineSettings(application, engine, 'settings:instruction-file', cwd, { kind, scope })
}

async function save(engine, cwd, kind, text, scope = 'global') {
  const current = await file(engine, cwd, kind, scope)
  return engineSettings(
    application,
    engine,
    'settings:instruction-file-write',
    cwd,
    {
      kind,
      scope,
      expected: { exists: current.exists, text: current.text }
    },
    text
  )
}

async function descriptor(agentId) {
  const result = (await application.invoke('engine:list')).find(
    (agent) => agent.agentId === agentId
  )
  assert.ok(result)
  return result
}

async function request(server, agentId, message) {
  const from = server.requests.length
  server.queue(turn.text('ok'))
  await application.rpc({ type: 'prompt', message }, agentId)
  const result = await server.waitForRequest(
    (entry) => entry.method === 'POST' && inspectRequest(entry).lastUserText === message,
    { from }
  )
  await application.waitForSettle()
  return inspectRequest(result).system
}

async function openSession(engine, cwd, name) {
  const args =
    engine === 'prime'
      ? { provider: PRIME_PROVIDER, model: PRIME_MODELS.reasoning }
      : { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, approve: true }
  return (
    await application.openWorkspace({ cwd, args: { ...args, engine, name, thinking: 'off' } })
  ).agentId
}

async function explicitRestart(engine, agentId, beforePid) {
  await application.test('openSettings', 'sessions')
  await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
  await application.page
    .getByRole('option', { name: engine === 'pi' ? 'Engine' : 'Engine 2', exact: true })
    .click()
  const session = await descriptor(agentId)
  await application.page.getByRole('combobox', { name: 'System prompt session' }).click()
  await application.page.getByRole('option', { name: session.sessionName, exact: true }).click()
  await application.page.getByRole('button', { name: 'Restart to apply', exact: true }).click()
  const dialog = application.page.getByRole('dialog', {
    name: 'Restart to apply saved instructions?'
  })
  await dialog.getByRole('button', { name: 'Restart session', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: RESTART_TIMEOUT_MS })
  await waitFor(
    async () => {
      const current = await descriptor(agentId)
      return current.status === 'ready' && current.pid !== beforePid
    },
    `${engine} explicit instruction restart`,
    RESTART_TIMEOUT_MS
  )
  await application.test('closeSettings')
}

async function checkEngine(engine) {
  console.log(`  • ${engine}: native prompt, held save, guarded apply, scopes and restore`)
  const server = engine === 'prime' ? fixture.primeServer : fixture.piServer
  const cwd = await fixture.root.folder(`${engine}-workspace`, { 'README.md': '# Prompt QA\n' })
  const beforeFoundation = `QA_${engine}_FOUNDATION_BEFORE`
  const afterFoundation = `QA_${engine}_FOUNDATION_AFTER`
  const beforeAppend = `QA_${engine}_APPEND_BEFORE`
  const afterAppend = `QA_${engine}_APPEND_AFTER`
  await save(engine, cwd, 'SYSTEM.md', beforeFoundation)
  await save(engine, cwd, 'APPEND_SYSTEM.md', beforeAppend)
  const agentId = await openSession(engine, cwd, `${engine} prompt verification`)
  const initial = await request(server, agentId, `${engine} before`)
  assert.ok(initial.includes(beforeFoundation))
  assert.ok(initial.includes(beforeAppend))
  const native = await application.invoke(
    'engine:bridge',
    agentId,
    { op: 'system-prompt' },
    undefined
  )
  assert.ok(native.text.includes(beforeFoundation))
  const defaults = await engineSettings(application, engine, 'settings:system-prompt-default')
  assert.ok(defaults.text.length > beforeFoundation.length)
  assert.ok(!defaults.text.includes(beforeFoundation))
  if (engine === 'pi') {
    assert.ok(defaults.text.includes('- read:'))
    assert.ok(defaults.text.includes('- bash:'))
    assert.ok(!defaults.text.includes('<tools>\n(none)'))
  }

  const heldMessage = `${engine} held request`
  const from = server.requests.length
  server.queue(turn.hang({ text: 'working' }))
  await application.rpc({ type: 'prompt', message: heldMessage }, agentId)
  const held = await server.waitForRequest(
    (entry) => entry.method === 'POST' && inspectRequest(entry).lastUserText === heldMessage,
    { from }
  )
  const before = await descriptor(agentId)
  await save(engine, cwd, 'SYSTEM.md', afterFoundation)
  await save(engine, cwd, 'APPEND_SYSTEM.md', afterAppend)
  await application.page.waitForTimeout(WATCHER_SETTLE_MS)
  const during = await descriptor(agentId)
  assert.equal(during.pid, before.pid)
  assert.equal(during.nativeAgentId, before.nativeAgentId)
  assert.equal(held.outcome, 'streaming')
  assert.ok(inspectRequest(held).system.includes(beforeFoundation))
  assert.ok(!inspectRequest(held).system.includes(afterFoundation))
  await application.rpc({ type: 'abort' }, agentId)
  await application.waitForSettle()
  await application.page.waitForTimeout(WATCHER_SETTLE_MS)
  assert.equal((await descriptor(agentId)).pid, before.pid, 'saving did not queue a restart')
  const stillRunning = await request(server, agentId, `${engine} saved but not applied`)
  assert.ok(stillRunning.includes(beforeFoundation))
  assert.ok(!stillRunning.includes(afterFoundation))

  await explicitRestart(engine, agentId, before.pid)
  const applied = await request(server, agentId, `${engine} after explicit restart`)
  assert.ok(applied.includes(afterFoundation))
  assert.ok(applied.includes(afterAppend))
  const refreshed = await application.invoke(
    'engine:bridge',
    agentId,
    { op: 'system-prompt' },
    undefined
  )
  assert.ok(refreshed.text.includes(afterFoundation))

  await assert.rejects(
    engineSettings(
      application,
      engine,
      'settings:instruction-file-write',
      cwd,
      {
        kind: 'SYSTEM.md',
        scope: 'global',
        expected: { exists: false, text: '' }
      },
      'overwrite an external edit'
    ),
    /changed outside the editor/
  )
  await assert.rejects(save(engine, cwd, 'SYSTEM.md', '  '), /cannot be empty/)
  await assert.rejects(
    save(engine, cwd, 'APPEND_SYSTEM.md', 'x'.repeat(MAX_INSTRUCTION_BYTES + 1)),
    /too large/
  )
  assert.ok((await file(engine, cwd, 'SYSTEM.md')).text.includes(afterFoundation))
  const other = await file(engine === 'pi' ? 'prime' : 'pi', cwd, 'SYSTEM.md')
  assert.ok(!other.text.includes(afterFoundation), 'engine account directories stay separate')

  const projectFoundation = `QA_${engine}_PROJECT_FOUNDATION`
  const projectAppend = `QA_${engine}_PROJECT_APPEND`
  await save(engine, cwd, 'SYSTEM.md', projectFoundation, 'project')
  await save(engine, cwd, 'APPEND_SYSTEM.md', projectAppend, 'project')
  const projectAgent = await openSession(engine, cwd, `${engine} project prompt`)
  const projectPrompt = await request(server, projectAgent, `${engine} project precedence`)
  assert.ok(projectPrompt.includes(projectFoundation))
  assert.ok(projectPrompt.includes(projectAppend))
  assert.ok(!projectPrompt.includes(afterFoundation))
  assert.ok(!projectPrompt.includes(afterAppend))
  const beforeRestore = (await application.invoke('engine:list')).filter(
    (agent) => agent.engine === engine
  )
  await save(engine, cwd, 'SYSTEM.md', null, 'project')
  await save(engine, cwd, 'APPEND_SYSTEM.md', null, 'project')
  await save(engine, cwd, 'SYSTEM.md', null)
  await save(engine, cwd, 'APPEND_SYSTEM.md', null)
  await application.page.waitForTimeout(WATCHER_SETTLE_MS)
  for (const previous of beforeRestore) {
    assert.equal(
      (await descriptor(previous.agentId)).pid,
      previous.pid,
      'restoring files never restarts open work'
    )
  }
  const restoredAgent = await openSession(engine, cwd, `${engine} restored default`)
  const restored = await request(server, restoredAgent, `${engine} restored native default`)
  assert.ok(!restored.includes(afterFoundation))
  assert.ok(!restored.includes(projectFoundation))
  assert.ok(!(await file(engine, cwd, 'SYSTEM.md')).exists)
  console.log(
    `    ✓ ${engine}: native requests reflect only explicit apply; ` +
      'account and scope isolation passed'
  )
}

console.log(`▶ ${SUITE_NAME} (both real engines; local providers and temporary accounts)`)
try {
  application = await launchApp({
    ...packagedLaunchOptions(fixture.environment),
    agentDir: fixture.piDirectory.dir,
    outDir: reportShotsDir(SUITE_NAME)
  })
  await recordPackagedTarget(application)
  const state = await application.appState()
  await application.test('setPrefs', {
    features: {
      ...state.prefs.features,
      settings: { ...state.prefs.features.settings, restartPolicy: 'always' }
    }
  })
  await checkEngine('pi')
  await checkEngine('prime')
  application.assertNoErrors()
  console.log(`✓ ${SUITE_NAME} passed`)
} finally {
  try {
    await application?.close({ beforeCleanup: fixture.stopNativeDaemon })
  } finally {
    await fixture.cleanup()
  }
}
