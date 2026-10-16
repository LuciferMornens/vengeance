import assert from 'node:assert/strict'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { launchApp, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { isAlive } from '../lib/processes.mjs'
import { waitFor } from '../settings/settings-ui.mjs'
import {
  createEngineFixture,
  executableHash,
  PRIME_MODELS,
  PRIME_PROVIDER,
  processIdentity
} from './integration-fixture.mjs'

const SESSION_NAME = 'Engine 2 executable transition'
const HISTORY_ANSWER = 'Official Engine 2 history survives the executable transition.'
const CANDIDATE_ANSWER = 'Candidate Engine 2 continues the saved conversation.'
const OUTPUT_DIRECTORY = join(
  process.env.QA_REPORT_DIR
    ? resolve(process.env.QA_REPORT_DIR)
    : join(ROOT, '.shots', 'qa', 'native-prime-candidate'),
  'executable-transition'
)

assert.ok(process.env.QA_PRIME_EXECUTABLE, 'A reviewed native candidate is required')
assert.ok(process.env.QA_PRIME_SHA256, 'The reviewed candidate SHA-256 is required')

const fixture = await createEngineFixture()
const report = { startedAt: new Date().toISOString(), checks: [] }
let application
let failure

function samePath(actual, expected) {
  return typeof actual === 'string' && resolve(actual).toLowerCase() === expected.toLowerCase()
}

async function check(label, action) {
  console.log(`  • ${label}`)
  try {
    await action()
    const screenshot = await application.screenshot(label)
    report.checks.push({ label, passed: true, screenshot })
    console.log(`    ✓ ${label}`)
  } catch (error) {
    report.checks.push({ label, passed: false, error: error.stack })
    throw error
  }
}

async function setExecutable(executable) {
  await application.invoke('app:set-state', { engineOverridePaths: { prime: executable } })
  const prefs = await application.invoke('app:get-state')
  assert.ok(samePath(prefs.engineOverridePaths.prime, executable))
  const description = await application.invoke('engine:describe', 'prime')
  assert.equal(description.source, 'override')
  assert.equal(description.mock, false)
  assert.ok(samePath(description.cliPath, executable))
  return description
}

try {
  const officialExecutable = await realpath(
    process.env.QA_PRIME_BASELINE_EXECUTABLE ??
      join(ROOT, '.engine-staging', 'prime', 'release', 'prime-agent.exe')
  )
  const officialHash = await executableHash(officialExecutable)
  assert.ok(!samePath(officialExecutable, fixture.candidate.executablePath))
  assert.notEqual(officialHash, fixture.candidate.sha256)
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const officialDescription = await setExecutable(officialExecutable)
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Isolated native executable transition QA\n'
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
    'official resident ready'
  )

  await check('official resident records the saved history', async () => {
    fixture.primeServer.queue(turn.text(HISTORY_ANSWER))
    await application.send('Remember this short history before switching executables.')
    await application.waitForSettle()
    const descriptor = (await application.invoke('engine:list')).find(
      (entry) => entry.agentId === agentId
    )
    const worker = await processIdentity(descriptor.pid)
    const daemon = await processIdentity(worker.parentPid)
    assert.ok(samePath(worker.executablePath, officialExecutable))
    assert.ok(samePath(daemon.executablePath, officialExecutable))
    const state = await application.rpc({ type: 'get_state' }, agentId)
    assert.ok(state.sessionFile)
    const messages = await application.rpc({ type: 'get_messages' }, agentId)
    assert.ok(JSON.stringify(messages).includes(HISTORY_ANSWER))
    report.before = {
      executablePath: officialExecutable,
      sha256: officialHash,
      description: officialDescription,
      worker,
      daemon,
      nativeAgentId: descriptor.nativeAgentId,
      state,
      messages
    }
    console.log(`    Official worker ${worker.pid}; SHA-256 ${officialHash}`)
  })

  await check(
    'explicit restart changes executable and preserves native identity and history',
    async () => {
      await setExecutable(fixture.candidate.executablePath)
      await application.invoke('engine:restart', agentId, undefined)
      await waitFor(
        async () => (await application.agentState(agentId))?.status === 'ready',
        'candidate resident restored'
      )
      const identity = await fixture.verifyPrimeExecutable(application, agentId)
      const descriptor = (await application.invoke('engine:list')).find(
        (entry) => entry.agentId === agentId
      )
      const state = await application.rpc({ type: 'get_state' }, agentId)
      const messages = await application.rpc({ type: 'get_messages' }, agentId)
      report.after = { ...identity, nativeAgentId: descriptor.nativeAgentId, state, messages }
      assert.notEqual(identity.worker.pid, report.before.worker.pid)
      assert.equal(isAlive(report.before.worker.pid), false)
      assert.equal(isAlive(report.before.daemon.pid), false)
      assert.equal(descriptor.nativeAgentId, report.before.nativeAgentId)
      assert.equal(state.sessionId, report.before.state.sessionId)
      assert.equal(state.sessionFile, report.before.state.sessionFile)
      assert.equal(state.model.provider, report.before.state.model.provider)
      assert.equal(state.model.id, report.before.state.model.id)
      const available = await application.rpc({ type: 'get_available_models' }, agentId)
      const selected = available.models.find(
        (model) => model.provider === state.model.provider && model.id === state.model.id
      )
      assert.ok(selected, 'The restored native model remains in the available catalog')
      assert.deepEqual(state.model.input, selected.input)
      assert.deepEqual(state.model.thinkingLevelMap, selected.thinkingLevelMap)
      assert.deepEqual(state.model.cost, selected.cost)
      assert.equal(state.model.contextWindow, selected.contextWindow)
      assert.equal(state.model.maxTokens, selected.maxTokens)
      assert.equal(state.thinkingLevel, report.before.state.thinkingLevel)
      assert.deepEqual(messages, report.before.messages)
      console.log(`    Candidate worker ${identity.worker.pid}; SHA-256 ${identity.sha256}`)
    }
  )

  await check('candidate answers using the restored conversation', async () => {
    const from = fixture.primeServer.requests.length
    fixture.primeServer.queue(turn.text(CANDIDATE_ANSWER))
    await application.send('Reply briefly after the executable transition.')
    await application.waitForSettle()
    const request = await fixture.primeServer.waitForRequest(undefined, { from })
    assert.equal(await fixture.primeServer.waitForOutcome(request), 'completed')
    assert.equal(inspectRequest(request).model, PRIME_MODELS.reasoning)
    assert.ok(JSON.stringify(request.body).includes(HISTORY_ANSWER))
    await application.page.getByText(CANDIDATE_ANSWER, { exact: true }).waitFor()
    report.finalIdentity = await fixture.verifyPrimeExecutable(application, agentId)
    assert.equal(await executableHash(officialExecutable), officialHash)
  })
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
  console.log(`✓ Official-to-candidate native restart: ${report.checks.length} checks passed`)
}
