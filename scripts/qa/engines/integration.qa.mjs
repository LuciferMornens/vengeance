import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { isAlive } from '../lib/processes.mjs'
import { softSteps } from '../lib/steps.mjs'
import { checkEngineConfiguration } from './integration-configuration.mjs'
import { checkNativeControls } from './integration-native-controls.mjs'
import {
  checkResidentReattach,
  checkRestartPeer,
  checkSavedSidebar
} from './integration-session-lifecycle.mjs'
import {
  createEngineFixture,
  engineSettings,
  PRIME_MODELS,
  PRIME_PROVIDER
} from './integration-fixture.mjs'

const SUITE_NAME = 'engines-integration'
const WAIT_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 50
const STREAM_DELAY_MS = 25
const STREAM_CHUNK_SIZE = 1
const PI_SESSION_NAME = 'Engine isolation session'
const PRIME_SESSION_NAME = 'Engine2 integration session'
const RESTART_SYSTEM_PROMPT = 'You are Engine2 restart QA. Reply briefly.'
const EPHEMERAL_RUNS = 2

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  const elapsedSeconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(`    ✓ ${label} (${elapsedSeconds}s)`)
  return result
}

async function until(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((block) => block.text ?? block.thinking ?? '').join('')
}

function assistantText(state) {
  return state.entries
    .filter((entry) => entry.message?.role === 'assistant')
    .map((entry) => messageText(entry.message))
    .join('\n')
}

function samePath(actual, expected) {
  return resolve(actual).toLowerCase() === resolve(expected).toLowerCase()
}

async function activateSession(application, name) {
  await application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: name })
    .click()
  await application.composer()
}

async function setWorkspaceEngine(application, label) {
  await application.page.getByRole('button', { name: 'Switch workspace' }).click()
  await application.page.getByRole('combobox', { name: 'Engine for new sessions' }).click()
  await application.page.getByRole('option', { name: label, exact: true }).click()
  await application.page.getByRole('listbox').waitFor({ state: 'detached' })
  await application.page.keyboard.press('Escape')
  await application.page
    .getByRole('textbox', { name: 'Find workspace' })
    .waitFor({ state: 'hidden' })
}

async function nativeCommand(application, agentId, type, payload = {}) {
  return application.invoke('prime:command', agentId, type, payload)
}

console.log(`▶ ${SUITE_NAME} (native Engine2 and local fake providers)`)
const fixture = await createEngineFixture()
let application
let failure
const checks = softSteps(step, { app: () => application, name: SUITE_NAME })

