import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeLlm, turn } from '../qa/lib/fake-llm.mjs'
import { executableName } from '../qa/lib/platform.mjs'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDirectory, '..', '..')
const stagedBinary = path.join(
  repositoryRoot,
  '.engine-staging',
  'prime',
  'release',
  executableName('prime-agent')
)
const binaryPath = path.resolve(process.argv[2] ?? stagedBinary)
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vengeance-prime-native-'))
const agentDirectory = path.join(temporaryRoot, 'agent')
const workspaceDirectory = path.join(temporaryRoot, 'workspace')
const sessionDirectory = path.join(agentDirectory, 'sessions')
const scriptPath = path.join(temporaryRoot, 'script.json')
const wireFixturePath = path.join(repositoryRoot, '.engine-staging', 'prime', 'wire-fixture.json')
/** The daemon endpoint: a named pipe on Windows, a Unix socket in the temp root elsewhere. */
const pipePath =
  process.platform === 'win32'
    ? String.raw`\\.\pipe\vengeance-prime-native-${process.pid}-${Date.now()}`
    : path.join(temporaryRoot, 'daemon.sock')
const timeoutMilliseconds = 30_000
const retryMilliseconds = 100
const protocolName = 'prime-agent.daemon'

function isolateEnvironment() {
  const environment = { ...process.env }

  for (const environmentName of Object.keys(environment)) {
    if (/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(environmentName)) {
      delete environment[environmentName]
    }
  }

  environment.PRIME_AGENT_CODING_AGENT_DIR = agentDirectory
  environment.PRIME_AGENT_KERNEL_VENV = path.join(temporaryRoot, 'kernel-venv')
  delete environment.PRIME_AGENT_KERNEL_PYTHON
  environment.PI_PACKAGE_DIR = path.dirname(binaryPath)
  environment.PI_OFFLINE = '1'
  return environment
}

function lineReader(socket) {
  let bufferedText = ''
  const lines = []
  const waiters = []

  socket.on('data', (chunk) => {
    bufferedText += chunk.toString('utf8')

    while (bufferedText.includes('\n')) {
      const newlineIndex = bufferedText.indexOf('\n')
      const line = bufferedText.slice(0, newlineIndex).trimEnd()
      bufferedText = bufferedText.slice(newlineIndex + 1)

      if (!line) continue

      const frame = JSON.parse(line)
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
      else lines.push(frame)
    }
  })

  return async function nextLine() {
    if (lines.length > 0) return lines.shift()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for daemon frame'))
      }, timeoutMilliseconds)

      waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }
}

async function connectWhenReady() {
  const deadline = Date.now() + timeoutMilliseconds

  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.connect(pipePath)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryMilliseconds))
    }
  }

  throw new Error('Prime daemon named pipe did not become ready')
}

function summarizeResponse(command, response) {
  assert.equal(response.type, 'response', `${command} response type`)
  assert.equal(response.success, true, `${command}: ${response.error ?? 'unknown error'}`)
  const data = response.data
  let summary = data

  if (command === 'get_commands') {
    summary = { commandCount: data.commands.length, firstCommand: data.commands[0]?.name }
  } else if (command === 'get_resource_snapshot') {
    summary = {
      contextFileCount: data.contextFiles.length,
      skillCount: data.skills.length,
      promptCount: data.prompts.length,
      themeCount: data.themes.length
    }
  } else if (command === 'get_session_tree') {
    summary = { entryTypes: data.flatNodes.map((node) => node.entry.type), leafId: data.leafId }
  } else if (command === 'get_available_models') {
    summary = { modelCount: data.models.length }
  } else if (command === 'get_model_catalog') {
    summary = { keys: Object.keys(data), sample: data.models?.slice(0, 2) }
  } else if (command === 'attach') {
    summary = {
      snapshotKeys: Object.keys(data.snapshot),
      stateKeys: Object.keys(data.snapshot.state)
    }
  } else if (command.endsWith('create') || command.startsWith('get_state')) {
    summary = {
      id: data.id,
      sessionId: data.sessionId,
      lifecycle: data.lifecycle,
      model: data.model,
      messageCount: data.messageCount
    }
  }

  console.log(`${command}: ${JSON.stringify(summary)}`)
}

