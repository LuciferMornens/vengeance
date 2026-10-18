import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { startFakeLlm, turn } from '../qa/lib/fake-llm.mjs'
import { executableName } from '../qa/lib/platform.mjs'
import { QA_TMP_ROOT } from '../qa/lib/tmp.mjs'
import { childRecoverEnvironment, runPrimeRestartIsolationQa } from './prime-restart-isolation.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..', '..')
const stagedRelease = path.join(repositoryRoot, '.engine-staging', 'bundled', 'prime')
const childMode = ['--reattach-child', '--env-child'].includes(process.argv[2])
const restartMode = process.argv.includes('--restart-qa')
const executablePath = path.resolve(
  (childMode ? process.argv[3] : restartMode ? undefined : process.argv[2]) ??
    path.join(stagedRelease, executableName('prime-agent'))
)
const require = createRequire(import.meta.url)
const timeoutMilliseconds = 30_000
const pollMilliseconds = 25

function isolateEnvironment(agentDirectory, temporaryRoot) {
  for (const name of Object.keys(process.env)) {
    if (/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete process.env[name]
  }
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDirectory
  process.env.PRIME_AGENT_KERNEL_VENV = path.join(temporaryRoot, 'kernel-venv')
  process.env.PYTHONPYCACHEPREFIX = path.join(temporaryRoot, 'pycache')
  delete process.env.PRIME_AGENT_KERNEL_PYTHON
  process.env.PI_PACKAGE_DIR = path.dirname(executablePath)
  process.env.PI_OFFLINE = '1'
}

async function eventually(condition, description) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const value = await condition()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, pollMilliseconds))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function assistantText(messages) {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
}

async function runQaChild(arguments_) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...arguments_], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let output = ''
  let errorOutput = ''
  child.stdout.on('data', (chunk) => (output += chunk.toString('utf8')))
  child.stderr.on('data', (chunk) => (errorOutput += chunk.toString('utf8')))
  const [exitCode] = await once(child, 'exit')
  assert.equal(exitCode, 0, errorOutput)
  return output
}

function newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, args = {}) {
  return new PrimeEngineProcess({
    args: {
      engine: 'prime',
      cwd: workspaceDirectory,
      provider: 'battery',
      model: 'mock-1',
      ...args
    },
    executablePath,
    agentDir: agentDirectory
  })
}

async function writeModelConfig(agentDirectory, baseUrl, sessionDirectory) {
  await writeFile(
    path.join(agentDirectory, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'battery',
      defaultModel: 'mock-1',
      ...(sessionDirectory ? { sessionDir: sessionDirectory } : {})
    })
  )
  await writeFile(
    path.join(agentDirectory, 'models.json'),
    JSON.stringify({
      providers: {
        battery: {
          api: 'openai-completions',
          baseUrl,
          apiKey: 'qa-local-only',
          models: [
            {
              id: 'mock-1',
              name: 'Mock 1',
              api: 'openai-completions',
              contextWindow: 128_000,
              maxTokens: 4096
            },
            {
              id: 'mock-2',
              name: 'Mock 2',
              api: 'openai-completions',
              reasoning: true,
              contextWindow: 128_000,
              maxTokens: 4096
            }
          ]
        }
      }
    })
  )
}

async function stopDuringStartup(
  PrimeEngineProcess,
  probePrimeDaemon,
  baseUrl,
  temporaryRoot,
  workspaceDirectory,
  waitForRegistry
) {
  const agentDirectory = path.join(
    temporaryRoot,
    waitForRegistry ? 'registry-stop-agent' : 'immediate-stop-agent'
  )
  await mkdir(agentDirectory, { recursive: true })
  await writeModelConfig(agentDirectory, baseUrl)
  const engine = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
    noSession: true
  })
  try {
    const startup = engine.start()
    if (waitForRegistry) {
      await eventually(async () => {
        try {
          await readFile(path.join(agentDirectory, 'vengeance-daemons.json'))
          return true
        } catch (error) {
          if (error.code === 'ENOENT') return false
          throw error
        }
      }, 'test daemon registry entry')
      assert.notEqual(engine.status, 'ready', 'stop must race startup, not an idle worker')
    }
    await Promise.all([startup, engine.stop()])
    assert.equal(engine.status, 'exited')
    const daemon = await probePrimeDaemon({ executablePath, agentDir: agentDirectory })
    try {
      if (daemon) {
        const roster = await daemon.request('list', {
          all: false,
          includeClientOwned: true
        })
        assert.equal((roster.sessions ?? roster.agents ?? []).length, 0)
      }
    } finally {
      daemon?.close()
    }
  } finally {
    await engine.stop().catch(() => {})
    await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
  }
}

