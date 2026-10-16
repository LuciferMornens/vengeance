import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixtureTimeoutMs = 5_000
const daemonIdentityBytes = 10
const selectedVersion = '0.10.0+vengeance.4'
const residentVersion = '0.10.0+vengeance.3'
const protocol = { name: 'prime-agent.daemon', version: 7 }
const require = createRequire(import.meta.url)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-model-'))

async function bounded(pending, description) {
  let timer
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), fixtureTimeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function signal() {
  let resolve
  const pending = new Promise((complete) => {
    resolve = complete
  })
  return { pending, resolve }
}

async function loadProcess(agentDirectory) {
  const bundlePath = join(agentDirectory, 'adapter.cjs')
  const fakeLocation = {
    executablePath: process.execPath,
    packageDir: dirname(process.execPath),
    version: selectedVersion,
    source: 'override'
  }
  await build({
    stdin: {
      contents: "export { PrimeEngineProcess } from './src/main/engine/prime/process'",
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
        name: 'isolated-native-location',
        setup(bundler) {
          bundler.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'fixture'
          }))
          bundler.onResolve({ filter: /^\.\/locate$/ }, (args) => {
            if (args.resolveDir === join(repositoryRoot, 'src', 'main', 'engine', 'prime')) {
              return { path: 'prime-location', namespace: 'fixture' }
            }
          })
          bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
            contents:
              args.path === 'prime-location'
                ? `
                  export const getPrimeAgentDir = () => ${JSON.stringify(agentDirectory)}
                  export const locatePrimeEngine = async () => (${JSON.stringify(fakeLocation)})
                `
                : `
                  export const app = {
                    isPackaged: false,
                    getAppPath: () => ${JSON.stringify(repositoryRoot)},
                    getPath: () => ${JSON.stringify(agentDirectory)}
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
  return { ...require(bundlePath), fakeLocation }
}

function descriptor(provider, id, input = ['text', 'image']) {
  return {
    provider,
    id,
    name: id,
    input,
    reasoning: true,
    contextWindow: 96_000,
    maxTokens: 8_192,
    headers: { Authorization: 'Bearer fixture-only' },
    compat: { privateSetting: 'fixture-only' },
    baseUrl: 'https://catalog.invalid/private?token=fixture-only'
  }
}

function sessionState(activeSessionId, workerPid, modelId) {
  return {
    activeSessionId,
    sessionId: activeSessionId,
    workerPid,
    model: { provider: 'resident-provider', id: modelId },
    isStreaming: false,
    isCompacting: false
  }
}

function snapshot(state, sequence = 0) {
  return {
    state,
    messages: [],
    lastEventCursor: { generation: state.activeSessionId, sequence }
  }
}

async function fixture(name) {
  const agentDirectory = join(temporaryRoot, name)
  await mkdir(agentDirectory)
  const { PrimeEngineProcess, fakeLocation } = await loadProcess(agentDirectory)
  const identity = randomBytes(daemonIdentityBytes).toString('hex')
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\vengeance-engine2-${identity}`
      : join(tmpdir(), `vengeance-engine2-${identity}.sock`)
  const firstWorkerPid = 1010
  const replacementWorkerPid = 2020
  let state = sessionState(`${name}-resident`, firstWorkerPid, 'vision-model')
  const connections = new Set()
  const requests = []
  const events = []
  const statuses = []
  let attachedSocket
  let holdCatalog = false
  let holdState = false
  const observers = new Set()

  const notify = () => {
    for (const observer of [...observers]) observer()
  }
  const waitFor = (predicate, description) => {
    const changed = signal()
    const inspect = () => {
      const value = predicate()
      if (!value) return
      observers.delete(inspect)
      changed.resolve(value)
    }
    observers.add(inspect)
    inspect()
    return bounded(changed.pending, description).finally(() => observers.delete(inspect))
  }
  const send = (socket, frame) => socket.write(`${JSON.stringify(frame)}\n`)
  const respond = (socket, request, data, error) => {
    send(socket, {
      type: 'response',
      id: request.id,
      success: !error,
      ...(error ? { error } : { data })
    })
  }
  const receive = (socket, request) => {
    const command = request.command
    if (command.type === 'ack_result') return
    const observed = {
      ...command,
      socket,
      reply: (data) => respond(socket, request, data),
      fail: (message) => respond(socket, request, undefined, message)
    }
    requests.push(observed)
    let data = {}
    if (command.type === 'list') {
      data = { sessions: [{ id: state.activeSessionId, ...state }] }
    } else if (command.type === 'attach') {
      if (command.activeSessionId !== state.activeSessionId) {
        observed.fail(`Unknown active session: ${command.activeSessionId}`)
        notify()
        return
      }
      attachedSocket = socket
      data = { snapshot: snapshot(state) }
    } else if (command.type === 'get_model_catalog') {
      if (holdCatalog) {
        notify()
        return
      }
      data = { models: [descriptor(state.model.provider, state.model.id)] }
    } else if (command.type === 'get_connection_state') {
      if (holdState) {
        notify()
        return
      }
      data = state
    } else {
      assert.equal(command.type, 'detach', `Unexpected native operation: ${command.type}`)
    }
    respond(socket, request, data)
    notify()
  }
  const server = createServer((socket) => {
    connections.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => connections.delete(socket))
    send(socket, {
      type: 'daemon_hello',
      protocol,
      clientId: randomUUID(),
      appVersion: residentVersion
    })
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', (chunk) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        receive(socket, JSON.parse(buffered.slice(0, newline)))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const environmentHash = createHash('sha256').update(JSON.stringify([])).digest('hex')
  await writeFile(
    join(agentDirectory, 'vengeance-daemons.json'),
    JSON.stringify([{ socketPath, ...fakeLocation, version: residentVersion, environmentHash }])
  )
  const processHandle = new PrimeEngineProcess({
    agentDir: agentDirectory,
    executablePath: process.execPath,
    args: {
      engine: 'prime',
      cwd: agentDirectory,
      sessionDir: join(agentDirectory, 'sessions'),
      nativeAgentId: state.activeSessionId
    }
  })
  const unsubscribers = [
    processHandle.on('event', (event) => {
      events.push(event)
      notify()
    }),
    processHandle.on('status', (status) => {
      statuses.push(status)
      notify()
    })
  ]
  return {
    processHandle,
    requests,
    events,
    statuses,
    firstWorkerPid,
    replacementWorkerPid,
    state: () => state,
    replaceState: (next) => {
      state = next
    },
    holdCatalog: (hold) => {
      holdCatalog = hold
    },
    holdState: (hold) => {
      holdState = hold
    },
    send: (frame) => send(attachedSocket, frame),
    disconnect: () => attachedSocket.destroy(),
    waitFor,
    close: async () => {
      await bounded(processHandle.stop(), 'fixture handle closes')
      for (const unsubscribe of unsubscribers) unsubscribe()
      for (const socket of connections) socket.destroy()
      const closed = once(server, 'close')
      server.close()
      await closed
    }
  }
}

function nativeSnapshots(events) {
  return events.filter(
    (event) => event.type === 'engine_native_event' && event.name === 'session_snapshot'
  )
}

async function attachAndResync() {
  const native = await fixture('attach-resync')
  try {
    native.holdCatalog(true)
    const started = native.processHandle.start()
    const catalog = await native.waitFor(
      () => native.requests.find((request) => request.type === 'get_model_catalog'),
      'initial resident catalog'
    )
    assert.equal(native.processHandle.status, 'starting')
    assert.equal(nativeSnapshots(native.events).length, 0)
    catalog.reply({ models: [descriptor('resident-provider', 'vision-model')] })
    await bounded(started, 'hydrated initial attach')
    assert.deepEqual(nativeSnapshots(native.events)[0].data.state.model.input, ['text', 'image'])
    assert.deepEqual(native.processHandle.runtime, { version: residentVersion, selectedVersion })

    const sequence = 4
    const nextSequence = sequence + 1
    const beforeCatalogs = native.requests.filter((request) => request.type === 'get_model_catalog')
    const next = { ...native.state(), model: { provider: 'resident-provider', id: 'text-model' } }
    native.replaceState(next)
    native.send({
      type: 'session_resynced',
      activeSessionId: next.activeSessionId,
      snapshot: snapshot(next, sequence)
    })
    const resyncCatalog = await native.waitFor(
      () =>
        native.requests.filter((request) => request.type === 'get_model_catalog')[
          beforeCatalogs.length
        ],
      'resynced resident catalog'
    )
    for (const [cursorSequence, label] of [
      [sequence, 'already committed'],
      [nextSequence, 'after snapshot']
    ]) {
      native.send({
        type: 'session_event',
        activeSessionId: next.activeSessionId,
        meta: { cursor: { generation: next.activeSessionId, sequence: cursorSequence } },
        event: { type: 'session_info_changed', name: label }
      })
    }
    resyncCatalog.reply({ models: [descriptor('resident-provider', 'text-model', ['text'])] })
    await native.waitFor(
      () => native.events.find((event) => event.type === 'session_info_changed'),
      'event after hydrated resync'
    )
    const snapshots = nativeSnapshots(native.events)
    assert.equal(snapshots.length, 2)
    assert.deepEqual(snapshots[1].data.state.model.input, ['text'])
    assert.deepEqual(
      native.events
        .filter((event) => event.type === 'session_info_changed')
        .map((event) => event.name),
      ['after snapshot']
    )
    assert.ok(
      native.events.indexOf(snapshots[1]) <
        native.events.findIndex((event) => event.type === 'session_info_changed')
    )
    assert.ok(!JSON.stringify(native.events).includes('fixture-only'))
    console.log(
      'PASS attach/resync: native catalog hydration precedes snapshots and cursor-ordered events.'
    )
  } finally {
    await native.close()
  }
}

async function staleStateIdentity() {
  const native = await fixture('stale-state')
  try {
    await native.processHandle.start()
    native.holdState(true)
    const originalState = native.state()
    const pending = native.processHandle.nativeCommand('get_state')
    const refused = assert.rejects(pending, /session changed while reading its state/)
    const request = await native.waitFor(
      () => native.requests.find((entry) => entry.type === 'get_connection_state'),
      'held native state request'
    )
    const next = sessionState('new-resident', native.replacementWorkerPid, 'text-model')
    native.replaceState(next)
    native.send({
      type: 'session_binding',
      previousActiveSessionId: originalState.activeSessionId,
      activeSessionId: next.activeSessionId
    })
    await native.waitFor(
      () =>
        native.requests.find(
          (entry) => entry.type === 'attach' && entry.activeSessionId === next.activeSessionId
        ),
      'new resident attach'
    )
    request.reply(originalState)
    await bounded(refused, 'stale original state refusal')
    assert.equal(native.processHandle.nativeAgentId, next.activeSessionId)
    assert.equal(native.processHandle.pid, native.replacementWorkerPid)
    assert.ok(
      !native.requests.some(
        (entry) =>
          entry.type === 'get_model_catalog' &&
          entry.activeSessionId !== originalState.activeSessionId &&
          entry.activeSessionId !== next.activeSessionId
      )
    )
    console.log(
      'PASS stale state: a native reply cannot hydrate or overwrite a different resident identity.'
    )
  } finally {
    await native.close()
  }
}

async function reconnectDuringHydration() {
  for (const initialAttach of [true, false]) {
    const native = await fixture(initialAttach ? 'attach-reconnect' : 'resync-reconnect')
    try {
      native.holdCatalog(initialAttach)
      const started = native.processHandle.start()
      if (!initialAttach) await started
      const original = native.state()
      const snapshotsBefore = nativeSnapshots(native.events).length
      if (!initialAttach) {
        native.holdCatalog(true)
        native.send({
          type: 'session_resynced',
          activeSessionId: original.activeSessionId,
          snapshot: snapshot(original)
        })
      }
      await native.waitFor(
        () =>
          native.requests.filter((request) => request.type === 'get_model_catalog').length >
          snapshotsBefore,
        'held catalog before disconnect'
      )
      const readyBefore = native.statuses.filter((status) => status === 'ready').length
      const next = { ...original, workerPid: native.replacementWorkerPid }
      native.replaceState(next)
      native.holdCatalog(false)
      native.disconnect()
      await native.waitFor(
        () => native.statuses.filter((status) => status === 'ready').length > readyBefore,
        'reconnected hydrated snapshot'
      )
      await bounded(started, 'initial attach settles')
      assert.equal(native.processHandle.status, 'ready')
      assert.equal(native.processHandle.pid, native.replacementWorkerPid)
      const addedSnapshots = nativeSnapshots(native.events).slice(snapshotsBefore)
      assert.equal(
        addedSnapshots.length,
        1,
        `${initialAttach ? 'Attach' : 'Resync'}: disconnected hydration published a stale snapshot`
      )
      assert.deepEqual(addedSnapshots[0].data.state.model.input, ['text', 'image'])
    } finally {
      await native.close()
    }
  }
  console.log(
    'PASS reconnect: disconnect during catalog lookup discards stale hydration and reattaches.'
  )
}

async function disconnectAgainDuringReconnect() {
  const native = await fixture('repeat-disconnect')
  try {
    await native.processHandle.start()
    const snapshotsBefore = nativeSnapshots(native.events).length
    const readyBefore = native.statuses.filter((status) => status === 'ready').length
    native.holdCatalog(true)
    native.disconnect()
    await native.waitFor(
      () =>
        native.requests.filter((request) => request.type === 'get_model_catalog').length >
        snapshotsBefore,
      'reattach catalog before second disconnect'
    )
    native.disconnect()
    await native.waitFor(
      () =>
        native.statuses.includes('crashed') ||
        native.statuses.filter((status) => status === 'ready').length > readyBefore,
      'second disconnect settles reconnect'
    )
    assert.equal(nativeSnapshots(native.events).length, snapshotsBefore)
    assert.equal(
      native.statuses.filter((status) => status === 'ready').length,
      readyBefore,
      'A disconnected reattach without a snapshot must not announce ready'
    )
    assert.equal(native.processHandle.status, 'crashed')
    console.log('PASS failed reconnect: a second catalog disconnect fails closed without ready.')
  } finally {
    await native.close()
  }
}

let failures = 0
try {
  for (const test of [
    attachAndResync,
    staleStateIdentity,
    reconnectDuringHydration,
    disconnectAgainDuringReconnect
  ]) {
    try {
      await test()
    } catch (error) {
      failures += 1
      console.error(`FAIL ${test.name}: ${error.stack ?? error.message}`)
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
