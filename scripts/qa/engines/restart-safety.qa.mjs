import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { waitFor } from '../settings/settings-ui.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const outputDirectory = reportShotsDir('restart-safety')
const refusalObservationMilliseconds = 250
const restartDeadlineMilliseconds = 120_000
const naturalStreamChunkSize = 2
const naturalStreamDelayMilliseconds = 15
const naturalStreamRepeats = 12
const fixture = await createEngineFixture()
const report = { startedAt: new Date().toISOString(), checks: [] }
let application
let failure

async function descriptor(agentId) {
  const found = (await application.invoke('engine:list')).find((agent) => agent.agentId === agentId)
  assert.ok(found, 'the same conversation stays open')
  return found
}

async function verifyRefusal(agentId, request, label, server, expression = /active work|wait/i) {
  const before = await descriptor(agentId)
  const beforeMessages = await application.rpc({ type: 'get_messages' }, agentId)
  await assert.rejects(application.invoke('engine:restart', agentId), expression)
  await application.page.waitForTimeout(refusalObservationMilliseconds)
  const after = await descriptor(agentId)
  assert.equal(after.pid, before.pid, 'refusal cannot replace the live worker')
  assert.equal(after.nativeAgentId, before.nativeAgentId)
  assert.equal(after.sessionFile, before.sessionFile)
  assert.equal(request.outcome, 'streaming', 'refusal cannot abort the provider request')
  const afterMessages = await application.rpc({ type: 'get_messages' }, agentId)
  for (const message of beforeMessages.messages.filter((entry) => entry.role === 'user')) {
    assert.ok(
      afterMessages.messages.some((entry) => JSON.stringify(entry) === JSON.stringify(message)),
      'the current conversation keeps every committed user message'
    )
  }
  const screenshot = await application.screenshot(label)
  report.checks.push({ label, pid: after.pid, providerOutcome: request.outcome, screenshot })
  console.log(`  ✓ ${label}: worker ${after.pid}, provider still streaming`)
  await application.rpc({ type: 'abort' }, agentId)
  assert.equal(await server.waitForOutcome(request), 'aborted', 'explicit Stop remains usable')
  await waitFor(
    async () => !(await application.rpc({ type: 'get_state' }, agentId)).isStreaming,
    'explicit Stop settles the native turn'
  )
}

async function activeConversation(engine, workspace) {
  const prime = engine === 'prime'
  const server = prime ? fixture.primeServer : fixture.piServer
  const provider = prime ? PRIME_PROVIDER : FAKE_PROVIDER
  const model = prime ? PRIME_MODELS.reasoning : FAKE_MODELS.reasoning
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: { engine, provider, model, thinking: 'off', name: `${engine} restart safety` }
  })
  if (prime) await fixture.verifyPrimeExecutable(application, agentId)
  const from = server.requests.length
  server.queue(turn.hang({ text: 'The current turn stays alive until I explicitly press Stop.' }))
  await application.rpc({ type: 'prompt', message: 'Wait for my explicit Stop.' }, agentId)
  const request = await server.waitForRequest(undefined, { from })
  await waitFor(
    async () => (await application.rpc({ type: 'get_state' }, agentId)).isStreaming,
    `${engine} native turn starts`
  )
  await verifyRefusal(agentId, request, `${engine}-active-restart-refused`, server)
  return agentId
}