async function liveRoster(probePrimeDaemon, agentDirectory, environment = {}) {
  const daemon = await probePrimeDaemon({
    executablePath,
    agentDir: agentDirectory,
    env: environment
  })
  assert.ok(daemon, 'test-owned Prime daemon must be running')
  try {
    const result = await daemon.request('list', { all: false, includeClientOwned: true })
    return result.sessions ?? result.agents ?? []
  } finally {
    daemon.close()
  }
}

async function shutdownQaDaemon(probePrimeDaemon, agentDirectory, environment = {}) {
  const daemon = await probePrimeDaemon({
    executablePath,
    agentDir: agentDirectory,
    env: environment
  })
  try {
    await daemon?.request('shutdown', { force: true })
  } finally {
    daemon?.close()
  }
}

async function runRestartQa(
  PrimeEngineProcess,
  probePrimeDaemon,
  connectPrimeResident,
  fakeLlm,
  bundlePath
) {
  // Beside the QA temp root: outside the profile and outside any git repository (qa/lib/tmp.mjs).
  const restartBase = `${QA_TMP_ROOT}-engine-performance`
  await mkdir(restartBase, { recursive: true })
  const restartRoot = await mkdtemp(path.join(restartBase, 'vengeance-prime-restart-'))
  const agentDirectory = path.join(restartRoot, 'agent')
  const sessionsDirectory = path.join(restartRoot, 'sessions')
  const workspaceDirectory = path.join(restartRoot, 'workspace')
  const siblingWorkspaceDirectory = path.join(restartRoot, 'sibling-workspace')
  const projectSettingsDirectory = path.join(siblingWorkspaceDirectory, '.prime', 'agent')
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(projectSettingsDirectory, { recursive: true })
  ])
  await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl, sessionsDirectory)
  await writeFile(
    path.join(projectSettingsDirectory, 'settings.json'),
    JSON.stringify({ compaction: { enabled: true } })
  )
  const handles = []
  let passed = false
  try {
    const previousArgs = {
      engine: 'prime',
      cwd: workspaceDirectory,
      provider: 'battery',
      model: 'mock-1',
      thinking: 'off',
      launch: { prime: { systemPrompt: 'Before restart system prompt' } }
    }
    const nextArgs = {
      ...previousArgs,
      model: 'mock-2',
      thinking: 'high',
      launch: { prime: { systemPrompt: 'After restart system prompt' } }
    }
    const primary = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, previousArgs)
    const sibling = newEngine(PrimeEngineProcess, agentDirectory, siblingWorkspaceDirectory, {
      ...previousArgs,
      cwd: siblingWorkspaceDirectory,
      launch: { prime: { systemPrompt: 'Sibling system prompt' } }
    })
    handles.push(primary, sibling)
    await primary.start()
    await sibling.start()
    const primaryId = primary.nativeAgentId
    const siblingId = sibling.nativeAgentId
    const firstPrompt = await primary.nativeCommand('get_system_prompt')
    assert.match(firstPrompt.systemPrompt, /Before restart system prompt/)
    fakeLlm.queue(turn.text('primary history'))
    await primary.nativeCommand('prompt_and_wait', { message: 'Remember primary history' })
    fakeLlm.queue(turn.text('sibling history'))
    await sibling.nativeCommand('prompt_and_wait', { message: 'Remember sibling history' })
    const before = await liveRoster(probePrimeDaemon, agentDirectory)
    const primaryBefore = before.find((session) => session.id === primaryId)
    const siblingBefore = before.find((session) => session.id === siblingId)
    assert.ok(primaryBefore?.workerPid)
    assert.ok(siblingBefore?.workerPid)
    console.log('restart setup: two idle residents with saved message history')

    fakeLlm.queue(turn.hang({ text: 'busy sibling', chunkSize: 1, delayMs: 30 }))
    const requestCountBeforeBusy = fakeLlm.requests.length
    const admitted = await sibling.send({ type: 'prompt', message: 'Stay busy for restart test' })
    assert.equal(admitted.success, true, admitted.error)
    const busyRequest = await fakeLlm.waitForRequest(() => true, {
      from: requestCountBeforeBusy
    })
    await assert.rejects(primary.prepareRestart(nextArgs, executablePath), /Wait until|busy/i)
    assert.equal(busyRequest.outcome, 'streaming')
    const duringBusy = await liveRoster(probePrimeDaemon, agentDirectory)
    assert.equal(
      duringBusy.find((session) => session.id === primaryId)?.workerPid,
      primaryBefore.workerPid
    )
    assert.equal(
      duringBusy.find((session) => session.id === siblingId)?.workerPid,
      siblingBefore.workerPid
    )
    await sibling.send({ type: 'abort' })
    await fakeLlm.waitForOutcome(busyRequest)
    assert.equal(busyRequest.outcome, 'aborted')
    await sibling.nativeCommand('wait_for_idle')
    console.log('restart refusal: busy sibling stream and worker PIDs stay intact')

    const goal = await sibling.send({ type: 'prompt', message: '/goal Preserve sibling objective' })
    assert.equal(goal.success, true, goal.error)
    const pauseGoal = await sibling.send({ type: 'prompt', message: '/goal pause' })
    assert.equal(pauseGoal.success, true, pauseGoal.error)
    await sibling.nativeCommand('wait_for_idle')
    const siblingGoal = (await sibling.nativeCommand('get_state')).goal
    const siblingQueue = await sibling.nativeCommand('get_queue')

    const changedEnvironment = {
      ...nextArgs,
      launch: { ...nextArgs.launch, env: { VENGEANCE_QA_RESTART_MARKER: 'changed' } }
    }
    await assert.rejects(
      primary.prepareRestart(changedEnvironment, executablePath),
      /shares its environment/i
    )
    const afterEnvironmentRefusal = await liveRoster(probePrimeDaemon, agentDirectory)
    assert.equal(
      afterEnvironmentRefusal.find((session) => session.id === siblingId)?.workerPid,
      siblingBefore.workerPid
    )
    console.log('restart refusal: shared environment remains unchanged')

    const sideQuestionId = 'restart-qa-side-question'
    const sideEvents = []
    sibling.on('event', (event) => sideEvents.push(event))
    fakeLlm.queue(turn.hang({ text: 'side answer', chunkSize: 1, delayMs: 30 }))
    const requestsBeforeQuestion = fakeLlm.requests.length
    await sibling.nativeCommand('start_side_question', {
      sideQuestionId,
      question: 'Answer this while the sibling stays idle'
    })
    const sideRequest = await fakeLlm.waitForRequest(() => true, {
      from: requestsBeforeQuestion
    })
    await assert.rejects(primary.prepareRestart(nextArgs, executablePath), /side questions/i)
    assert.equal(sideRequest.outcome, 'streaming')
    const duringQuestion = await liveRoster(probePrimeDaemon, agentDirectory)
    assert.equal(
      duringQuestion.find((session) => session.id === siblingId)?.workerPid,
      siblingBefore.workerPid
    )
    await sibling.nativeCommand('abort_side_question', { sideQuestionId })
    await fakeLlm.waitForOutcome(sideRequest)
    assert.equal(sideRequest.outcome, 'aborted')
    await eventually(
      () =>
        sideEvents.some(
          (event) =>
            event.type === 'engine_native_event' &&
            event.name === 'side_question_event' &&
            event.data.event?.id === sideQuestionId &&
            event.data.event?.status === 'cancelled'
        ),
      'cancelled native side question'
    )
    console.log('restart refusal: active side question stays live until explicitly aborted')

    const disconnected = await connectPrimeResident(
      { nativeAgentId: siblingId },
      { executablePath, agentDir: agentDirectory }
    )
    assert.ok(disconnected)
    disconnected.client.close()
    await assert.rejects(
      disconnected.client.request('start_side_question', {
        activeSessionId: siblingId,
        sideQuestionId: 'disconnected-side-question',
        question: 'This request must be rejected'
      }),
      /disconnected/i
    )
    console.log('restart guard: rejected disconnected side question does not block restart')

    const globalSettingsPath = path.join(agentDirectory, 'settings.json')
    const globalSettings = JSON.parse(await readFile(globalSettingsPath, 'utf8'))
    globalSettings.compaction = { enabled: false }
    await writeFile(globalSettingsPath, JSON.stringify(globalSettings))
    assert.equal((await primary.nativeCommand('get_state')).autoCompactionEnabled, true)
    assert.equal((await sibling.nativeCommand('get_state')).autoCompactionEnabled, true)

    await runPrimeRestartIsolationQa({
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
    })

    await primary.prepareRestart(nextArgs, executablePath)
    const after = await liveRoster(probePrimeDaemon, agentDirectory)
    assert.notEqual(
      after.find((session) => session.id === primaryId)?.workerPid,
      primaryBefore.workerPid
    )
    assert.notEqual(
      after.find((session) => session.id === siblingId)?.workerPid,
      siblingBefore.workerPid
    )
    const restoredPrimary = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      ...nextArgs,
      nativeAgentId: primaryId
    })
    const restoredSibling = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      ...previousArgs,
      cwd: siblingWorkspaceDirectory,
      nativeAgentId: siblingId
    })
    handles.push(restoredPrimary, restoredSibling)
    await restoredPrimary.start()
    await restoredSibling.start()
    const state = await restoredPrimary.nativeCommand('get_state')
    assert.equal(state.model.id, 'mock-2')
    assert.equal(state.thinkingLevel, 'high')
    assert.equal(state.autoCompactionEnabled, false)
    const systemPrompt = await restoredPrimary.nativeCommand('get_system_prompt')
    assert.match(systemPrompt.systemPrompt, /After restart system prompt/)
    assert.ok(
      assistantText((await restoredPrimary.nativeCommand('get_messages')).messages).includes(
        'primary history'
      )
    )
    assert.ok(
      assistantText((await restoredSibling.nativeCommand('get_messages')).messages).includes(
        'sibling history'
      )
    )
    assert.equal((await restoredSibling.nativeCommand('get_state')).autoCompactionEnabled, true)
    const restoredGoal = (await restoredSibling.nativeCommand('get_state')).goal
    assert.equal(restoredGoal.goalId, siblingGoal.goalId)
    assert.equal(restoredGoal.status, siblingGoal.status)
    assert.equal(restoredGoal.objective, siblingGoal.objective)
    assert.deepEqual(await restoredSibling.nativeCommand('get_queue'), siblingQueue)
    console.log('restart: both worker PIDs replaced; target config and sibling state survived')

    await assert.rejects(
      restoredPrimary.prepareRestart(nextArgs, process.execPath),
      /previous engine and launch configuration were restored/i
    )
    const rolledBack = await liveRoster(probePrimeDaemon, agentDirectory)
    assert.notEqual(
      rolledBack.find((session) => session.id === primaryId)?.workerPid,
      after.find((session) => session.id === primaryId)?.workerPid
    )
    assert.ok(
      assistantText((await restoredPrimary.nativeCommand('get_messages')).messages).includes(
        'primary history'
      )
    )
    assert.match(
      (await restoredPrimary.nativeCommand('get_system_prompt')).systemPrompt,
      /After restart system prompt/
    )
    console.log('restart rollback: rejected successor leaves history and configuration available')
    passed = true
  } finally {
    for (const handle of handles.reverse()) await handle.stop().catch(() => {})
    await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
    if (passed)
      await rm(restartRoot, {
        recursive: true,
        force: true,
        maxRetries: 30,
        retryDelay: 100
      })
    else console.error(`Restart QA retained ${restartRoot} for diagnosis`)
  }
}