function redactFixture(fixture) {
  const replacements = [
    [temporaryRoot, '<TEMP>'],
    [os.homedir(), '<USER_HOME>']
  ]
  let serialized = JSON.stringify(
    fixture,
    (key, value) => {
      if (
        /^(supervisorOwnerToken|apiKey|accessToken|refreshToken|workerToken|authorization|password|secret)$/i.test(
          key
        )
      ) {
        return '<REDACTED>'
      }
      return value
    },
    2
  )

  for (const [privatePath, label] of replacements) {
    serialized = serialized.replaceAll(privatePath.replaceAll('\\', '\\\\'), label)
  }

  return serialized
}

// Prime's Windows lease canonicalizes this path again when appending session messages.
await Promise.all([
  mkdir(sessionDirectory, { recursive: true }),
  mkdir(workspaceDirectory, { recursive: true })
])
await writeFile(
  scriptPath,
  JSON.stringify({
    engine: 'faux',
    tokensPerSecond: 30,
    responses: [
      { text: 'ok' },
      { text: 'A slow reply for the queue probe. '.repeat(30) },
      { text: 'queued' }
    ]
  })
)
const fakeLlm = await startFakeLlm()
await writeFile(
  path.join(agentDirectory, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'battery',
    defaultModel: 'mock-1'
  })
)
await writeFile(
  path.join(agentDirectory, 'models.json'),
  JSON.stringify({
    providers: {
      battery: {
        api: 'openai-completions',
        baseUrl: fakeLlm.openaiBaseUrl,
        apiKey: 'qa-local-only',
        models: [
          {
            id: 'mock-1',
            name: 'Mock 1',
            api: 'openai-completions',
            contextWindow: 128_000,
            maxTokens: 4096
          }
        ]
      }
    }
  })
)

const daemon = spawn(binaryPath, ['--mode', 'daemon', '--daemon-socket', pipePath], {
  cwd: path.dirname(binaryPath),
  env: isolateEnvironment(),
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
})
let stderr = ''
daemon.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})

let socket

