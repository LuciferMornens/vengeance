import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { waitFor } from '../settings/settings-ui.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'

const outputDirectory = reportShotsDir('restart-safety')
const refusalObservationMilliseconds = 250
const restartDeadlineMilliseconds = 120_000
const naturalStreamChunkSize = 2
const naturalStreamDelayMilliseconds = 15
const naturalStreamRepeats = 12
const toolDeadlineMilliseconds = 60_000
const toolPollMilliseconds = 25
const millisecondsPerSecond = 1000
const childDelegationDepth = 1
const fixture = await createEngineFixture()
const report = { startedAt: new Date().toISOString(), checks: [] }
let application
let failure

async function descriptor(agentId) {
  const found = (await application.invoke('engine:list')).find((agent) => agent.agentId === agentId)
  assert.ok(found, 'the same conversation stays open')
  return found
}

async function assertRestartRefused(agentId, expression = /active work|wait/i) {
  const before = await descriptor(agentId)
  const beforeMessages = await application.rpc({ type: 'get_messages' }, agentId)
  await assert.rejects(application.invoke('engine:restart', agentId), expression)
  await application.page.waitForTimeout(refusalObservationMilliseconds)
  const after = await descriptor(agentId)
  assert.equal(after.pid, before.pid, 'refusal cannot replace the live worker')
  assert.equal(after.nativeAgentId, before.nativeAgentId)
  assert.equal(after.sessionFile, before.sessionFile)
  const afterMessages = await application.rpc({ type: 'get_messages' }, agentId)
  for (const message of beforeMessages.messages.filter((entry) => entry.role === 'user')) {
    assert.ok(
      afterMessages.messages.some((entry) => JSON.stringify(entry) === JSON.stringify(message)),
      'the current conversation keeps every committed user message'
    )
  }
  return after
}

async function verifyRefusal(agentId, request, label, server) {
  const after = await assertRestartRefused(agentId)
  assert.equal(request.outcome, 'streaming', 'refusal cannot abort the provider request')
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
  const updatedSettings = { ...settings, shellCommandPrefix: `echo restart-safety-${method}` }
  await writeFile(settingsPath, `${JSON.stringify(updatedSettings, null, 2)}\n`)
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

async function parkedPiQueue(agentId) {
  const steering = 'Deliver this parked steering message after the restart refusal.'
  const followUp = 'Deliver this parked follow-up after the restart refusal.'
  await application.rpc({ type: 'steer', message: steering }, agentId)
  await application.rpc({ type: 'follow_up', message: followUp }, agentId)
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.isStreaming, false, 'the queue is parked outside an active turn')
  assert.equal(state.pendingMessageCount, 2)
  await waitFor(async () => {
    const queue = (await application.agentState(agentId)).queue
    return queue.steering.includes(steering) && queue.followUp.includes(followUp)
  }, 'the renderer publishes both parked native queues')
  const beforeQueue = (await application.agentState(agentId)).queue
  const after = await assertRestartRefused(agentId, /queued messages/i)
  assert.deepEqual((await application.agentState(agentId)).queue, beforeQueue)
  const screenshot = await application.screenshot('pi-parked-queue-restart-refused')
  const from = fixture.piServer.requests.length
  fixture.piServer.queue(
    turn.text('The parked queue remains available.'),
    turn.text('The follow-up remains available.')
  )
  await application.rpc({ type: 'prompt', message: 'Continue the saved queue.' }, agentId)
  await waitFor(
    async () => {
      const current = await application.rpc({ type: 'get_state' }, agentId)
      return !current.isStreaming && current.pendingMessageCount === 0
    },
    'parked messages complete after the refusal',
    toolDeadlineMilliseconds
  )
  const delivered = fixture.piServer.requests.slice(from).flatMap((request) =>
    inspectRequest(request)
      .messages.filter((message) => message.role === 'user')
      .map((message) => message.text)
  )
  assert.ok(delivered.includes(steering), 'the native provider receives the parked steering')
  assert.ok(delivered.includes(followUp), 'the native provider receives the parked follow-up')
  report.checks.push({ label: 'pi-parked-queue-restart-refused', pid: after.pid, screenshot })
  console.log('  ✓ pi parked steering and follow-up survive refusal and are delivered')
}

function nativePythonTool(server) {
  const toolName = inspectRequest(server.requests.at(-1)).tools.find(
    (name) => name === 'ipython' || name === 'python'
  )
  assert.ok(toolName, 'the native provider advertises its Python tool')
  return toolName
}