async function deferredRestartAfterSettle(engine, agentId, method) {
  const server = engine === 'prime' ? fixture.primeServer : fixture.piServer
  const agentDirectory = engine === 'prime' ? fixture.primeDirectory : fixture.piDirectory.dir
  const before = await descriptor(agentId)
  const from = server.requests.length
  const prompt = `${engine}: apply my pending restart after this ${method} turn settles.`
  server.queue(
    method === 'stop'
      ? turn.hang({ text: 'The requested restart waits for this turn to finish.' })
      : turn.text(
          'The pending restart waits for natural completion. '.repeat(naturalStreamRepeats),
          {
            chunkSize: naturalStreamChunkSize,
            delayMs: naturalStreamDelayMilliseconds
          }
        )
  )
  await application.rpc({ type: 'prompt', message: prompt }, agentId)
  const request = await server.waitForRequest(undefined, { from })
  const settingsPath = join(agentDirectory, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  await writeFile(
    settingsPath,
    `${JSON.stringify({ ...settings, shellCommandPrefix: `echo restart-safety-${method}` }, null, 2)}\n`
  )
  await application.page.getByText('Restart to apply', { exact: true }).waitFor()
  await application.page.getByRole('button', { name: 'Restart engines', exact: true }).click()
  await application.page.waitForTimeout(refusalObservationMilliseconds)
  assert.equal((await descriptor(agentId)).pid, before.pid)
  assert.equal(request.outcome, 'streaming', 'the deferred action keeps active work running')
  if (method === 'stop') await application.rpc({ type: 'abort' }, agentId)
  assert.equal(await server.waitForOutcome(request), method === 'stop' ? 'aborted' : 'completed')
  await waitFor(
    async () => {
      const current = await descriptor(agentId)
      return current.status === 'ready' && current.pid !== before.pid
    },
    `${engine} applies the pending restart after ${method}`,
    restartDeadlineMilliseconds
  )
  const messages = await application.rpc({ type: 'get_messages' }, agentId)
  assert.ok(JSON.stringify(messages.messages).includes(prompt), 'saved history survives restart')
  assert.equal(
    await application.page.getByText('Could not restart session', { exact: true }).count(),
    0,
    'a temporary command-admission race does not become a restart failure'
  )
  const screenshot = await application.screenshot(`${engine}-deferred-restart-after-${method}`)
  report.checks.push({
    label: `${engine}-deferred-restart-after-${method}`,
    beforePid: before.pid,
    afterPid: (await descriptor(agentId)).pid,
    screenshot
  })
  console.log(`  ✓ ${engine} deferred Restart engines applies after ${method}`)
}

async function busyPrimeSibling(targetId, workspace) {
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: 'Engine 2 busy restart sibling'
    }
  })
  const from = fixture.primeServer.requests.length
  fixture.primeServer.queue(turn.hang({ text: 'A sibling session keeps running.' }))
  await application.rpc({ type: 'prompt', message: 'Keep this sibling working.' }, agentId)
  const request = await fixture.primeServer.waitForRequest(undefined, { from })
  const siblingBefore = await descriptor(agentId)
  const targetBefore = await descriptor(targetId)
  await assert.rejects(application.invoke('engine:restart', targetId), /wait|idle|finish/i)
  await application.page.waitForTimeout(refusalObservationMilliseconds)
  assert.equal((await descriptor(agentId)).pid, siblingBefore.pid)
  assert.equal((await descriptor(targetId)).pid, targetBefore.pid)
  assert.equal(request.outcome, 'streaming')
  const screenshot = await application.screenshot('prime-busy-sibling-restart-refused')
  report.checks.push({
    label: 'prime-busy-sibling-restart-refused',
    targetPid: targetBefore.pid,
    siblingPid: siblingBefore.pid,
    providerOutcome: request.outcome,
    screenshot
  })
  await application.rpc({ type: 'abort' }, agentId)
  assert.equal(await fixture.primeServer.waitForOutcome(request), 'aborted')
  console.log('  ✓ prime busy sibling keeps its worker and streaming provider request')
}

async function explicitPrimeSelectionReset(agentId) {
  const before = await descriptor(agentId)
  await application.rpc(
    { type: 'set_model', provider: PRIME_PROVIDER, modelId: PRIME_MODELS.small },
    agentId
  )
  await application.rpc({ type: 'set_thinking_level', level: 'high' }, agentId)
  const live = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(live.model.id, PRIME_MODELS.small)
  assert.equal(live.thinkingLevel, 'high')
  const restarted = await application.invoke('engine:restart', agentId, {
    provider: PRIME_PROVIDER,
    model: PRIME_MODELS.reasoning,
    thinking: 'off'
  })
  assert.equal(restarted.status, 'ready')
  assert.notEqual(restarted.pid, before.pid)
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.model.id, PRIME_MODELS.reasoning)
  assert.equal(state.thinkingLevel, 'off')
  const screenshot = await application.screenshot('prime-explicit-selection-reset')
  report.checks.push({ label: 'prime-explicit-selection-reset', screenshot })
  console.log('  ✓ prime restart honors explicit initial model and thinking after a live change')
}

try {
  await mkdir(outputDirectory, { recursive: true })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: outputDirectory
  })
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Restart safety\n' })
  const piId = await activeConversation('pi', workspace)
  await deferredRestartAfterSettle('pi', piId, 'stop')
  await deferredRestartAfterSettle('pi', piId, 'natural')
  const primeId = await activeConversation('prime', workspace)
  await deferredRestartAfterSettle('prime', primeId, 'stop')
  await deferredRestartAfterSettle('prime', primeId, 'natural')
  await explicitPrimeSelectionReset(primeId)
  await busyPrimeSibling(primeId, workspace)
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
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(`✓ Restart safety: ${report.checks.length} native checks passed`)
}