async function childReattach(
  bundlePath,
  agentDirectory,
  workspaceDirectory,
  sessionFile,
  expectedId
) {
  const { PrimeEngineProcess } = require(bundlePath)
  const engine = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
    sessionPath: sessionFile
  })
  try {
    await engine.start()
    assert.equal(engine.nativeAgentId, expectedId)
    const response = await engine.send({ type: 'get_messages' })
    assert.equal(response.success, true, response.error)
    assert.ok(assistantText(response.data.messages).includes('recovered resident reply'))
    console.log('registry reattach: persisted messages recovered in a new Node process')
  } finally {
    await engine.stop().catch(() => {})
  }
}

if (childMode) {
  if (process.argv[2] === '--env-child') {
    const [bundlePath, agentDirectory, nativeAgentId, marker] = process.argv.slice(4)
    await childRecoverEnvironment(bundlePath, agentDirectory, nativeAgentId, marker, executablePath)
  } else {
    const [bundlePath, agentDirectory, workspaceDirectory, sessionFile, expectedId] =
      process.argv.slice(4)
    await childReattach(bundlePath, agentDirectory, workspaceDirectory, sessionFile, expectedId)
  }
} else {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vengeance-prime-adapter-'))
  const agentDirectory = path.join(temporaryRoot, 'agent')
  const workspaceDirectory = path.join(temporaryRoot, 'workspace')
  // Keep the bundle under the repository so Node resolves Electron's installed package.
  const bundlePath = path.join(
    repositoryRoot,
    '.engine-staging',
    'prime',
    `adapter-qa-${process.pid}.cjs`
  )
  const sessionsDirectory = path.join(temporaryRoot, 'configured-sessions')
  isolateEnvironment(agentDirectory, temporaryRoot)
  await Promise.all([
    mkdir(agentDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true })
  ])
  await build({
    stdin: {
      contents: [
        "export { PrimeEngineProcess } from './src/main/engine/prime/process'",
        "export { probePrimeDaemon, listPrimeBackground } from './src/main/engine/prime/daemon'",
        "export { connectPrimeResident } from './src/main/engine/prime/daemon'",
        "export { withPrimeServiceSession } from './src/main/engine/prime/daemon'",
        "export { restartPrimeSession } from './src/main/engine/prime/restart'",
        "export { listPrimeSessions } from './src/main/engine/prime/sessions'"
      ].join('\n'),
      resolveDir: repositoryRoot,
      sourcefile: 'prime-adapter-qa-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'isolated-electron',
        setup(bundle) {
          bundle.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'prime-qa'
          }))
          bundle.onLoad({ filter: /.*/, namespace: 'prime-qa' }, () => ({
            contents: `
              import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
              const encryptionKey = createHash('sha256').update('vengeance-prime-qa-only-key').digest()
              export const app = {
                isPackaged: false,
                getAppPath: () => ${JSON.stringify(repositoryRoot)},
                getPath: () => ${JSON.stringify(agentDirectory)}
              }
              export const safeStorage = {
                isEncryptionAvailable: () => true,
                encryptString(value) {
                  const nonce = randomBytes(12)
                  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
                  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
                  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted])
                },
                decryptString(value) {
                  const nonce = value.subarray(0, 12)
                  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce)
                  decipher.setAuthTag(value.subarray(12, 28))
                  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
                }
              }
              export const shell = {
                openExternal: async () => undefined,
                openPath: async () => ''
              }
            `,
            loader: 'js'
          }))
        }
      }
    ],
    tsconfig: path.join(repositoryRoot, 'tsconfig.node.json'),
    outfile: bundlePath
  })
  const {
    PrimeEngineProcess,
    probePrimeDaemon,
    connectPrimeResident,
    listPrimeBackground,
    withPrimeServiceSession,
    listPrimeSessions
  } = require(bundlePath)
  const fakeLlm = await startFakeLlm()
  await writeModelConfig(agentDirectory, fakeLlm.openaiBaseUrl, sessionsDirectory)

  const handles = []
  try {
    const first = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory)
    handles.push(first)
    await first.start()
    const firstState = await first.nativeCommand('get_state')
    assert.equal(path.dirname(firstState.sessionFile), sessionsDirectory)
    const toolsState = await first.bridge({ op: 'tools-get' })
    const pythonTool = toolsState.tools.find((tool) => tool.name === 'ipython')
    assert.ok(toolsState.active.includes('ipython'))
    assert.ok(pythonTool?.description.trim())
    console.log('tools bridge: native Python definition has a description')

    fakeLlm.queue(turn.hang({ text: 'partial answer', chunkSize: 1, delayMs: 30 }))
    const interrupted = await first.send({ type: 'prompt', message: 'Start a hanging answer' })
    assert.equal(interrupted.success, true, interrupted.error)
    const pendingRequest = await fakeLlm.waitForRequest()
    await eventually(() => pendingRequest.outcome === 'streaming', 'streaming fake response')
    const aborted = await first.send({ type: 'abort' })
    assert.equal(aborted.success, true, aborted.error)
    await fakeLlm.waitForOutcome(pendingRequest)
    assert.equal(pendingRequest.outcome, 'aborted')

    fakeLlm.queue(turn.text('common prompt recovered'))
    const recoveredPrompt = await first.send({ type: 'prompt', message: 'Recover normally' })
    assert.equal(recoveredPrompt.success, true, recoveredPrompt.error)
    await first.nativeCommand('wait_for_idle')
    fakeLlm.queue(turn.text('native prompt recovered'))
    await first.nativeCommand('prompt_and_wait', { message: 'Recover natively' })
    const recovered = await first.nativeCommand('get_messages')
    assert.ok(assistantText(recovered.messages).includes('common prompt recovered'))
    assert.ok(assistantText(recovered.messages).includes('native prompt recovered'))
    console.log('abort recovery: common and native prompts persisted')

    fakeLlm.queue(turn.text('recovered resident reply'))
    await first.nativeCommand('prompt_and_wait', { message: 'Write a resident reply' })
    const nativeAgentId = first.nativeAgentId
    const sessionFile = (await first.nativeCommand('get_state')).sessionFile
    await first.stop()

    const second = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      nativeAgentId
    })
    handles.push(second)
    await second.start()
    assert.equal(second.nativeAgentId, nativeAgentId)
    const reattached = await second.send({ type: 'get_messages' })
    assert.equal(reattached.success, true, reattached.error)
    assert.ok(assistantText(reattached.data.messages).includes('recovered resident reply'))
    console.log('resident reattach: persisted messages retained')

    const streamedReply = 'midstream attachment should restore the partial reply without repetition'
    const sourceEvents = []
    second.on('event', (event) => sourceEvents.push(event))
    fakeLlm.queue(turn.text(streamedReply, { chunkSize: 2, delayMs: 100 }))
    const requestCountBeforeStream = fakeLlm.requests.length
    const started = await second.send({ type: 'prompt', message: 'Stream a long reply' })
    assert.equal(started.success, true, started.error)
    const streamingRequest = await fakeLlm.waitForRequest(() => true, {
      from: requestCountBeforeStream
    })
    const observer = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      nativeAgentId
    })
    handles.push(observer)
    const observerEvents = []
    observer.on('event', (event) => observerEvents.push(event))
    await eventually(
      () =>
        streamingRequest.outcome === 'streaming' &&
        sourceEvents.filter(
          (event) =>
            event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta'
        ).length >= 2,
      'partial assistant stream before attach'
    )
    await observer.start()
    const snapshot = observerEvents.find(
      (event) => event.type === 'engine_native_event' && event.name === 'session_snapshot'
    )
    assert.ok(snapshot, 'midstream attach must emit a normalized session snapshot')
    assert.equal(snapshot.data.state.isStreaming, true)
    const snapshotText = assistantText(snapshot.data.messages).at(-1) ?? ''
    await second.nativeCommand('wait_for_idle')
    await eventually(
      () => observerEvents.some((event) => event.type === 'agent_settled'),
      'observer agent_settled event'
    )
    const observerMessages = await observer.send({ type: 'get_messages' })
    assert.equal(observerMessages.success, true, observerMessages.error)
    assert.equal(assistantText(observerMessages.data.messages).at(-1), streamedReply)
    // Native snapshots can omit the in-flight assistant and end with the prior reply.
    let observedText = streamedReply.startsWith(snapshotText) ? snapshotText : ''
    for (const event of observerEvents) {
      if (event.type !== 'message_update') continue
      if (event.assistantMessageEvent?.type === 'text_delta') {
        observedText += event.assistantMessageEvent.delta
      } else if (event.assistantMessageEvent?.type === 'text_end') {
        observedText = event.assistantMessageEvent.content
      }
    }
    assert.equal(observedText, streamedReply, 'snapshot and streamed deltas must not repeat text')
    assert.equal(
      observerMessages.data.messages.filter(
        (message) =>
          message.role === 'assistant' &&
          message.content?.some((block) => block.type === 'text' && block.text === streamedReply)
      ).length,
      1
    )
    console.log('midstream attach: snapshot, settled event, and one persisted reply')

    await observer.stop()
    await second.stop()
    const childOutput = await runQaChild([
      '--reattach-child',
      executablePath,
      bundlePath,
      agentDirectory,
      workspaceDirectory,
      sessionFile,
      nativeAgentId
    ])
    assert.match(childOutput, /registry reattach: persisted messages recovered/)
    console.log(childOutput.trim())

    const beforeKill = await listPrimeBackground({ executablePath, agentDir: agentDirectory })
    assert.ok(beforeKill.some((session) => session.id === nativeAgentId))
    assert.equal(
      beforeKill.find((session) => session.id === nativeAgentId)?.sessionPath,
      sessionFile
    )
    const savedSessions = await listPrimeSessions({ cwd: workspaceDirectory })
    assert.equal(savedSessions.sessionDir, sessionsDirectory)
    assert.ok(savedSessions.sessions.some((session) => session.path === sessionFile))
    console.log('configured session directory: native persistence and listing agree')

    const killer = newEngine(PrimeEngineProcess, agentDirectory, workspaceDirectory, {
      nativeAgentId
    })
    handles.push(killer)
    await killer.start()
    await killer.nativeCommand('kill')
    await eventually(() => killer.status === 'exited', 'killed adapter status')
    console.log('native kill: response resolves after session_closed; handle exits')
    assert.ok((await readFile(sessionFile, 'utf8')).includes('recovered resident reply'))
    const afterKill = await listPrimeBackground({ executablePath, agentDir: agentDirectory })
    assert.ok(afterKill.every((session) => session.id !== nativeAgentId))
    const coldSession = await withPrimeServiceSession(
      workspaceDirectory,
      async (request) => ({
        state: await request('get_connection_state'),
        tree: await request('get_session_tree')
      }),
      sessionFile,
      {
        executablePath,
        agentDir: agentDirectory,
        sessionDir: sessionsDirectory,
        requireOwnedSession: true
      }
    )
    assert.notEqual(coldSession.state.activeSessionId, nativeAgentId)
    assert.ok(coldSession.tree.flatNodes.some((node) => node.entry.type === 'message'))
    const afterService = await listPrimeBackground({ executablePath, agentDir: agentDirectory })
    assert.ok(afterService.every((session) => session.id !== nativeAgentId))
    console.log('cold saved session: background roster excludes history; owned service closes')

    await stopDuringStartup(
      PrimeEngineProcess,
      probePrimeDaemon,
      fakeLlm.openaiBaseUrl,
      temporaryRoot,
      workspaceDirectory,
      false
    )
    await stopDuringStartup(
      PrimeEngineProcess,
      probePrimeDaemon,
      fakeLlm.openaiBaseUrl,
      temporaryRoot,
      workspaceDirectory,
      true
    )
    console.log('startup cancellation: immediate and registry-stage sessionless stops exited')
    if (restartMode) {
      await runRestartQa(
        PrimeEngineProcess,
        probePrimeDaemon,
        connectPrimeResident,
        fakeLlm,
        bundlePath
      )
    }
    console.log('Prime public adapter real-native QA passed')
  } finally {
    for (const handle of handles.reverse()) await handle.stop().catch(() => {})
    await shutdownQaDaemon(probePrimeDaemon, agentDirectory)
    await fakeLlm.close()
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    await rm(bundlePath, { force: true })
  }
}
