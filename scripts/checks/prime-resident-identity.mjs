import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { executableName } from '../qa/lib/platform.mjs'
import { runConflictingIdentityFixture } from './prime-native-id-conflicts.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const nativeMode = process.argv.includes('--native')
const temporaryBase = resolve(process.env.QA_TMP_ROOT ?? tmpdir())
const timeoutMilliseconds = 30_000
const pollMilliseconds = 25
const daemonIdentityBytes = 10
const protocol = { name: 'prime-agent.daemon', version: 7 }
const require = createRequire(import.meta.url)

function inside(parent, child) {
  const difference = relative(resolve(parent), resolve(child))
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

if (nativeMode && (inside(homedir(), temporaryBase) || inside(repositoryRoot, temporaryBase))) {
  throw new Error('Set QA_TMP_ROOT to a temporary directory outside the home and repository.')
}
await mkdir(temporaryBase, { recursive: true })
const temporaryRoot = await mkdtemp(join(temporaryBase, 'vengeance-prime-identity-'))
const agentDirectory = join(temporaryRoot, 'agent')
const workspaceDirectory = join(temporaryRoot, 'workspace')
const previousAgentDirectory = process.env.PRIME_AGENT_CODING_AGENT_DIR
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDirectory
await Promise.all([
  mkdir(agentDirectory, { recursive: true }),
  mkdir(workspaceDirectory, { recursive: true })
])

async function loadAdapter() {
  const bundlePath = join(temporaryRoot, 'adapter.cjs')
  await build({
    stdin: {
      contents: [
        "export { EngineManager } from './src/main/engine/manager'",
        "export { PrimeEngineProcess } from './src/main/engine/prime/process'",
        "export { attachPrimeResident, connectPrimeDaemon, connectPrimeResident, listPrimeBackground, stopPrimeBackground, probePrimeDaemon } from './src/main/engine/prime/daemon'",
        "export { PrimeTransport } from './src/main/engine/prime/transport'",
        "export { primeDaemonEndpoint } from './src/main/engine/prime/daemon-socket'",
        nativeMode ? '' : "export { savedIdentityReads } from 'vengeance-fixture-identity'"
      ].join('\n'),
      resolveDir: repositoryRoot,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    tsconfig: join(repositoryRoot, 'tsconfig.node.json'),
    plugins: [
      {
        name: 'isolated-electron',
        setup(bundler) {
          if (!nativeMode) {
            bundler.onResolve(
              { filter: /^(?:\.\/sessions|vengeance-fixture-identity)$/ },
              ({ path, importer }) =>
                path === 'vengeance-fixture-identity' || /[/\\]session-lineage\.ts$/.test(importer)
                  ? { path: 'saved-identity', namespace: 'saved-identity' }
                  : undefined
            )
            bundler.onLoad({ filter: /.*/, namespace: 'saved-identity' }, () => ({
              contents: `
                let reads = 0;
                export const savedIdentityReads = () => reads;
                export const primeSessionIdentity = async () => {
                  reads++;
                  return null;
                };
              `,
              loader: 'js'
            }))
          }
          bundler.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'fixture'
          }))
          bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `
            export const app = {
              isPackaged: false,
              getAppPath: () => ${JSON.stringify(repositoryRoot)},
              getPath: () => ${JSON.stringify(temporaryRoot)}
            }
            export const safeStorage = { isEncryptionAvailable: () => false }
            export const shell = {}
          `,
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })
  return require(bundlePath)
}

async function until(predicate, description) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((complete) => setTimeout(complete, pollMilliseconds))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function readFrames(socket, receive) {
  let buffered = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      receive(JSON.parse(buffered.slice(0, newline)))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
}

/** A test-owned daemon in the app's own endpoint folder, so the app's registry accepts it. */
async function endpoint(primeDaemonEndpoint, accept) {
  const socketPath = primeDaemonEndpoint(randomBytes(daemonIdentityBytes).toString('hex'))
  const connections = new Set()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => connections.delete(socket))
    accept(socket)
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return {
    socketPath,
    close: async () => {
      for (const socket of connections) socket.destroy()
      const closed = once(server, 'close')
      server.close()
      await closed
    }
  }
}

async function writeRegistry(records) {
  await writeFile(join(agentDirectory, 'vengeance-daemons.json'), JSON.stringify(records))
}

async function assertIdentitySelection(connectPrimeResident, currentId, originalPath, options) {
  const resident = await connectPrimeResident(
    {
      nativeAgentId: currentId,
      sessionPath: originalPath
    },
    options
  )
  assert.equal(resident?.nativeAgentId, currentId)
  resident.client.close()
  assert.equal(
    await connectPrimeResident(
      {
        nativeAgentId: randomUUID(),
        sessionPath: originalPath
      },
      options
    ),
    null
  )
  const saved = await connectPrimeResident({ sessionPath: originalPath }, options)
  assert.ok(saved)
  assert.notEqual(saved.nativeAgentId, currentId)
  saved.client.close()
}

async function runProtocolFixture({ EngineManager, connectPrimeResident, primeDaemonEndpoint }) {
  const originalPath = join(temporaryRoot, 'original.jsonl')
  const switchedPath = join(temporaryRoot, 'switched.jsonl')
  const currentId = 'current-resident'
  const originalId = 'original-resident'
  const firstWorkerPid = 1001
  const replacementWorkerPid = 1002
  const original = { id: originalId, sessionFile: originalPath, workerPid: firstWorkerPid }
  const switched = { id: currentId, sessionFile: switchedPath, workerPid: firstWorkerPid }
  const sourceRoster = [original]
  const rosters = [[], sourceRoster]
  let attachedSocket
  const endpoints = await Promise.all(
    rosters.map(async (roster) =>
      endpoint(primeDaemonEndpoint, (socket) => {
        socket.write(
          `${JSON.stringify({
            type: 'daemon_hello',
            protocol,
            clientId: randomUUID(),
            supervisorPid: process.pid
          })}\n`
        )
        readFrames(socket, (frame) => {
          const command = frame.command
          if (command.type === 'ack_result') return
          let data = {}
          if (command.type === 'list') data = { sessions: roster }
          if (command.type === 'switch_session') {
            roster.splice(0, roster.length, switched)
            rosters[0].push({ id: 'reopened-original', sessionFile: originalPath })
            socket.write(
              `${JSON.stringify({
                type: 'session_binding',
                previousActiveSessionId: originalId,
                activeSessionId: currentId
              })}\n`
            )
          }
          if (command.type === 'attach' || command.type === 'get_connection_state') {
            const session = roster.find((entry) => entry.id === command.activeSessionId)
            assert.ok(session)
            const state = {
              ...session,
              activeSessionId: session.id,
              sessionId: session.id,
              cwd: workspaceDirectory,
              isStreaming: false,
              isCompacting: false
            }
            if (command.type === 'attach') {
              if (roster === sourceRoster) attachedSocket = socket
              data = { snapshot: { state, messages: [] } }
            } else data = state
          }
          socket.write(
            `${JSON.stringify({ type: 'response', id: frame.id, success: true, data })}\n`
          )
        })
      })
    )
  )
  const options = { agentDir: agentDirectory }
  const statusEvents = []
  const manager = new EngineManager(
    {
      onEvent() {},
      onExit() {},
      onStatus(agentId, status, info) {
        statusEvents.push({ agentId, status, info })
      }
    },
    {
      mock: false,
      engineOverridePath: () => null,
      bridgeExtensionPath: () => null
    }
  )
  const managedAgentId = 'managed-resident'
  try {
    await writeRegistry(
      endpoints.map((server) => ({
        socketPath: server.socketPath,
        executablePath: process.execPath,
        packageDir: dirname(process.execPath),
        version: '0.10.0'
      }))
    )
    const created = await manager.create(
      {
        engine: 'prime',
        cwd: workspaceDirectory,
        sessionPath: originalPath
      },
      managedAgentId
    )
    assert.equal(created.status, 'ready', created.error)
    assert.equal(created.pid, firstWorkerPid)
    await assert.rejects(
      manager.create(
        { engine: 'prime', cwd: workspaceDirectory, sessionPath: originalPath },
        'duplicate-file'
      ),
      /already open in Vengeance/
    )
    await assert.rejects(
      manager.create(
        { engine: 'prime', cwd: workspaceDirectory, nativeAgentId: originalId },
        'duplicate-native'
      ),
      /already open in Vengeance/
    )
    assert.equal(manager.list().length, 1, 'one app handle owns the resident connection')
    await manager.nativeCommand(managedAgentId, 'switch_session', { sessionPath: switchedPath })
    assert.equal(manager.get(managedAgentId).nativeAgentId, currentId)
    await assertIdentitySelection(connectPrimeResident, currentId, originalPath, options)
    const statusCount = statusEvents.length
    switched.workerPid = replacementWorkerPid
    attachedSocket.destroy()
    await until(
      () => statusEvents.slice(statusCount).some((event) => event.status === 'ready'),
      'resident reconnect'
    )
    assert.equal(manager.get(managedAgentId).nativeAgentId, currentId)
    const state = await manager.nativeCommand(managedAgentId, 'get_state')
    assert.equal(state.sessionFile, switchedPath)
    assert.equal(state.workerPid, replacementWorkerPid)
    assert.equal(manager.get(managedAgentId).pid, replacementWorkerPid)
    assert.equal(manager.list()[0].pid, replacementWorkerPid)
    assert.equal(statusEvents.at(-1).info.pid, replacementWorkerPid)
    console.log('PASS protocol: resident ID wins over reused path; switched transport reconnects.')
    console.log('PASS metadata: get, list, and ready events report the replacement worker PID.')
  } finally {
    await manager.disposeAll()
    await Promise.all(endpoints.map((server) => server.close()))
  }
}

async function runBackgroundLineageFixture({ listPrimeBackground, primeDaemonEndpoint }) {
  const parentPath = join(temporaryRoot, 'parent.jsonl')
  const childPath = join(temporaryRoot, 'child.jsonl')
  const parent = {
    id: 'family-parent',
    sessionFile: parentPath,
    sessionId: 'saved-parent',
    cwd: workspaceDirectory,
    runtimeKind: 'top-level',
    rlmDepth: 0,
    hasRunningSubagents: true
  }
  const child = {
    id: 'family-child',
    sessionId: 'saved-child',
    cwd: workspaceDirectory,
    runtimeKind: 'subagent',
    rlmDepth: 1,
    rlmChildId: 'sub-review',
    parentActiveSessionId: parent.id,
    parentSessionId: parent.sessionId,
    parentSessionPath: parentPath,
    activity: 'working',
    isStreaming: true
  }
  const commands = []
  const rosters = [
    [parent, child],
    [parent, { ...child, sessionFile: childPath }]
  ]
  const endpoints = await Promise.all(
    rosters.map((sessions) =>
      endpoint(primeDaemonEndpoint, (socket) => {
        socket.write(
          `${JSON.stringify({ type: 'daemon_hello', protocol, clientId: randomUUID() })}\n`
        )
        readFrames(socket, (frame) => {
          if (frame.command.type === 'ack_result') return
          commands.push(frame.command.type)
          socket.write(
            `${JSON.stringify({ type: 'response', id: frame.id, success: true, data: { sessions } })}\n`
          )
        })
      })
    )
  )
  try {
    await writeRegistry(
      endpoints.map((server) => ({
        socketPath: server.socketPath,
        executablePath: process.execPath,
        packageDir: dirname(process.execPath),
        version: '0.10.0'
      }))
    )
    const listed = await listPrimeBackground({ agentDir: agentDirectory })
    assert.equal(
      listed.length,
      2,
      'duplicate endpoint rows converge, including a delayed file path'
    )
    const listedChild = listed.find((entry) => entry.id === child.id)
    assert.equal(listedChild.sessionPath, childPath)
    assert.equal(listedChild.busy, true)
    assert.deepEqual(listedChild.lineage, {
      parentSessionPath: parentPath,
      parentSessionId: parent.sessionId,
      parentNativeAgentId: parent.id,
      depth: 1,
      childId: child.rlmChildId,
      runtimeKind: 'subagent'
    })
    assert.equal(listed.find((entry) => entry.id === parent.id).busy, true)
    assert.ok(commands.length > 0 && commands.every((command) => command === 'list'))
    console.log(
      'PASS background families: endpoint duplicates converge; lineage and child activity survive read-only listing.'
    )
  } finally {
    await Promise.all(endpoints.map((server) => server.close()))
  }
}

async function runRecoveryFixture({ attachPrimeResident, PrimeTransport, primeDaemonEndpoint }) {
  const recoveringId = 'recovering-resident'
  const adoptionRequests = 3
  const attempts = new Map()
  const server = await endpoint(primeDaemonEndpoint, (socket) => {
    socket.write(`${JSON.stringify({ type: 'daemon_hello', protocol, clientId: randomUUID() })}\n`)
    readFrames(socket, (frame) => {
      const command = frame.command
      if (command.type === 'ack_result') return
      const response = { type: 'response', id: frame.id, success: false }
      if (command.type === 'create') {
        response.error = 'The saved session is already active.'
        response.errorInfo = { code: 'session_already_active', activeSessionId: recoveringId }
      } else if (command.type === 'attach') {
        const count = (attempts.get(command.activeSessionId) ?? 0) + 1
        attempts.set(command.activeSessionId, count)
        if (command.activeSessionId === recoveringId && count >= adoptionRequests) {
          response.success = true
          response.data = { snapshot: { state: { activeSessionId: recoveringId }, messages: [] } }
        } else {
          response.error =
            command.activeSessionId === 'damaged-resident'
              ? 'The session snapshot is damaged.'
              : `Unknown active session: ${command.activeSessionId}`
        }
      }
      socket.write(`${JSON.stringify(response)}\n`)
    })
  })
  const client = new PrimeTransport(server.socketPath)
  try {
    await client.connect()
    const conflict = await client
      .request('create', { sessionPath: 'saved.jsonl' })
      .catch((error) => error)
    assert.equal(conflict.details.code, 'session_already_active')
    const attached = await attachPrimeResident(
      client,
      { activeSessionId: conflict.details.activeSessionId },
      conflict
    )
    assert.equal(attached.snapshot.state.activeSessionId, recoveringId)
    assert.equal(attempts.get(recoveringId), adoptionRequests)
    await assert.rejects(
      attachPrimeResident(client, { activeSessionId: 'missing-resident' }),
      /Unknown active session/
    )
    assert.equal(attempts.get('missing-resident'), 1)
    await assert.rejects(
      attachPrimeResident(client, { activeSessionId: 'damaged-resident' }, conflict),
      /snapshot is damaged/
    )
    assert.equal(attempts.get('damaged-resident'), 1)
    await assert.rejects(
      attachPrimeResident(client, { activeSessionId: 'closing-resident' }, conflict, () => true),
      /Unknown active session/
    )
    assert.equal(attempts.get('closing-resident'), 1)
    console.log(
      'PASS recovery: lease conflicts wait for adoption; other errors and closing do not retry.'
    )
  } finally {
    client.close()
    await server.close()
  }
}

async function proxyEndpoint(primeDaemonEndpoint, target) {
  const attached = new Map()
  const server = await endpoint(primeDaemonEndpoint, (socket) => {
    const upstream = createConnection(target)
    upstream.on('error', () => socket.destroy())
    upstream.on('close', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    readFrames(socket, (frame) => {
      if (frame.command?.type === 'attach') attached.set(frame.command.activeSessionId, socket)
    })
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  return {
    ...server,
    disconnect(nativeAgentId) {
      const socket = attached.get(nativeAgentId)
      assert.ok(socket, 'the resident is attached through the test-owned proxy')
      socket.destroy()
    }
  }
}

async function runNative({
  PrimeEngineProcess,
  connectPrimeDaemon,
  connectPrimeResident,
  primeDaemonEndpoint
}) {
  const executablePath = resolve(
    process.env.VENGEANCE_PRIME_EXECUTABLE ??
      join(repositoryRoot, '.engine-staging', 'prime', 'release', executableName('prime-agent'))
  )
  const environment = {
    PRIME_AGENT_SESSION_DIR: join(temporaryRoot, 'sessions'),
    PRIME_AGENT_KERNEL_VENV: join(temporaryRoot, 'kernel-venv'),
    PRIME_AGENT_OFFLINE: '1',
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1'
  }
  await writeFile(
    join(agentDirectory, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'identity-fixture',
      defaultModel: 'fixture-model'
    })
  )
  await writeFile(
    join(agentDirectory, 'models.json'),
    JSON.stringify({
      providers: {
        'identity-fixture': {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'fixture-only',
          models: [{ id: 'fixture-model', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }]
        }
      }
    })
  )
  const options = { executablePath, agentDir: agentDirectory, env: environment }
  const controls = []
  const handles = []
  let proxy
  const open = async (extra = {}, launchEnvironment = environment) => {
    const handle = new PrimeEngineProcess({
      executablePath,
      agentDir: agentDirectory,
      args: {
        engine: 'prime',
        cwd: workspaceDirectory,
        launch: { env: launchEnvironment },
        ...extra
      }
    })
    handles.push(handle)
    await handle.start()
    return handle
  }
  try {
    const control = await connectPrimeDaemon(options)
    controls.push(control)
    proxy = await proxyEndpoint(primeDaemonEndpoint, control.socketPath)
    const registryPath = join(agentDirectory, 'vengeance-daemons.json')
    const records = JSON.parse(await readFile(registryPath, 'utf8'))
    await writeRegistry(records.map((record) => ({ ...record, socketPath: proxy.socketPath })))

    const seed = await open()
    await seed.nativeCommand('set_session_name', { name: 'Original native identity' })
    const originalPath = (await seed.nativeCommand('get_state')).sessionFile
    assert.ok(originalPath)
    await seed.stop()
    const handle = await open({ sessionPath: originalPath })
    const target = await open()
    await target.nativeCommand('set_session_name', { name: 'Switched native identity' })
    const targetState = await target.nativeCommand('get_state')
    await target.stop()
    await control.request('kill', { activeSessionId: target.nativeAgentId })
    await handle.nativeCommand('switch_session', { sessionPath: targetState.sessionFile })
    const currentId = handle.nativeAgentId
    assert.ok(currentId)

    const secondEnvironment = { ...environment, VENGEANCE_IDENTITY_FIXTURE: 'second-daemon' }
    const secondControl = await connectPrimeDaemon({ ...options, env: secondEnvironment })
    controls.push(secondControl)
    const reopened = await open({ sessionPath: originalPath }, secondEnvironment)
    assert.notEqual(reopened.nativeAgentId, currentId)
    const updatedRecords = JSON.parse(await readFile(registryPath, 'utf8'))
    updatedRecords.sort(
      (left, right) =>
        Number(right.socketPath === secondControl.socketPath) -
        Number(left.socketPath === secondControl.socketPath)
    )
    await writeRegistry(updatedRecords)
    await assertIdentitySelection(connectPrimeResident, currentId, originalPath, options)
    let reconnected = false
    const unsubscribe = handle.on('status', (status) => {
      if (status === 'ready') reconnected = true
    })
    try {
      proxy.disconnect(currentId)
      await until(() => reconnected, 'native switched resident reconnect')
    } finally {
      unsubscribe()
    }
    assert.equal(handle.nativeAgentId, currentId)
    const state = await handle.nativeCommand('get_state')
    assert.equal(state.sessionFile, targetState.sessionFile)
    assert.equal(state.sessionName, 'Switched native identity')
    console.log(
      'PASS native: switch, reused saved path, and dropped transport keep native identity.'
    )
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.stop()))
    await Promise.allSettled(
      controls.map(async (control) => {
        try {
          await control.request('shutdown', { force: true })
        } finally {
          control.close()
        }
      })
    )
    await proxy?.close()
    for (const control of controls) {
      await until(() => {
        try {
          process.kill(control.hello.supervisorPid, 0)
          return false
        } catch (error) {
          if (error.code === 'ESRCH') return true
          throw error
        }
      }, 'test-owned daemon shutdown')
    }
  }
}

async function runManagerRestart({ EngineManager, connectPrimeDaemon, probePrimeDaemon }) {
  const managedDirectory = join(temporaryRoot, 'managed-agent')
  await mkdir(managedDirectory)
  await Promise.all(
    ['settings.json', 'models.json'].map((filename) =>
      copyFile(join(agentDirectory, filename), join(managedDirectory, filename))
    )
  )
  const executablePath = resolve(
    process.env.VENGEANCE_PRIME_EXECUTABLE ??
      join(repositoryRoot, '.engine-staging', 'prime', 'release', executableName('prime-agent'))
  )
  const environment = {
    PRIME_AGENT_SESSION_DIR: join(temporaryRoot, 'managed-sessions'),
    PRIME_AGENT_KERNEL_VENV: join(temporaryRoot, 'kernel-venv'),
    PRIME_AGENT_OFFLINE: '1',
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1'
  }
  const statusEvents = []
  const manager = new EngineManager(
    {
      onEvent() {},
      onExit() {},
      onStatus(agentId, status, info) {
        statusEvents.push({ agentId, status, info })
      }
    },
    {
      mock: false,
      engineOverridePath: () => executablePath,
      bridgeExtensionPath: () => null
    }
  )
  const options = { executablePath, agentDir: managedDirectory, env: environment }
  let control
  process.env.PRIME_AGENT_CODING_AGENT_DIR = managedDirectory
  try {
    control = await connectPrimeDaemon(options)
    const args = { engine: 'prime', cwd: workspaceDirectory, launch: { env: environment } }
    const target = await manager.create(args, 'restart-target')
    const peer = await manager.create(args, 'restart-peer')
    assert.equal(target.status, 'ready', target.error)
    assert.equal(peer.status, 'ready', peer.error)
    await manager.nativeCommand(target.agentId, 'set_session_name', { name: 'Restart target' })
    await manager.nativeCommand(peer.agentId, 'set_session_name', { name: 'Restart peer' })
    assert.ok(manager.get(target.agentId).sessionFile)
    assert.ok(manager.get(peer.agentId).sessionFile)
    const statusCount = statusEvents.length
    const restarted = await manager.restart(target.agentId)
    assert.equal(restarted.status, 'ready', restarted.error)
    await until(
      () =>
        statusEvents
          .slice(statusCount)
          .some((event) => event.agentId === peer.agentId && event.status === 'ready'),
      'native sibling reconnect'
    )
    control.close()
    control = await connectPrimeDaemon(options)
    const roster = await control.request('list', { all: false, includeClientOwned: true })
    const resident = (roster.sessions ?? roster.agents).find(
      (session) => (session.activeSessionId ?? session.id) === peer.nativeAgentId
    )
    assert.ok(resident?.workerPid)
    assert.notEqual(resident.workerPid, peer.pid)
    assert.equal(manager.get(peer.agentId).pid, resident.workerPid)
    assert.equal(
      manager.list().find((agent) => agent.agentId === peer.agentId).pid,
      resident.workerPid
    )
    const ready = statusEvents.findLast(
      (event) => event.agentId === peer.agentId && event.status === 'ready'
    )
    assert.equal(ready.info.pid, resident.workerPid)
    console.log('PASS native metadata: sibling restart refreshes get, list, and ready worker PIDs.')
  } finally {
    await manager.disposeAll()
    control?.close()
    const cleanup = await probePrimeDaemon(options)
    try {
      if (cleanup) {
        await cleanup.request('shutdown', { force: true })
        await until(() => {
          try {
            process.kill(cleanup.hello.supervisorPid, 0)
            return false
          } catch (error) {
            if (error.code === 'ESRCH') return true
            throw error
          }
        }, 'metadata test-owned daemon shutdown')
      }
    } finally {
      cleanup?.close()
      process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDirectory
    }
  }
}

let cleanupAllowed = !nativeMode
try {
  const adapter = await loadAdapter()
  if (nativeMode) {
    await runNative(adapter)
    await runManagerRestart(adapter)
  } else {
    await runProtocolFixture(adapter)
    await runBackgroundLineageFixture(adapter)
    await runConflictingIdentityFixture(adapter, {
      endpoint,
      readFrames,
      writeRegistry,
      temporaryRoot,
      workspaceDirectory,
      agentDirectory,
      protocol
    })
    await runRecoveryFixture(adapter)
  }
  cleanupAllowed = true
} finally {
  if (previousAgentDirectory === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR
  else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDirectory
  if (cleanupAllowed) {
    const realRoot = await realpath(temporaryRoot)
    const realBase = await realpath(temporaryBase)
    assert.ok(inside(realBase, realRoot) && realRoot !== realBase)
    await rm(realRoot, { recursive: true, force: true })
  } else console.error(`Native identity QA retained ${temporaryRoot} for diagnosis`)
}