async function runningNativeTool(engine, agentId, workspace) {
  const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
  const toolId = `${engine}-restart-held-tool`
  const marker = `${engine}-restart-tool-finished`
  const startedPath = join(workspace, `${engine}-tool-started`)
  const releasePath = join(workspace, `${engine}-tool-release`)
  let toolName
  let argumentsObject
  if (engine === 'pi') {
    await writeFile(
      join(workspace, 'restart-tool.mjs'),
      [
        "import { existsSync, writeFileSync } from 'node:fs'",
        "import { setTimeout as delay } from 'node:timers/promises'",
        "writeFileSync('pi-tool-started', 'started')",
        `const deadline = Date.now() + ${toolDeadlineMilliseconds}`,
        "while (!existsSync('pi-tool-release') && Date.now() < deadline) {",
        `  await delay(${toolPollMilliseconds})`,
        '}',
        "if (!existsSync('pi-tool-release')) throw new Error('Tool release deadline expired')",
        `console.log('${marker}')`,
        ''
      ].join('\n')
    )
    toolName = 'bash'
    argumentsObject = { command: 'node restart-tool.mjs' }
  } else {
    toolName = nativePythonTool(server)
    argumentsObject = {
      code: [
        'from pathlib import Path',
        'import time',
        `started = Path(${JSON.stringify(startedPath)})`,
        `release = Path(${JSON.stringify(releasePath)})`,
        "started.write_text('started')",
        `deadline = time.monotonic() + ${toolDeadlineMilliseconds / millisecondsPerSecond}`,
        'while not release.exists() and time.monotonic() < deadline:',
        `    time.sleep(${toolPollMilliseconds / millisecondsPerSecond})`,
        "assert release.exists(), 'Tool release deadline expired'",
        `print('${marker}')`
      ].join('\n')
    }
  }
  const from = server.requests.length
  server.queue(
    turn.toolCalls([{ id: toolId, name: toolName, args: argumentsObject }]),
    turn.text(`${engine} completed the tool after refusing restart.`)
  )
  let after
  let screenshot
  try {
    await application.rpc({ type: 'prompt', message: 'Run the tool until I release it.' }, agentId)
    await waitFor(
      async () => (await readFile(startedPath, 'utf8')) === 'started',
      `${engine} actually enters its native tool`,
      toolDeadlineMilliseconds
    )
    await waitFor(
      async () => (await application.agentState(agentId)).tools[toolId]?.status === 'running',
      `${engine} publishes its running native tool`
    )
    after = await assertRestartRefused(agentId)
    assert.equal((await application.agentState(agentId)).tools[toolId].status, 'running')
    screenshot = await application.screenshot(`${engine}-running-tool-restart-refused`)
  } finally {
    await writeFile(releasePath, 'release')
  }
  const nextRequest = await server.waitForRequest(
    (request) => inspectRequest(request).toolResults.some((result) => result.toolCallId === toolId),
    { from, timeoutMs: toolDeadlineMilliseconds }
  )
  const result = inspectRequest(nextRequest).toolResults.find(
    (entry) => entry.toolCallId === toolId
  )
  assert.notEqual(result.isError, true, result.text)
  assert.ok(result.text.includes(marker), 'the provider receives the completed native tool output')
  await waitFor(
    async () => !(await application.rpc({ type: 'get_state' }, agentId)).isStreaming,
    `${engine} completes the refused tool turn`
  )
  await waitFor(
    async () => (await application.agentState(agentId)).tools[toolId]?.status === 'done',
    `${engine} publishes the completed native tool`
  )
  assert.equal((await application.agentState(agentId)).tools[toolId].status, 'done')
  const messages = await application.rpc({ type: 'get_messages' }, agentId)
  const committed = messages.messages.find(
    (message) => message.role === 'toolResult' && message.toolCallId === toolId
  )
  assert.ok(committed, 'the actual completed tool result stays in native history')
  assert.ok(
    JSON.stringify(committed.content).includes(marker),
    'history keeps completed tool output'
  )
  const state = await application.rpc({ type: 'get_state' }, agentId)
  const saved = (await readFile(state.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const savedResult = saved.find(
    (entry) => entry.message?.role === 'toolResult' && entry.message.toolCallId === toolId
  )
  assert.ok(savedResult, 'the completed tool result is persisted in the saved session')
  assert.ok(JSON.stringify(savedResult.message.content).includes(marker))
  report.checks.push({
    label: `${engine}-running-tool-restart-refused`,
    pid: after.pid,
    screenshot
  })
  console.log(`  ✓ ${engine} native tool survives refusal and completes with saved output`)
}

async function workingPrimeChild(agentId) {
  const server = fixture.primeServer
  const childTask = 'Keep this delegated restart safety task alive until explicitly cancelled.'
  const childName = 'restart-safety-child'
  const parentTask = 'Delegate the restart safety task, then finish this parent turn.'
  const native = (command, payload = {}) =>
    application.invoke('prime:command', agentId, command, payload)
  await native('set_rlm_max_depth', { maxDepth: childDelegationDepth })
  const toolName = nativePythonTool(server)
  const isParent = (request) => inspectRequest(request).lastUserText === parentTask
  const isChild = (request) => inspectRequest(request).lastUserText.includes(childTask)
  const from = server.requests.length
  server.queue(
    turn.toolCall(
      toolName,
      {
        code: [
          'import rlm',
          `child = await rlm.spawn(${JSON.stringify(childTask)}, ` +
            `name=${JSON.stringify(childName)})`,
          'print(child.rlm_child_id)'
        ].join('\n')
      },
      { when: isParent }
    ),
    turn.hang({ text: 'The delegated task continues while the parent is idle.', when: isChild }),
    turn.text('The parent turn is complete; its child continues.', { when: isParent })
  )
  let child
  let childRequest
  try {
    await application.rpc({ type: 'prompt', message: parentTask }, agentId)
    childRequest = await server.waitForRequest(isChild, { from })
    child = await waitFor(
      async () => {
        const roster = await native('get_rlm_children')
        return roster.children.find(
          (entry) => entry.sessionName === childName && entry.status === 'running'
        )
      },
      'the real native child starts',
      toolDeadlineMilliseconds
    )
    await waitFor(
      async () => !(await application.rpc({ type: 'get_state' }, agentId)).isStreaming,
      'the parent settles while its child keeps working',
      toolDeadlineMilliseconds
    )
    const residents = await native('list', { all: false, includeClientOwned: true })
    const childBefore = (residents.sessions ?? residents.agents).find(
      (entry) => (entry.activeSessionId ?? entry.id) === child.activeSessionId
    )
    assert.ok(childBefore?.workerPid > 0, 'the actual child worker is identified')
    const childHistory = await readFile(childBefore.sessionFile, 'utf8')
    assert.ok(
      childHistory
        .trim()
        .split('\n')
        .map(JSON.parse)
        .some(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'agent_message' &&
            entry.details?.message === childTask
        ),
      'the child task is committed in its own saved conversation'
    )
    const after = await assertRestartRefused(agentId, /wait|idle|finish|working/i)
    assert.equal(childRequest.outcome, 'streaming', 'restart refusal cannot abort child work')
    const afterResidents = await native('list', { all: false, includeClientOwned: true })
    const childAfter = (afterResidents.sessions ?? afterResidents.agents).find(
      (entry) => (entry.activeSessionId ?? entry.id) === child.activeSessionId
    )
    assert.ok(childAfter, 'the child resident stays present after refusal')
    assert.equal(childAfter.workerPid, childBefore.workerPid)
    assert.equal(childAfter.sessionFile, childBefore.sessionFile)
    assert.ok(
      (await readFile(childAfter.sessionFile, 'utf8')).startsWith(childHistory),
      'restart refusal keeps every committed child history entry'
    )
    assert.equal(
      (await native('get_rlm_children')).children.find((entry) => entry.id === child.id).status,
      'running'
    )
    const screenshot = await application.screenshot('prime-working-child-restart-refused')
    report.checks.push({
      label: 'prime-working-child-restart-refused',
      pid: after.pid,
      childPid: childAfter.workerPid,
      childNativeAgentId: child.activeSessionId,
      providerOutcome: childRequest.outcome,
      screenshot
    })
  } finally {
    if (!child) {
      child = (await native('get_rlm_children')).children.find(
        (entry) => entry.sessionName === childName
      )
    }
    if (child) await native('cancel_rlm_child', { childId: child.id })
  }
  assert.equal(await server.waitForOutcome(childRequest), 'aborted', 'explicit child Stop works')
  await waitFor(async () => {
    const current = (await native('get_rlm_children')).children.find(
      (entry) => entry.id === child.id
    )
    return current && !['running', 'queued'].includes(current.status)
  }, 'explicitly cancelled child settles')
  await native('delete_rlm_subagent', { childId: child.id })
  console.log('  ✓ Prime idle parent refuses restart while its native child keeps working')
}

try {
  await mkdir(outputDirectory, { recursive: true })
  application = await launchApp({
    ...packagedLaunchOptions(fixture.environment),
    agentDir: fixture.piDirectory.dir,
    outDir: outputDirectory
  })
  await recordPackagedTarget(application)
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Restart safety\n' })
  const piId = await activeConversation('pi', workspace)
  await deferredRestartAfterSettle('pi', piId, 'stop')
  await deferredRestartAfterSettle('pi', piId, 'natural')
  await parkedPiQueue(piId)
  await runningNativeTool('pi', piId, workspace)
  const primeId = await activeConversation('prime', workspace)
  await deferredRestartAfterSettle('prime', primeId, 'stop')
  await deferredRestartAfterSettle('prime', primeId, 'natural')
  await explicitPrimeSelectionReset(primeId)
  await runningNativeTool('prime', primeId, workspace)
  await workingPrimeChild(primeId)
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
