import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchApp, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { pickModel, waitFor } from '../settings/settings-ui.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { checkRestartPeer } from './integration-session-lifecycle.mjs'

const SESSION_NAME = 'Engine2 candidate controls'
const STREAM_CHUNK_SIZE = 1
const STREAM_DELAY_MS = 35
const OUTPUT_DIRECTORY = join(
  process.env.QA_REPORT_DIR
    ? resolve(process.env.QA_REPORT_DIR)
    : join(ROOT, '.shots', 'qa', 'native-prime-candidate'),
  'controls-restart'
)

assert.ok(process.env.QA_PRIME_EXECUTABLE, 'A reviewed native candidate is required')
assert.ok(process.env.QA_PRIME_SHA256, 'The reviewed candidate SHA-256 is required')

const fixture = await createEngineFixture()
const report = { startedAt: new Date().toISOString(), checks: [], identities: [] }
let application
let failure

async function check(label, action) {
  console.log(`  • ${label}`)
  try {
    await action()
    const screenshot = await application.screenshot(`${report.checks.length + 1}-${label}`)
    report.checks.push({ label, passed: true, screenshot })
    console.log(`    ✓ ${label}`)
  } catch (error) {
    report.checks.push({ label, passed: false, error: error.stack })
    throw error
  }
}

async function verifyIdentity(agentId, label) {
  const identity = await fixture.verifyPrimeExecutable(application, agentId)
  assert.ok(identity, 'Candidate executable identity must be verified')
  report.identities.push({ label, ...identity })
  console.log(`    ${label}: worker ${identity.worker.pid}; SHA-256 ${identity.sha256}`)
  return identity
}

async function selectModel(agentId, model, label) {
  await pickModel(application, application.page.getByRole('button', { name: /^Model:/ }), label)
  await waitFor(
    async () => (await application.rpc({ type: 'get_state' }, agentId)).model?.id === model,
    `native model ${model}`
  )
}

async function selectThinking(agentId, level, label) {
  await application.page.getByRole('button', { name: /^Thinking level:/ }).click()
  await application.page.getByRole('menuitemradio', { name: new RegExp(`^${label}\\b`) }).click()
  await waitFor(
    async () => (await application.rpc({ type: 'get_state' }, agentId)).thinkingLevel === level,
    `native thinking ${level}`
  )
}

async function sendAndVerify(agentId, prompt, reply, model, thinking) {
  const from = fixture.primeServer.requests.length
  fixture.primeServer.queue(turn.text(reply))
  await application.send(prompt)
  await application.waitForSettle()
  const request = await fixture.primeServer.waitForRequest(undefined, { from })
  assert.equal(await fixture.primeServer.waitForOutcome(request), 'completed')
  const inspected = inspectRequest(request)
  assert.equal(inspected.model, model)
  assert.equal(inspected.reasoningEffort, thinking)
  const native = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(native.model.id, model)
  assert.equal(native.thinkingLevel, thinking)
  await application.page.getByText(reply, { exact: true }).waitFor()
}

try {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Isolated native candidate controls QA\n'
  })
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: SESSION_NAME
    }
  })
  await waitFor(
    async () => (await application.agentState(agentId))?.status === 'ready',
    'candidate ready'
  )
  const initialIdentity = await verifyIdentity(agentId, 'before-controls')
  const initialState = await application.rpc({ type: 'get_state' }, agentId)

  await check('idle model and reasoning controls reach the native provider request', async () => {
    await selectModel(agentId, PRIME_MODELS.small, 'Engine2 QA Small')
    await selectThinking(agentId, 'high', 'High')
    await sendAndVerify(
      agentId,
      'Reply briefly for the controls probe.',
      'Candidate controls answer.',
      PRIME_MODELS.small,
      'high'
    )
  })

  await check('live controls preserve a streamed answer and apply to the next turn', async () => {
    const from = fixture.primeServer.requests.length
    const reply = 'Candidate streaming continues while both footer controls change.'
    fixture.primeServer.queue(
      turn.text(reply, { chunkSize: STREAM_CHUNK_SIZE, delayMs: STREAM_DELAY_MS })
    )
    await application.send('Stream a short controls probe.')
    const request = await fixture.primeServer.waitForRequest(undefined, { from })
    assert.equal(request.outcome, 'streaming')
    await selectModel(agentId, PRIME_MODELS.reasoning, 'Engine2 QA Reasoning')
    assert.equal(request.outcome, 'streaming', 'reasoning changes while the answer is streaming')
    await selectThinking(agentId, 'low', 'Low')
    assert.equal(await fixture.primeServer.waitForOutcome(request), 'completed')
    await application.waitForSettle()
    await application.page.getByText(reply, { exact: true }).waitFor()
    await sendAndVerify(
      agentId,
      'Reply after changing the live controls.',
      'Candidate live controls applied.',
      PRIME_MODELS.reasoning,
      'low'
    )
    const levels = await application.rpc({ type: 'get_available_thinking_levels' }, agentId)
    await application.page.getByRole('button', { name: /^Thinking level:/ }).click()
    assert.equal(await application.page.getByRole('menuitemradio').count(), levels.levels.length)
    await application.page.keyboard.press('Escape')
    const identity = await verifyIdentity(agentId, 'after-live-controls')
    assert.equal(identity.worker.pid, initialIdentity.worker.pid)
    const state = await application.rpc({ type: 'get_state' }, agentId)
    assert.equal(state.sessionId, initialState.sessionId)
    assert.equal(state.sessionFile, initialState.sessionFile)
  })

  await checkRestartPeer(
    application,
    fixture.primeServer,
    workspace,
    agentId,
    SESSION_NAME,
    (label, action) =>
      check(label, async () => {
        const before = await verifyIdentity(agentId, 'before-restart')
        const stateBefore = await application.rpc({ type: 'get_state' }, agentId)
        await action()
        const after = await verifyIdentity(agentId, 'after-restart-and-busy-refusal')
        assert.notEqual(after.worker.pid, before.worker.pid, 'native restart replaces the worker')
        assert.equal(after.sha256, before.sha256)
        const stateAfter = await application.rpc({ type: 'get_state' }, agentId)
        assert.equal(stateAfter.sessionId, stateBefore.sessionId)
        assert.equal(stateAfter.sessionFile, stateBefore.sessionFile)
        assert.equal(stateAfter.thinkingLevel, 'medium')
      })
  )

  await check('the restored target can answer with its restarted reasoning configuration', () =>
    sendAndVerify(
      agentId,
      'Reply after the native candidate restart.',
      'Candidate restarted target answer.',
      PRIME_MODELS.reasoning,
      'medium'
    )
  )
  await verifyIdentity(agentId, 'after-final-prompt')
  application.assertNoErrors()
} catch (error) {
  failure = error
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
  report.failure = failure?.stack
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(join(OUTPUT_DIRECTORY, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(`✓ Native candidate controls and restart: ${report.checks.length} checks passed`)
}
