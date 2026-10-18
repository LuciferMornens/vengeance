import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { turn } from '../qa/lib/fake-llm.mjs'

const require = createRequire(import.meta.url)
const raceTimeoutMilliseconds = 10_000

async function bounded(promise, description) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          raceTimeoutMilliseconds
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitUntil(condition, description) {
  const deadline = Date.now() + raceTimeoutMilliseconds
  const pollIntervalMilliseconds = 20
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMilliseconds))
  }
}

export async function childRecoverEnvironment(
  bundlePath,
  agentDirectory,
  nativeAgentId,
  marker,
  executablePath
) {
  const { connectPrimeResident } = require(bundlePath)
  const resident = await connectPrimeResident(
    { nativeAgentId },
    { executablePath, agentDir: agentDirectory }
  )
  assert.ok(resident)
  try {
    assert.equal(resident.client.launchEnvironmentKnown, true)
    assert.equal(resident.client.launchEnv.VENGEANCE_QA_ENV_MARKER, marker)
    const state = await resident.client.request('get_state', { activeSessionId: nativeAgentId })
    assert.ok(state.sessionFile)
    console.log('encrypted environment recovered across Node processes')
  } finally {
    resident.client.close()
  }
}

export async function runPrimeRestartIsolationQa({
  PrimeEngineProcess,
  probePrimeDaemon,
  fakeLlm,
  bundlePath,
  restartRoot,
  workspaceDirectory,
  executablePath,
  newEngine,
  writeModelConfig,
  assistantText,
  runQaChild,
  liveRoster,
  shutdownQaDaemon
}) {
  await goalPauseAndQueueAbort()
  await temporaryRestartRefusal()
  await encryptedEnvironmentRecovery()
  await liveSelectionRestartRecovery()

  async function liveSelectionRestartRecovery() {
    const { restartPrimeSession, connectPrimeResident } = require(bundlePath)
    const agentDirectory = path.join(restartRoot, 'live-selection-agent')
    await mkdir(agentDirectory, { recursive: true })
    await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl)
    const modelsPath = path.join(agentDirectory, 'models.json')
    const models = JSON.parse(await readFile(modelsPath, 'utf8'))
    models.providers['battery-peer'] = {
      ...models.providers.battery,
      headers: { 'X-QA-Restart-Provider': 'peer' }
    }
    await writeFile(modelsPath, JSON.stringify(models))
    const initial = { provider: 'battery', model: 'mock-2', thinking: 'low' }
    const handles = []
    const open = async (args) => {
      const handle = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, args)
      handles.push(handle)
      await handle.start()
      return handle
    }
    const switchLive = async (handle) => {
      const switched = await handle.send({
        type: 'set_model',
        provider: 'battery-peer',
        modelId: 'mock-2'
      })
      assert.equal(switched.success, true, switched.error)
      const thought = await handle.send({ type: 'set_thinking_level', level: 'high' })
      assert.equal(thought.success, true, thought.error)
    }
    const assertSelection = async (handle, expected, prompt) => {
      const state = await handle.nativeCommand('get_state')
      assert.equal(state.model.provider, expected.provider)
      assert.equal(state.model.id, expected.model)
      assert.equal(state.thinkingLevel, expected.thinking)
      const from = fakeLlm.requests.length
      fakeLlm.queue(turn.text('The selected provider remains available.'))
      await handle.nativeCommand('prompt_and_wait', { message: prompt })
      const request = await fakeLlm.waitForRequest(undefined, { from })
      assert.equal(request.body.model, expected.model)
      assert.equal(request.body.reasoning_effort, expected.thinking)
      assert.equal(
        request.headers['x-qa-restart-provider'],
        expected.provider === 'battery-peer' ? 'peer' : undefined
      )
    }
    const live = { provider: 'battery-peer', model: 'mock-2', thinking: 'high' }
    try {
      const primary = await open(initial)
      const peer = await open(initial)
      const primaryId = primary.nativeAgentId
      const peerId = peer.nativeAgentId
      await assertSelection(primary, initial, 'Remember target selection history')
      await assertSelection(peer, initial, 'Remember peer selection history')
      await switchLive(primary)
      await switchLive(peer)
      const primaryHistory = await primary.nativeCommand('get_messages')
      const peerHistory = await peer.nativeCommand('get_messages')
      const before = await liveRoster(probePrimeDaemon, agentDirectory)
      const carried = await primary.prepareRestart(
        { ...initial, cwd: workspaceDirectory, engine: 'prime' },
        executablePath,
        {}
      )
      assert.ok(carried)
      const restored = await open({ ...carried, nativeAgentId: primaryId })
      const restoredPeer = await open({ ...initial, nativeAgentId: peerId })
      const after = await liveRoster(probePrimeDaemon, agentDirectory)
      for (const id of [primaryId, peerId]) {
        assert.notEqual(
          after.find((row) => row.id === id).workerPid,
          before.find((row) => row.id === id).workerPid
        )
      }
      assert.deepEqual(await restored.nativeCommand('get_messages'), primaryHistory)
      assert.deepEqual(await restoredPeer.nativeCommand('get_messages'), peerHistory)
      await assertSelection(restored, live, 'Target uses its live selection after restart')
      await assertSelection(restoredPeer, live, 'Peer uses its live selection after restart')
      const reset = await restored.prepareRestart(
        { ...initial, cwd: workspaceDirectory, engine: 'prime' },
        executablePath,
        initial
      )
      assert.ok(reset)
      const resetTarget = await open({ ...reset, nativeAgentId: primaryId })
      const resetPeer = await open({ ...initial, nativeAgentId: peerId })
      await assertSelection(resetTarget, initial, 'Explicit reset selects the initial provider')
      await assertSelection(resetPeer, live, 'Peer keeps its provider through target reset')
      const external = await connectPrimeResident(
        { nativeAgentId: primaryId },
        {
          executablePath,
          agentDir: agentDirectory
        }
      )
      assert.ok(external)
      try {
        const initialArgs = { ...initial, engine: 'prime', cwd: workspaceDirectory }
        const change = restartPrimeSession(
          external.client,
          primaryId,
          initialArgs,
          { ...initialArgs, ...live },
          executablePath,
          live
        )
        const restore = restartPrimeSession(
          external.client,
          primaryId,
          initialArgs,
          initialArgs,
          executablePath,
          initial
        )
        await Promise.all([change, restore])
      } finally {
        external.client.close()
      }
      const forcedTarget = await open({ ...initial, nativeAgentId: primaryId })
      await assertSelection(
        forcedTarget,
        initial,
        'Explicit values override a live change made by an earlier queued restart'
      )
      await switchLive(forcedTarget)
      const rollbackTargetHistory = await forcedTarget.nativeCommand('get_messages')
      const rollbackPeerHistory = await resetPeer.nativeCommand('get_messages')
      await assert.rejects(
        forcedTarget.prepareRestart(
          {
            ...initial,
            cwd: workspaceDirectory,
            engine: 'prime',
            launch: { prime: { systemPrompt: 'Rejected successor prompt' } }
          },
          process.execPath,
          {}
        ),
        /previous engine and launch configuration were restored/i
      )
      const recoveredTarget = await open({ ...initial, nativeAgentId: primaryId })
      const recoveredPeer = await open({ ...initial, nativeAgentId: peerId })
      assert.deepEqual(await recoveredTarget.nativeCommand('get_messages'), rollbackTargetHistory)
      assert.deepEqual(await recoveredPeer.nativeCommand('get_messages'), rollbackPeerHistory)
      assert.ok(
        !(await recoveredTarget.nativeCommand('get_system_prompt')).systemPrompt.includes(
          'Rejected successor prompt'
        )
      )
      await assertSelection(
        recoveredTarget,
        live,
        'Rollback target uses its captured live provider'
      )
      await assertSelection(recoveredPeer, live, 'Rollback peer uses its captured live provider')
      console.log(
        'restart live selections: target, same-ID peer, explicit reset and failed-successor rollback passed'
      )
    } finally {
      for (const handle of handles.reverse()) await handle.stop().catch(() => {})
      await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
    }
  }

  async function goalPauseAndQueueAbort() {
    const agentDirectory = path.join(restartRoot, 'goal-pause-agent')
    const goalWorkspace = path.join(restartRoot, 'goal-pause-workspace')
    await Promise.all([
      mkdir(agentDirectory, { recursive: true }),
      mkdir(goalWorkspace, { recursive: true })
    ])
    await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl)
    const handle = newEngine(PrimeEngineProcess, agentDirectory, goalWorkspace)
    const events = []
    handle.on('event', (event) => events.push(event))
    try {
      await handle.start()
      for (let attempt = 1; attempt <= 3; attempt++) {
        fakeLlm.queue(turn.hang({ text: 'goal continuation', chunkSize: 1, delayMs: 30 }))
        const requestsBeforeGoal = fakeLlm.requests.length
        const started = await handle.send({
          type: 'prompt',
          message: `/goal Finish test objective ${attempt}`
        })
        assert.equal(started.success, true, started.error)
        const providerRequest = await bounded(
          fakeLlm.waitForRequest(() => true, { from: requestsBeforeGoal }),
          'goal provider request'
        )
        await waitUntil(() => providerRequest.outcome === 'streaming', 'streaming goal response')
        const stopped = await bounded(handle.send({ type: 'abort' }), 'common abort')
        assert.equal(stopped.success, true, stopped.error)
        await bounded(
          handle.nativeCommand('prompt_and_wait', { message: '/goal pause' }),
          'native goal pause'
        )
        await bounded(fakeLlm.waitForOutcome(providerRequest), 'aborted goal response')
        assert.equal(providerRequest.outcome, 'aborted')
        assert.equal((await handle.nativeCommand('get_state')).goal.status, 'paused')
        await bounded(
          handle.nativeCommand('prompt_and_wait', { message: '/goal clear' }),
          'native goal clear'
        )
      }
      console.log('goal pause race: three aborted continuations paused within the deadline')

      assert.equal(fakeLlm.pending(), 0)
      fakeLlm.setFallback(turn.hang({ text: 'early goal continuation', chunkSize: 1 }))
      try {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const requestsBeforeGoal = fakeLlm.requests.length
          const started = await handle.send({
            type: 'prompt',
            message: `/goal Immediately pause objective ${attempt}`
          })
          assert.equal(started.success, true, started.error)
          const stopped = await bounded(handle.send({ type: 'abort' }), 'early common abort')
          assert.equal(stopped.success, true, stopped.error)
          await bounded(
            handle.nativeCommand('prompt_and_wait', { message: '/goal pause' }),
            'early native goal pause'
          )
          assert.equal((await handle.nativeCommand('get_state')).goal.status, 'paused')
          await new Promise((resolve) => setTimeout(resolve, 150))
          const providerRequests = fakeLlm.requests
            .slice(requestsBeforeGoal)
            .filter((request) => request.api)
          for (const request of providerRequests) {
            await bounded(fakeLlm.waitForOutcome(request), 'early goal request abort')
            assert.equal(request.outcome, 'aborted')
          }
          await bounded(
            handle.nativeCommand('prompt_and_wait', { message: '/goal clear' }),
            'early native goal clear'
          )
        }
      } finally {
        fakeLlm.setFallback(turn.text('ok'))
      }
      console.log('goal admission race: three immediate aborts paused before model work resumed')

      fakeLlm.queue(turn.hang({ text: 'ordinary response', chunkSize: 1, delayMs: 30 }))
      const requestsBeforeQueue = fakeLlm.requests.length
      const started = await handle.send({ type: 'prompt', message: 'Start ordinary stream' })
      assert.equal(started.success, true, started.error)
      const providerRequest = await bounded(
        fakeLlm.waitForRequest(() => true, { from: requestsBeforeQueue }),
        'ordinary provider request'
      )
      await waitUntil(() => providerRequest.outcome === 'streaming', 'ordinary stream')
      const parkedMessage = 'Parked user message after abort'
      const queued = await handle.send({ type: 'follow_up', message: parkedMessage })
      assert.equal(queued.success, true, queued.error)
      assert.ok(JSON.stringify(await handle.nativeCommand('get_queue')).includes(parkedMessage))
      const requestCount = fakeLlm.requests.length
      const eventCountBeforeAbort = events.length
      const stopped = await bounded(handle.send({ type: 'abort' }), 'queued-turn abort')
      assert.equal(stopped.success, true, stopped.error)
      await waitUntil(
        () =>
          events
            .slice(eventCountBeforeAbort)
            .some((event) => event.type === 'agent_settled' && event.aborted === true),
        'aborted agent_settled with parked queue'
      )
      await bounded(fakeLlm.waitForOutcome(providerRequest), 'aborted ordinary response')
      assert.equal(providerRequest.outcome, 'aborted')
      assert.ok(JSON.stringify(await handle.nativeCommand('get_queue')).includes(parkedMessage))
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(fakeLlm.requests.length, requestCount)
      console.log('abort queue: parked user row survives without starting another turn')
    } finally {
      await handle.stop().catch(() => {})
      await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
    }
  }

  async function temporaryRestartRefusal() {
    const agentDirectory = path.join(restartRoot, 'temporary-agent')
    await mkdir(agentDirectory, { recursive: true })
    await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl)
    const temporary = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      noSession: true
    })
    try {
      await temporary.start()
      fakeLlm.queue(turn.text('temporary history'))
      await temporary.nativeCommand('prompt_and_wait', { message: 'Remember temporary history' })
      const before = (await liveRoster(probePrimeDaemon, agentDirectory)).find(
        (session) => session.id === temporary.nativeAgentId
      )
      assert.ok(before?.workerPid)
      await assert.rejects(
        temporary.prepareRestart(
          {
            engine: 'prime',
            cwd: workspaceDirectory,
            provider: 'battery',
            model: 'mock-2',
            noSession: true
          },
          executablePath
        ),
        /Temporary sessions cannot be restarted/i
      )
      const after = (await liveRoster(probePrimeDaemon, agentDirectory)).find(
        (session) => session.id === temporary.nativeAgentId
      )
      assert.equal(after?.workerPid, before.workerPid)
      assert.ok(
        assistantText((await temporary.nativeCommand('get_messages')).messages).includes(
          'temporary history'
        )
      )
      console.log('restart refusal: temporary session keeps its live worker and messages')
    } finally {
      await temporary.stop().catch(() => {})
      await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
    }
  }

  async function encryptedEnvironmentRecovery() {
    const agentDirectory = path.join(restartRoot, 'encrypted-agent')
    const marker = `qa-environment-${process.pid}`
    const environment = { VENGEANCE_QA_ENV_MARKER: marker }
    await mkdir(agentDirectory, { recursive: true })
    await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl)
    const handle = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      launch: { env: environment }
    })
    try {
      await handle.start()
      const nativeAgentId = handle.nativeAgentId
      await handle.stop()
      const registry = await readFile(path.join(agentDirectory, 'vengeance-daemons.json'), 'utf8')
      assert.ok(!registry.includes(marker), 'saved daemon registry must not expose launch env')
      const output = await runQaChild([
        '--env-child',
        executablePath,
        bundlePath,
        agentDirectory,
        nativeAgentId,
        marker
      ])
      assert.match(output, /encrypted environment recovered/)
      console.log(output.trim())
    } finally {
      await handle.stop().catch(() => {})
      await shutdownQaDaemon(probePrimeDaemon, agentDirectory, environment)
    }
  }
}
