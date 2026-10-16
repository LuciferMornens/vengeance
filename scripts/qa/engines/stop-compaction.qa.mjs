import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { dismissToasts, waitFor } from '../settings/settings-ui.mjs'
import { runPalette } from '../shell/lib/kit.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const OUTPUT_DIRECTORY = process.env.QA_PRIME_EXECUTABLE
  ? join(
      process.env.QA_REPORT_DIR
        ? resolve(process.env.QA_REPORT_DIR)
        : join(ROOT, '.shots', 'qa', 'native-prime-candidate'),
      'stop-compaction'
    )
  : join(ROOT, '.shots', 'qa', 'engine-ux', 'stop-compaction')
const QUEUE_OBSERVATION_MS = 1500
const COMPACTION_READY_MS = 30_000
const PROVIDER_SETTLE_MS = 30_000
const fixture = await createEngineFixture()
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  compactions: [],
  transportFailures: [],
  fixtureReleasedRequests: []
}
let application
let failure

async function configureSmallCompactions(directory) {
  const settingsPath = join(directory, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  // Tiny local transcripts must cross the native recent-history cutoff to reach the summarizer.
  settings.compaction = { ...settings.compaction, enabled: false, keepRecentTokens: 1 }
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

async function check(label, action) {
  console.log(`  • ${label}`)
  await dismissToasts(application)
  const evidence = await action()
  const screenshot = await application.screenshot(label)
  report.checks.push({ label, screenshot, evidence })
  console.log(`    ✓ ${label}`)
  return evidence
}

async function cancelCompaction(engine, agentId, server, method, transportChecks) {
  const from = server.requests.length
  server.queue(turn.hang({ text: 'The local summarizer is waiting for cancellation.' }))
  await runPalette(application.page, 'Compact context')
  const request = await server.waitForRequest(undefined, { from })
  await waitFor(
    async () => (await application.agentState(agentId)).compaction?.reason === 'manual',
    'native manual compaction starts',
    COMPACTION_READY_MS
  )
  const composer = await application.composer()
  const draft = `${engine} draft kept while cancelling with ${method}`
  await composer.fill(draft)
  assert.equal(await application.page.getByRole('button', { name: 'Send', exact: true }).count(), 0)
  assert.equal(
    await application.page.getByRole('button', { name: 'Steer', exact: true }).count(),
    0
  )
  assert.equal(
    await application.page.getByRole('button', { name: 'Follow-up', exact: true }).count(),
    0
  )
  const beforeEnter = await application.rpc({ type: 'get_state' }, agentId)
  await composer.press('Enter')
  const afterEnter = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(await composer.inputValue(), draft, 'Enter cannot submit during compaction')
  assert.equal(afterEnter.messageCount, beforeEnter.messageCount, 'Enter cannot add a message')
  assert.equal(afterEnter.pendingMessageCount, 0, 'Enter cannot queue the draft')
  await application.screenshot(`${engine}-compacting-${method}`)

  if (method === 'button') {
    await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
  } else if (method === 'escape') {
    await composer.press('Escape')
    await application.page.getByText('again to stop', { exact: false }).waitFor()
    await composer.press('Escape')
  } else {
    await runPalette(application.page, 'Stop the agent')
  }

  await waitFor(
    async () => !(await application.agentState(agentId)).compaction,
    'native compaction ends after Stop'
  )
  await application.waitForSettle()
  const nativeState = await application.rpc({ type: 'get_state' }, agentId)
  const lastCompaction = (await application.agentState(agentId)).lastCompaction
  assert.equal(nativeState.isCompacting, false)
  assert.equal(lastCompaction.aborted, true)
  assert.equal(await composer.inputValue(), draft, 'cancellation keeps the typed draft')
  await application.page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  await application.page.getByText('Compaction cancelled', { exact: true }).first().waitFor()
  assert.equal(
    await application.page.getByText('Could not compact the context', { exact: true }).count(),
    0,
    'user cancellation is not a failure notice'
  )
  const nativeMessages = await application.rpc({ type: 'get_messages' }, agentId)
  assert.equal(
    nativeMessages.messages.some((message) => JSON.stringify(message.content).includes(draft)),
    false,
    'the unsent draft must not enter native context'
  )
  const nativeRequests = server.requests.slice(from)
  const evidence = {
    engine,
    method,
    nativeState: {
      isStreaming: nativeState.isStreaming,
      isCompacting: nativeState.isCompacting,
      pendingMessageCount: nativeState.pendingMessageCount
    },
    lastCompaction,
    draftRetained: (await composer.inputValue()) === draft,
    nativeRequests: nativeRequests.map(({ index, api, outcome }) => ({ index, api, outcome }))
  }
  report.compactions.push(evidence)
  // Split-turn compaction can summarize history and its turn prefix in separate native requests.
  assert.equal(
    nativeRequests.some((entry) =>
      inspectRequest(entry).messages.some((message) => message.text.includes(draft))
    ),
    false,
    'no native provider request may contain the unsent draft'
  )
  transportChecks.push({ request, nativeRequests, evidence })
  await composer.fill('')
  return evidence
}

async function checkCompactionTransports(engine, server, checks) {
  // Keep independent UI checks running while native HTTP streams finish, then share one deadline.
  await Promise.all(
    checks.map(async ({ request, nativeRequests, evidence }) => {
      try {
        await Promise.all(
          nativeRequests.map((entry) =>
            server.waitForOutcome(entry, { timeoutMs: PROVIDER_SETTLE_MS })
          )
        )
        assert.equal(request.outcome, 'aborted', 'Stop must abort the hanging summarizer')
        assert.ok(nativeRequests.every((entry) => entry.outcome !== 'streaming'))
      } catch (error) {
        const failure = { engine, method: evidence.method, error: error.message }
        report.transportFailures.push(failure)
        console.error(`    ✗ ${engine}-${evidence.method} provider cleanup: ${error.message}`)
      } finally {
        evidence.nativeRequests = nativeRequests.map(({ index, api, outcome }) => ({
          index,
          api,
          outcome
        }))
      }
    })
  )
  // Fixture cleanup must not be mistaken for a native abort: outcomes above are captured first.
  const indexes = server.releaseRequests(checks.flatMap((check) => check.nativeRequests))
  report.fixtureReleasedRequests.push({ engine, indexes })
}

async function stopQueuedFollowUp(engine, agentId, server) {
  const from = server.requests.length
  const followUp = `${engine}: queued work must return to the editor`
  const draft = 'Keep this unfinished draft too.'
  server.queue(turn.hang({ text: 'This answer waits for the palette Stop action.' }))
  await application.send('Wait while I queue a follow-up.')
  const request = await server.waitForRequest(undefined, { from })
  const composer = await application.composer()
  await composer.fill(followUp)
  await composer.press('Alt+Enter')
  await waitFor(
    async () => (await application.agentState(agentId)).queue.followUp.includes(followUp),
    'follow-up reaches the native queue'
  )
  await composer.fill(draft)
  await runPalette(application.page, 'Stop the agent')
  assert.equal(await server.waitForOutcome(request), 'aborted')
  await application.waitForSettle()
  assert.equal(await composer.inputValue(), `${followUp}\n\n${draft}`)
  assert.deepEqual((await application.agentState(agentId)).queue, { steering: [], followUp: [] })
  await application.page.waitForTimeout(QUEUE_OBSERVATION_MS)
  assert.equal(server.requests.length, from + 1, 'Stop must not launch the queued follow-up')
  await application.page.getByRole('button', { name: 'Send', exact: true }).waitFor()
}

async function runEngine(engine, workspace) {
  const prime = engine === 'prime'
  const server = prime ? fixture.primeServer : fixture.piServer
  const provider = prime ? PRIME_PROVIDER : FAKE_PROVIDER
  const model = prime ? PRIME_MODELS.reasoning : FAKE_MODELS.reasoning
  const transportChecks = []
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine,
      model: `${provider}/${model}`,
      thinking: 'off',
      name: `${prime ? 'Engine 2' : 'Engine'} Stop QA`
    }
  })
  await waitFor(async () => (await application.agentState(agentId)).status === 'ready', 'ready')
  if (prime && fixture.candidate) {
    report.engineIdentity = await fixture.verifyPrimeExecutable(application, agentId)
    console.log(`    Native candidate SHA-256 ${report.engineIdentity.sha256}`)
  }
  server.queue(turn.text('A short completed answer creates history for manual compaction.'))
  await application.send('Reply briefly to seed the cancellation checks.')
  await application.waitForSettle()
  server.queue(turn.text('A second completed answer leaves an earlier turn to summarize.'))
  await application.send('Reply briefly again.')
  await application.waitForSettle()
  for (const method of ['button', 'escape', 'palette']) {
    await check(`${engine}-compaction-${method}`, () =>
      cancelCompaction(engine, agentId, server, method, transportChecks)
    )
  }
  await check(`${engine}-prompt-after-compaction-cancellation`, async () => {
    const from = server.requests.length
    server.queue(turn.text('The session accepts a new prompt after cancellation.'))
    await application.send('Reply briefly after compaction was stopped.')
    const request = await server.waitForRequest(undefined, { from })
    assert.equal(await server.waitForOutcome(request), 'completed')
    await application.waitForSettle()
    await application.page
      .getByText('The session accepts a new prompt after cancellation.', { exact: true })
      .waitFor()
  })
  await check(`${engine}-palette-stop-restores-queue`, () =>
    stopQueuedFollowUp(engine, agentId, server)
  )
  await checkCompactionTransports(engine, server, transportChecks)
}

try {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await configureSmallCompactions(fixture.piDirectory.dir)
  await configureSmallCompactions(fixture.primeDirectory)
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Stop QA\n' })
  await runEngine('pi', workspace)
  await runEngine('prime', workspace)
  application.assertNoErrors()
  assert.deepEqual(report.transportFailures, [], 'Native compaction provider cleanup failed')
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
  console.log(`✓ Native Stop and compaction: ${report.checks.length} checks passed`)
}