try {
  socket = await connectWhenReady()
  const nextLine = lineReader(socket)
  const hello = await nextLine()
  assert.equal(hello.type, 'daemon_hello')
  assert.equal(hello.protocol.name, protocolName)
  console.log(
    `hello: ${JSON.stringify({
      version: hello.protocol.version,
      appVersion: hello.appVersion,
      schemaId: hello.schemaId,
      runtime: hello.runtime,
      serverCapabilities: hello.serverCapabilities
    })}`
  )

  let requestCounter = 0
  const events = []
  const fixture = { hello, responses: {}, events }

  async function request(command) {
    const id = `qa-${++requestCounter}`
    socket.write(
      `${JSON.stringify({
        type: 'command',
        id,
        protocol: hello.protocol,
        command
      })}\n`
    )

    while (true) {
      const frame = await nextLine()
      if (frame.type === 'response' && frame.id === id) {
        return frame
      }
      events.push(frame)
    }
  }

  fakeLlm.queue(turn.text('first session persisted reply'))
  const firstCreated = await request({
    type: 'create',
    config: {
      cwd: workspaceDirectory,
      sessionDir: sessionDirectory,
      provider: 'battery',
      model: 'mock-1'
    }
  })
  fixture.responses.firstCreate = firstCreated
  const firstSessionId = firstCreated.data.id ?? firstCreated.data.sessionId
  fixture.responses.firstAttach = await request({ type: 'attach', activeSessionId: firstSessionId })
  fixture.responses.firstPrompt = await request({
    type: 'prompt_and_wait',
    activeSessionId: firstSessionId,
    message: 'Reply with first session persisted reply'
  })
  const firstMessages = await request({ type: 'get_messages', activeSessionId: firstSessionId })
  summarizeResponse('first session get_messages', firstMessages)
  fixture.responses.firstMessages = firstMessages

  const created = await request({
    type: 'create',
    telemetryDisabled: true,
    config: {
      cwd: workspaceDirectory,
      sessionDir: sessionDirectory,
      script: scriptPath
    }
  })
  summarizeResponse('create', created)
  fixture.responses.create = created
  const activeSessionId = created.data.id ?? created.data.sessionId
  assert.equal(typeof activeSessionId, 'string')

  const attached = await request({ type: 'attach', activeSessionId })
  summarizeResponse('attach', attached)
  fixture.responses.attach = attached

  for (const type of [
    'get_state',
    'get_messages',
    'get_commands',
    'get_available_models',
    'get_model_catalog',
    'get_session_tree',
    'get_resource_snapshot',
    'get_queue'
  ]) {
    const response = await request({ type, activeSessionId })
    summarizeResponse(type, response)
    fixture.responses[type] = response
  }

  const prompt = await request({
    type: 'prompt_and_wait',
    activeSessionId,
    message: 'Reply with just: ok'
  })
  summarizeResponse('prompt_and_wait', prompt)
  fixture.responses.prompt_and_wait = prompt
  const messagesAfterPrompt = await request({
    type: 'get_messages',
    activeSessionId
  })
  summarizeResponse('get_messages after prompt', messagesAfterPrompt)
  fixture.responses.messagesAfterPrompt = messagesAfterPrompt
  const stateAfterPrompt = await request({ type: 'get_state', activeSessionId })
  summarizeResponse('get_state after prompt', stateAfterPrompt)
  fixture.responses.stateAfterPrompt = stateAfterPrompt

  const slowPrompt = await request({
    type: 'prompt',
    activeSessionId,
    message: 'Give a slow answer'
  })
  summarizeResponse('slow prompt', slowPrompt)
  fixture.responses.slowPrompt = slowPrompt
  const queuedPrompt = await request({
    type: 'prompt',
    activeSessionId,
    message: 'Follow up after the slow answer',
    streamingBehavior: 'followUp',
    queueIfBusy: true
  })
  summarizeResponse('queued follow-up', queuedPrompt)
  fixture.responses.queuedPrompt = queuedPrompt
  const queueDuringTurn = await request({ type: 'get_queue', activeSessionId })
  summarizeResponse('get_queue during turn', queueDuringTurn)
  fixture.responses.queueDuringTurn = queueDuringTurn
  const idleAfterQueue = await request({ type: 'wait_for_idle', activeSessionId })
  summarizeResponse('wait_for_idle after queue', idleAfterQueue)
  fixture.responses.idleAfterQueue = idleAfterQueue
  const messagesAfterQueue = await request({ type: 'get_messages', activeSessionId })
  summarizeResponse('get_messages after queue', messagesAfterQueue)
  fixture.responses.messagesAfterQueue = messagesAfterQueue
  const sessionFile = await readFile(created.data.sessionFile, 'utf8')
  const sessionEntries = sessionFile
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  fixture.sessionEntries = sessionEntries
  console.log(`session entries: ${JSON.stringify(sessionEntries.map((entry) => entry.type))}`)

  fakeLlm.queue(turn.text('native persistent ok'))
  const nativeCreated = await request({
    type: 'create',
    telemetryDisabled: true,
    config: {
      cwd: workspaceDirectory,
      sessionDir: sessionDirectory,
      provider: 'battery',
      model: 'mock-1'
    }
  })
  summarizeResponse('native create', nativeCreated)
  fixture.responses.nativeCreate = nativeCreated
  const nativeSessionId = nativeCreated.data.id ?? nativeCreated.data.sessionId
  const nativeAttached = await request({ type: 'attach', activeSessionId: nativeSessionId })
  summarizeResponse('attach', nativeAttached)
  fixture.responses.nativeAttach = nativeAttached
  const nativePrompt = await request({
    type: 'prompt_and_wait',
    activeSessionId: nativeSessionId,
    message: 'Reply with just: native persistent ok'
  })
  summarizeResponse('native prompt_and_wait', nativePrompt)
  fixture.responses.nativePrompt = nativePrompt
  const nativeMessages = await request({ type: 'get_messages', activeSessionId: nativeSessionId })
  summarizeResponse('native get_messages', nativeMessages)
  fixture.responses.nativeMessages = nativeMessages
  const nativeTree = await request({ type: 'get_session_tree', activeSessionId: nativeSessionId })
  summarizeResponse('get_session_tree', nativeTree)
  fixture.responses.nativeTree = nativeTree
  const nativeSessionFile = await readFile(nativeCreated.data.sessionFile, 'utf8')
  fixture.nativeSessionEntries = nativeSessionFile
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  console.log(
    `native session entries: ${JSON.stringify(
      fixture.nativeSessionEntries.map((entry) => entry.type)
    )}`
  )
  console.log(
    `fake model requests: ${JSON.stringify(
      fakeLlm.requests.map((modelRequest) => ({
        api: modelRequest.api,
        path: modelRequest.path,
        outcome: modelRequest.outcome
      }))
    )}`
  )
  await writeFile(wireFixturePath, redactFixture(fixture))
  assert.ok(
    firstMessages.data.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.content?.some(
          (content) =>
            content.type === 'text' && content.text.includes('first session persisted reply')
        )
    ),
    'first file-backed session must persist its assistant reply'
  )
  assert.equal(
    fakeLlm.requests.some(
      (modelRequest) =>
        modelRequest.api === 'openai-completions' && modelRequest.outcome === 'completed'
    ),
    true,
    'native provider must call the local fake LLM'
  )
  assert.ok(
    nativeMessages.data.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.content?.some(
          (content) => content.type === 'text' && content.text.includes('native persistent ok')
        )
    ),
    'native assistant reply must persist in get_messages'
  )
  assert.ok(
    fixture.nativeSessionEntries.some((entry) => entry.type === 'message'),
    'native session file must contain message entries'
  )

  const finalAssistantMessage = events.find(
    (event) =>
      event.type === 'session_event' &&
      event.event?.type === 'message_end' &&
      event.event.message?.role === 'assistant' &&
      event.event.message.content?.some((content) => content.text === 'ok')
  )
  assert.ok(finalAssistantMessage, 'faux provider answer must reach the event stream')
  assert.ok(
    events.some(
      (event) => event.type === 'session_event' && event.event?.type === 'session_action_update'
    ),
    'queued follow-up must emit a session action update'
  )
  const eventCounts = {}
  for (const event of events) {
    const type = event.type === 'session_event' ? `session_event:${event.event?.type}` : event.type
    eventCounts[type] = (eventCounts[type] ?? 0) + 1
  }
  console.log(`event counts: ${JSON.stringify(eventCounts)}`)
  console.log(
    `message events: ${JSON.stringify(
      events
        .filter(
          (event) => event.type === 'session_event' && event.event?.type?.startsWith('message_')
        )
        .map((event) => ({ type: event.event.type, message: event.event.message }))
        .slice(0, 8)
    )}`
  )
  console.log(
    `session action events: ${JSON.stringify(
      events
        .filter(
          (event) => event.type === 'session_event' && event.event?.type === 'session_action_update'
        )
        .map((event) => event.event)
    )}`
  )
  console.log(`wire fixture: ${wireFixturePath}`)

  summarizeResponse('shutdown', await request({ type: 'shutdown', force: true }))
  socket.end()
  await once(daemon, 'exit')
  console.log('Prime native daemon QA passed')
} finally {
  socket?.destroy()
  if (daemon.exitCode === null) {
    daemon.kill()
    await once(daemon, 'exit').catch(() => {})
  }
  await fakeLlm.close()

  const resolvedTemporaryRoot = await realpath(temporaryRoot)
  const resolvedSystemTemp = await realpath(os.tmpdir())
  assert.ok(resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`))
  await rm(resolvedTemporaryRoot, { recursive: true, force: true })

  if (stderr.trim()) console.error(`Prime daemon stderr: ${stderr.trim()}`)
}