try {
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Engine integration workspace\nOnly isolated QA files live here.\n'
  })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('engines')
  })
  let piAgentId
  let primeAgentId
  let primeSessionFile
  let importedSessionFile

  await step('detect both installed backends through the public IPC contract', async () => {
    const backends = await application.invoke('engine:backends')
    assert.deepEqual(backends.map((backend) => backend.id).sort(), ['pi', 'prime'])
    const prime = await application.invoke('engine:describe', 'prime')
    const engine = await application.invoke('engine:describe', 'pi')
    assert.equal(prime.found, true, prime.error)
    assert.equal(engine.found, true, engine.error)
    assert.equal(prime.mock, false)
    assert.equal(engine.mock, false)
  })

  await step('open saved sessions from both engines in the same workspace', async () => {
    const engine = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'pi',
        model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`,
        thinking: 'off',
        name: PI_SESSION_NAME
      }
    })
    piAgentId = engine.agentId
    await assert.rejects(stat(fixture.sessionDirectory), { code: 'ENOENT' })
    const prime = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: PRIME_SESSION_NAME
      }
    })
    primeAgentId = prime.agentId
    const agents = await application.invoke('engine:list')
    assert.equal(agents.find((agent) => agent.agentId === piAgentId)?.engine, 'pi')
    assert.equal(agents.find((agent) => agent.agentId === primeAgentId)?.engine, 'prime')
  })

  await checks.check('Engine2 model picker and thinking controls use its own catalog', async () => {
    await application.page.getByRole('button', { name: /^Model:/ }).click()
    await application.page.getByRole('option', { name: /Engine2 QA Small/ }).click()
    await until(
      async () =>
        (await application.rpc({ type: 'get_state' }, primeAgentId)).model?.id ===
        PRIME_MODELS.small,
      'Engine2 model selection'
    )
    await application.page.getByRole('button', { name: /^Thinking level:/ }).click()
    await application.page.getByRole('menuitemradio', { name: /^High/ }).click()
    await until(
      async () =>
        (await application.rpc({ type: 'get_state' }, primeAgentId)).thinkingLevel === 'high',
      'Engine2 thinking level'
    )
    const engineState = await application.rpc({ type: 'get_state' }, piAgentId)
    assert.equal(engineState.model.id, FAKE_MODELS.reasoning)
    assert.equal(engineState.thinkingLevel, 'off')
  })

  await step('both backends stream concurrently without sharing transcript events', async () => {
    const streamOptions = { chunkSize: STREAM_CHUNK_SIZE, delayMs: STREAM_DELAY_MS }
    fixture.piServer.queue(turn.text('The first Engine runs independently.', streamOptions))
    fixture.primeServer.queue(
      turn.thinking('Inspecting the isolated workspace.', 'Engine2 streamed reply.', streamOptions)
    )
    await Promise.all([
      application.rpc({ type: 'prompt', message: 'Engine concurrency probe' }, piAgentId),
      application.rpc({ type: 'prompt', message: 'Engine2 concurrency probe' }, primeAgentId)
    ])
    await until(async () => {
      const engine = await application.agentState(piAgentId)
      const prime = await application.agentState(primeAgentId)
      return engine.phase === 'running' && prime.phase === 'running'
    }, 'simultaneous streaming')
    await application.screenshot('engines-concurrent-streaming')
    await application.waitForSettle()
    await until(
      async () => (await application.agentState(piAgentId)).phase === 'idle',
      'first Engine idle'
    )
    const engineText = assistantText(await application.agentState(piAgentId))
    const primeText = assistantText(await application.agentState(primeAgentId))
    assert.ok(engineText.includes('The first Engine runs independently.'))
    assert.ok(primeText.includes('Engine2 streamed reply.'))
    assert.ok(!engineText.includes('Engine2 streamed reply.'))
    assert.ok(!primeText.includes('The first Engine runs independently.'))
    assert.equal(inspectRequest(fixture.piServer.requests[0]).model, FAKE_MODELS.reasoning)
    const nativeRequest = inspectRequest(fixture.primeServer.requests[0])
    assert.equal(nativeRequest.model, (await application.rpc({ type: 'get_state' })).model.id)
    primeSessionFile = (await application.rpc({ type: 'get_state' })).sessionFile
    assert.ok(primeSessionFile, 'Engine2 saved session path')
    assert.ok(samePath(dirname(primeSessionFile), fixture.sessionDirectory))
    const entries = (await readFile(primeSessionFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.ok(entries.some((entry) => entry.message?.role === 'user'))
    assert.ok(entries.some((entry) => entry.message?.role === 'assistant'))
  })

  await checks.check(
    'Engine2 native Python tool output reaches its public transcript',
    async () => {
      const toolId = 'engine2-python-output'
      const from = fixture.primeServer.requests.length
      const toolName = inspectRequest(fixture.primeServer.requests[0]).tools.find(
        (name) => name === 'ipython' || name === 'python'
      )
      assert.ok(toolName, 'the native model exposes its Python runtime tool')
      fixture.primeServer.queue(
        turn.toolCalls([
          {
            id: toolId,
            name: toolName,
            args: {
              code: 'print("Engine2 tool output")'
            }
          }
        ]),
        turn.text('The native tool finished.')
      )
      await application.send('Run the short native tool probe')
      await application.waitForSettle()
      const nextRequest = await fixture.primeServer.waitForRequest(
        (request) =>
          inspectRequest(request).toolResults.some((result) => result.toolCallId === toolId),
        { from }
      )
      const result = inspectRequest(nextRequest).toolResults.find(
        (item) => item.toolCallId === toolId
      )
      assert.notEqual(result.isError, true, result.text)
      assert.ok(result.text.includes('Engine2 tool output'), result.text)
      const tool = (await application.agentState()).tools[toolId]
      assert.equal(tool.status, 'done')
      await application.screenshot('engine2-native-tool')
    }
  )

  await checks.check('Engine2 queues follow-ups and aborts a live provider request', async () => {
    const from = fixture.primeServer.requests.length
    fixture.primeServer.queue(
      turn.text('Engine2 streams while a follow-up is queued.', {
        chunkSize: STREAM_CHUNK_SIZE,
        delayMs: STREAM_DELAY_MS
      }),
      turn.text('Engine2 delivered the queued follow-up.')
    )
    await application.send('Stream for the queue probe')
    const composer = await application.composer()
    await composer.fill('Engine2 follow-up probe')
    await composer.press('Alt+Enter')
    await until(
      async () =>
        (await application.agentState()).queue.followUp.includes('Engine2 follow-up probe'),
      'Engine2 follow-up queue'
    )
    await application.screenshot('engine2-follow-up-queue')
    await application.waitForSettle()
    const queuedRequest = await fixture.primeServer.waitForRequest(
      (request) => inspectRequest(request).lastUserText === 'Engine2 follow-up probe',
      { from }
    )
    assert.equal(queuedRequest.outcome, 'completed')

    const abortFrom = fixture.primeServer.requests.length
    fixture.primeServer.queue(turn.hang({ text: 'Engine2 partial answer before stop' }))
    await application.send('Stream until stopped')
    const hangingRequest = await fixture.primeServer.waitForRequest(undefined, { from: abortFrom })
    await application.page.getByText('Engine2 partial answer before stop').waitFor()
    await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
    assert.equal(await fixture.primeServer.waitForOutcome(hangingRequest), 'aborted')
    await application.waitForSettle()
    assert.equal(fixture.primeServer.requests.length - abortFrom, 1)
  })

  await checkEngineConfiguration(application, fixture, workspace, primeAgentId, checks.check)

  await checks.check('changing the workspace engine preserves open-session ownership', async () => {
    await setWorkspaceEngine(application, 'Engine')
    const prime = (await application.invoke('engine:list')).find(
      (agent) => agent.agentId === primeAgentId
    )
    assert.equal(prime.engine, 'prime')
    const state = await application.appState()
    assert.equal(state.prefs.workspaces.find((item) => samePath(item.path, workspace)).engine, 'pi')
    await activateSession(application, PI_SESSION_NAME)
    assert.equal(await application.activeAgentId(), piAgentId)
    assert.equal((await application.rpc({ type: 'get_state' })).model.provider, FAKE_PROVIDER)
    await activateSession(application, PRIME_SESSION_NAME)
    assert.equal(await application.activeAgentId(), primeAgentId)
    assert.equal((await application.rpc({ type: 'get_state' })).model.provider, PRIME_PROVIDER)
    await setWorkspaceEngine(application, 'Engine 2')
    await application.screenshot('engines-workspace-selection')
  })

  await checks.check(
    'saved session lists and identity resolution keep backends separate',
    async () => {
      const piSessions = await application.invoke('sessions:list', { cwd: workspace, engine: 'pi' })
      const primeSessions = await application.invoke('sessions:list', {
        cwd: workspace,
        engine: 'prime'
      })
      assert.ok(primeSessions.sessions.some((session) => samePath(session.path, primeSessionFile)))
      assert.ok(piSessions.sessions.every((session) => session.engine !== 'prime'))
      assert.ok(primeSessions.sessions.every((session) => session.engine === 'prime'))
      assert.ok(!piSessions.sessions.some((session) => samePath(session.path, primeSessionFile)))
      const identity = await application.invoke('sessions:describe', primeSessionFile)
      assert.equal(identity.engine, 'prime')
      assert.ok(samePath(identity.cwd, workspace))
    }
  )

  await checks.check(
    'Engine2 restart attaches the saved resident without duplicating it',
    async () => {
      const before = await application.rpc({ type: 'get_state' }, primeAgentId)
      const rosterBefore = await application.invoke('engine:background-list', 'prime')
      await application.invoke('engine:restart', primeAgentId, undefined)
      await until(
        async () => (await application.agentState(primeAgentId)).status === 'ready',
        'Engine2 restarted'
      )
      const after = await application.rpc({ type: 'get_state' }, primeAgentId)
      const rosterAfter = await application.invoke('engine:background-list', 'prime')
      assert.ok(samePath(after.sessionFile, before.sessionFile))
      assert.equal(after.sessionId, before.sessionId)
      assert.equal(after.messageCount, before.messageCount)
      assert.deepEqual(
        rosterAfter.map((session) => session.id).sort(),
        rosterBefore.map((session) => session.id).sort()
      )
    }
  )

  await checks.check(
    'Engine2 exports JSONL and HTML and imports a separate saved session',
    async () => {
      const jsonlPath = fixture.root.path('exported-engine2.jsonl')
      const htmlPath = fixture.root.path('exported-engine2.html')
      for (const [format, outputPath] of [
        ['jsonl', jsonlPath],
        ['html', htmlPath]
      ]) {
        const exported = await application.invoke('sessions:export', {
          engine: 'prime',
          agentId: primeAgentId,
          sessionPath: primeSessionFile,
          format,
          outputPath,
          title: PRIME_SESSION_NAME
        })
        assert.ok(samePath(exported.path, outputPath))
        const text = await readFile(outputPath, 'utf8')
        const embeddedData =
          format === 'html' ? /id="session-data"[^>]*>([^<]+)<\/script>/.exec(text)?.[1] : undefined
        const conversation = embeddedData
          ? Buffer.from(embeddedData, 'base64').toString('utf8')
          : text
        assert.ok(
          conversation.includes('Engine2 concurrency probe'),
          `${format} includes the conversation`
        )
      }
      const candidate = await application.invoke('sessions:inspect-import', {
        engine: 'prime',
        cwd: workspace,
        sourcePath: jsonlPath
      })
      assert.equal(candidate.engine, 'prime')
      assert.ok(candidate.messageCount > 0)
      const imported = await application.invoke('sessions:import', {
        engine: 'prime',
        sourcePath: jsonlPath,
        fallbackCwd: workspace
      })
      assert.equal(imported.engine, 'prime')
      importedSessionFile = imported.path
      assert.ok(
        !samePath(imported.path, primeSessionFile),
        'import receives a separate saved identity'
      )
      const identity = await application.invoke('sessions:describe', imported.path)
      assert.equal(identity.engine, 'prime')
    }
  )

  await checks.check(
    'Engine2 restart applies changed launch configuration to the runtime',
    async () => {
      const before = await application.rpc({ type: 'get_state' }, primeAgentId)
      await application.invoke('engine:restart', primeAgentId, {
        thinking: 'low',
        launch: { prime: { systemPrompt: RESTART_SYSTEM_PROMPT } }
      })
      await until(
        async () => (await application.agentState(primeAgentId)).status === 'ready',
        'configured Engine2 restarted'
      )
      const after = await application.rpc({ type: 'get_state' }, primeAgentId)
      const prompt = await nativeCommand(application, primeAgentId, 'get_system_prompt')
      assert.equal(after.sessionId, before.sessionId)
      assert.ok(samePath(after.sessionFile, before.sessionFile))
      assert.equal(after.thinkingLevel, 'low')
      assert.ok(
        prompt.systemPrompt.includes(RESTART_SYSTEM_PROMPT),
        'new launch prompt reached the runtime'
      )
      assert.equal(
        (await application.invoke('engine:background-list', 'prime')).filter((item) =>
          samePath(item.sessionPath, primeSessionFile)
        ).length,
        1
      )
    }
  )

  await checks.check(
    'Engine2 tree labels and branch files use native session operations',
    async () => {
      const tree = await application.rpc({ type: 'get_tree' }, primeAgentId)
      assert.ok(tree.nodes.length > 0)
      assert.ok(tree.leafId)
      await application.invoke(
        'engine:bridge',
        primeAgentId,
        {
          op: 'label',
          entryId: tree.leafId,
          label: 'Engine2 branch marker'
        },
        undefined
      )
      const labeled = await application.rpc({ type: 'get_tree' }, primeAgentId)
      assert.equal(
        labeled.nodes.find((node) => node.entry.id === tree.leafId).label,
        'Engine2 branch marker'
      )
      assert.ok(importedSessionFile, 'an imported closed session is available for branching')
      const importedTree = await application.invoke('sessions:tree', importedSessionFile)
      const branchPath = await application.invoke('sessions:branch', {
        engine: 'prime',
        sessionPath: importedSessionFile,
        entryId: importedTree.leafId
      })
      assert.ok(!samePath(branchPath, primeSessionFile))
      const branchIdentity = await application.invoke('sessions:describe', branchPath)
      assert.equal(branchIdentity.engine, 'prime')
      const branchTree = await application.invoke('sessions:tree', branchPath)
      assert.ok(branchTree.nodes.length > 0)
    }
  )

  await checks.check(
    'branching an attached resident leaves its saved identity intact',
    async () => {
      const before = await application.rpc({ type: 'get_state' }, primeAgentId)
      const sourceBefore = await readFile(primeSessionFile, 'utf8')
      const tree = await application.rpc({ type: 'get_tree' }, primeAgentId)
      const branched = await application.invoke('sessions:branch', {
        engine: 'prime',
        sessionPath: primeSessionFile,
        entryId: tree.leafId
      })
      assert.ok(!samePath(branched, primeSessionFile))
      const after = await application.rpc({ type: 'get_state' }, primeAgentId)
      assert.ok(samePath(after.sessionFile, before.sessionFile))
      assert.equal(after.sessionId, before.sessionId)
      assert.equal(after.messageCount, before.messageCount)
      assert.equal(await readFile(primeSessionFile, 'utf8'), sourceBefore)
      const branchHeader = JSON.parse((await readFile(branched, 'utf8')).split('\n')[0])
      assert.ok(samePath(branchHeader.parentSession, primeSessionFile))
    }
  )

  await checks.check(
    'readonly native runtime queries and diagnostics return actual data',
    async () => {
      for (const command of [
        'get_context_tree',
        'get_system_prompt',
        'get_rlm_children',
        'get_rlm_max_depth_status'
      ]) {
        const response = await nativeCommand(application, primeAgentId, command)
        assert.equal(typeof response, 'object', `${command} response`)
        assert.ok(response)
      }
      const stderr = await application.invoke('engine:stderr', primeAgentId)
      assert.equal(typeof stderr, 'string')
      const mcp = await engineSettings(application, 'prime', 'settings:mcp', workspace)
      assert.ok(Array.isArray(mcp.servers))
      await application.page.getByRole('button', { name: 'Controls', exact: true }).click()
      await application.page.getByRole('tab', { name: 'Context', exact: true }).click()
      await application.screenshot('engine2-native-context')
      await application.page.keyboard.press('Escape')
    }
  )

  await checkSavedSidebar(
    application,
    PRIME_SESSION_NAME,
    piAgentId,
    importedSessionFile,
    checks.check
  )
  await checkRestartPeer(
    application,
    fixture.primeServer,
    workspace,
    primeAgentId,
    PRIME_SESSION_NAME,
    checks.check
  )

  await checks.check(
    'Engine2 native schedules create, pause, resume and cancel through IPC',
    async () => {
      await nativeCommand(application, primeAgentId, 'heartbeat_set', {
        schedule: 'every 1h',
        prompt: 'Engine2 heartbeat probe',
        deliveryMode: 'follow_up'
      })
      const heartbeat = await nativeCommand(application, primeAgentId, 'heartbeat_get')
      assert.equal(heartbeat.heartbeat.prompt, 'Engine2 heartbeat probe')
      await nativeCommand(application, primeAgentId, 'heartbeat_update', { action: 'pause' })
      assert.equal(
        (await nativeCommand(application, primeAgentId, 'heartbeat_get')).heartbeat.status,
        'paused'
      )
      await nativeCommand(application, primeAgentId, 'heartbeat_update', { action: 'resume' })
      assert.equal(
        (await nativeCommand(application, primeAgentId, 'heartbeat_get')).heartbeat.status,
        'active'
      )
      await application.page.getByRole('button', { name: 'Controls', exact: true }).click()
      await application.page.getByRole('tab', { name: 'Schedule', exact: true }).click()
      await application.page.getByText('Engine2 heartbeat probe', { exact: true }).waitFor()
      await application.page
        .getByText('Engine2 heartbeat probe', { exact: true })
        .scrollIntoViewIfNeeded()
      await application.screenshot('engine2-native-schedule')
      await application.page.keyboard.press('Escape')
      await nativeCommand(application, primeAgentId, 'heartbeat_update', { action: 'clear' })
      const scheduled = await nativeCommand(application, primeAgentId, 'cron_add', {
        schedule: 'every 1h',
        prompt: 'Engine2 cron probe'
      })
      const jobs = (
        await nativeCommand(application, primeAgentId, 'cron_list', { includeInactive: true })
      ).jobs
      const job = jobs.find((item) => item.prompt === 'Engine2 cron probe')
      assert.ok(job, JSON.stringify(scheduled))
      await nativeCommand(application, primeAgentId, 'cron_cancel', { jobId: job.id })
      const after = await nativeCommand(application, primeAgentId, 'cron_list', {
        includeInactive: true
      })
      assert.ok(after.jobs.every((item) => item.id !== job.id || item.status !== 'active'))
    }
  )

  await checkNativeControls(application, fixture.primeServer, primeAgentId, checks.check)

  await checks.check(
    'temporary Engine2 restart is refused and repeated sessions release their workers',
    async () => {
      for (let index = 0; index < EPHEMERAL_RUNS; index++) {
        const name = `Engine2 ephemeral cleanup ${index + 1}`
        const ephemeral = await application.openWorkspace({
          cwd: workspace,
          args: {
            engine: 'prime',
            noSession: true,
            provider: PRIME_PROVIDER,
            model: PRIME_MODELS.reasoning,
            name
          }
        })
        fixture.primeServer.queue(turn.text('Ephemeral Engine2 answer.'))
        await application.send('Reply briefly for the ephemeral cleanup probe')
        await application.waitForSettle()
        const info = (await application.invoke('engine:list')).find(
          (agent) => agent.agentId === ephemeral.agentId
        )
        assert.ok(info.pid, 'the public engine descriptor reports its worker')
        if (index === 0) {
          const messagesBefore = await application.rpc({ type: 'get_messages' }, ephemeral.agentId)
          await assert.rejects(
            application.invoke('engine:restart', ephemeral.agentId, {
              launch: { prime: { systemPrompt: 'Temporary restart must be refused.' } }
            }),
            /Temporary conversations with messages cannot be restarted safely/i
          )
          const unchanged = (await application.invoke('engine:list')).find(
            (agent) => agent.agentId === ephemeral.agentId
          )
          assert.equal(unchanged.nativeAgentId, info.nativeAgentId)
          assert.equal(unchanged.pid, info.pid)
          assert.ok(isAlive(info.pid), 'rejected restart leaves its temporary worker alive')
          assert.deepEqual(
            await application.rpc({ type: 'get_messages' }, ephemeral.agentId),
            messagesBefore
          )
          fixture.primeServer.queue(turn.text('Temporary worker remains usable.'))
          await application.send('Reply after the refused temporary restart')
          await application.waitForSettle()
          assert.ok(assistantText(await application.agentState()).includes('remains usable'))
        }
        const row = application.page
          .locator('section[aria-label="Open sessions"]')
          .locator('[data-session-row]', { hasText: name })
        await row.hover()
        await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
        await until(
          async () =>
            !(await application.invoke('engine:list')).some(
              (agent) => agent.agentId === ephemeral.agentId
            ),
          'ephemeral session disposed'
        )
        await until(() => !isAlive(info.pid), 'ephemeral native worker stopped')
        assert.ok(
          !(await application.invoke('engine:background-list', 'prime')).some(
            (agent) => agent.id === info.nativeAgentId
          )
        )
      }
      await activateSession(application, PRIME_SESSION_NAME)
    }
  )

  await checks.check(
    'unsupported Engine2 slash commands retain the draft without a model request',
    async () => {
      const from = fixture.primeServer.requests.length
      const composer = await application.composer()
      await composer.fill('/bug')
      await composer.press('Enter')
      await application.page.getByText('/bug is unavailable in Engine 2').waitFor()
      assert.equal(await composer.inputValue(), '/bug')
      assert.equal(fixture.primeServer.requests.length, from)
      await composer.fill('')
    }
  )

  await checkResidentReattach(
    application,
    fixture.primeServer,
    {
      agentId: primeAgentId,
      name: PRIME_SESSION_NAME,
      sessionFile: primeSessionFile,
      historyText: 'Engine2 streamed reply.',
      onRelaunch: (nextApplication) => {
        application = nextApplication
      }
    },
    checks.check
  )

  await checks.check('no uncaught app errors across both engines', async () => {
    application.assertNoErrors()
  })
  checks.finish()
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
