import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { until } from '../chat/helpers.mjs'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { createEngineFixture } from './integration-fixture.mjs'

const OUTPUT_DIRECTORY = reportShotsDir('pi-transition')
const BASELINE_PACKAGE = resolve(
  process.env.QA_PI_BASELINE_PACKAGE ??
    join(
      ROOT,
      '.engine-staging',
      'baselines',
      '0.2.13',
      'engines',
      'pi',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent'
    )
)
const BASELINE_ENTRY = join(BASELINE_PACKAGE, 'dist', 'bundle', 'cli.js')
const HISTORY_MARKER = 'The native history written before the Engine upgrade.'
const TOOL_MARKER = 'This file was read by the baseline native Engine.'
const CANDIDATE_MARKER = 'The upgraded Engine continued the saved conversation.'
const RECOVERY_MARKER = 'The retained Engine can recover an isolated copy.'
const fixture = await createEngineFixture()
const report = { checks: [], screenshots: [] }
let application
let failure

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function check(label, action) {
  console.log(`  • ${label}`)
  await action()
  report.checks.push(label)
  console.log(`    ✓ ${label}`)
}

async function ready() {
  return until(
    async () => {
      const state = await application.agentState()
      return state?.status === 'ready' && state.info.engine === 'pi' ? state : undefined
    },
    { label: 'native Engine session ready' }
  )
}

async function setOverride(path) {
  await application.invoke('app:set-state', { engineOverridePath: path })
  assert.equal((await application.invoke('app:get-state')).engineOverridePath, path)
}

try {
  const baselineMetadata = JSON.parse(
    await readFile(join(BASELINE_PACKAGE, 'package.json'), 'utf8')
  )
  assert.equal(baselineMetadata.version, '1.2.0')
  report.baseline = {
    package: BASELINE_PACKAGE,
    version: baselineMetadata.vengeance.version,
    entrySha256: sha256(await readFile(BASELINE_ENTRY))
  }
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  await setOverride(BASELINE_ENTRY)
  const workspace = await fixture.root.folder('workspace', { 'history.txt': TOOL_MARKER })
  let sessionPath
  let baselineState
  let baselineMessages

  await check('the retained Engine writes native tool history and selection', async () => {
    await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'pi',
        provider: FAKE_PROVIDER,
        model: FAKE_MODELS.openai,
        thinking: 'high',
        name: 'Native Engine upgrade history',
        approve: true
      }
    })
    await ready()
    fixture.piServer.queue(
      turn.toolCall('read', { path: 'history.txt' }),
      turn.text(HISTORY_MARKER)
    )
    await application.send('Read history.txt and remember this brief exchange.')
    await application.waitForSettle()
    baselineState = await application.rpc({ type: 'get_state' })
    baselineMessages = await application.rpc({ type: 'get_messages' })
    sessionPath = baselineState.sessionFile
    assert.ok(sessionPath)
    assert.ok(JSON.stringify(baselineMessages).includes(HISTORY_MARKER))
    assert.ok(JSON.stringify(baselineMessages).includes(TOOL_MARKER))
    report.baseline.sessionId = baselineState.sessionId
    report.baseline.historySha256 = sha256(await readFile(sessionPath))
  })

  await check(
    'the new Engine restores native identity and full history after relaunch',
    async () => {
      await setOverride(null)
      application = await application.relaunch()
      await ready()
      const descriptor = await application.invoke('engine:describe', 'pi')
      assert.equal(descriptor.source, 'bundled')
      const state = await application.rpc({ type: 'get_state' })
      const messages = await application.rpc({ type: 'get_messages' })
      assert.equal(state.sessionId, baselineState.sessionId)
      assert.equal(state.sessionFile, sessionPath)
      assert.equal(state.model.provider, baselineState.model.provider)
      assert.equal(state.model.id, baselineState.model.id)
      assert.equal(state.thinkingLevel, baselineState.thinkingLevel)
      assert.deepEqual(messages, baselineMessages)
      report.candidate = descriptor
      report.screenshots.push(await application.screenshot('pi-upgrade-restored'))
    }
  )

  await check('the upgraded provider receives the baseline tool result and messages', async () => {
    const from = fixture.piServer.requests.length
    fixture.piServer.queue(turn.text(CANDIDATE_MARKER))
    await application.send('Continue this conversation briefly.')
    await application.waitForSettle()
    const request = await fixture.piServer.waitForRequest(undefined, { from })
    const inspected = inspectRequest(request)
    assert.equal(inspected.model, baselineState.model.id)
    assert.ok(JSON.stringify(request.body).includes(HISTORY_MARKER))
    assert.ok(inspected.toolResults.some((result) => result.text.includes(TOOL_MARKER)))
    assert.ok(
      JSON.stringify(await application.rpc({ type: 'get_messages' })).includes(CANDIDATE_MARKER)
    )
  })

  await check('the retained Engine recovers an isolated copy of the upgraded history', async () => {
    const upgradedBytes = await readFile(sessionPath)
    const recoveryPath = fixture.root.path('recovery.jsonl')
    await copyFile(sessionPath, recoveryPath)
    const activeId = await application.activeAgentId()
    await application.invoke('engine:dispose', activeId)
    await setOverride(BASELINE_ENTRY)
    await application.openWorkspace({
      cwd: workspace,
      args: { engine: 'pi', sessionPath: recoveryPath, approve: true }
    })
    await ready()
    const restored = JSON.stringify(await application.rpc({ type: 'get_messages' }))
    assert.ok(restored.includes(HISTORY_MARKER))
    assert.ok(restored.includes(TOOL_MARKER))
    assert.ok(restored.includes(CANDIDATE_MARKER))
    fixture.piServer.queue(turn.text(RECOVERY_MARKER))
    await application.send('Confirm recovery briefly.')
    await application.waitForSettle()
    assert.ok(
      JSON.stringify(await application.rpc({ type: 'get_messages' })).includes(RECOVERY_MARKER)
    )
    assert.deepEqual(
      await readFile(sessionPath),
      upgradedBytes,
      'Recovery uses only the copied file'
    )
    assert.equal(sha256(await readFile(BASELINE_ENTRY)), report.baseline.entrySha256)
    report.screenshots.push(await application.screenshot('pi-upgrade-recovery-copy'))
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
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(
    join(OUTPUT_DIRECTORY, 'report.json'),
    `${JSON.stringify({ ...report, failure: failure?.stack }, null, 2)}\n`
  )
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(`✓ Native Engine upgrade and recovery: ${report.checks.length} checks passed`)
}
