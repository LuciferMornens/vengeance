import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export async function runConflictingIdentityFixture(
  {
    EngineManager,
    listPrimeBackground,
    connectPrimeResident,
    stopPrimeBackground,
    savedIdentityReads
  },
  {
    endpoint,
    readFrames,
    writeRegistry,
    temporaryRoot,
    workspaceDirectory,
    agentDirectory,
    protocol
  }
) {
  const nativeAgentId = 'daemon-scoped-id'
  const paths = [
    join(temporaryRoot, 'first-daemon.jsonl'),
    join(temporaryRoot, 'second-daemon.jsonl')
  ]
  const stopped = []
  const endpoints = await Promise.all(
    paths.map((path) =>
      endpoint((socket) => {
        socket.write(
          `${JSON.stringify({ type: 'daemon_hello', protocol, clientId: randomUUID() })}\n`
        )
        readFrames(socket, (frame) => {
          const command = frame.command
          if (command.type === 'ack_result') return
          const state = {
            id: nativeAgentId,
            activeSessionId: nativeAgentId,
            sessionFile: path,
            sessionId: path,
            rlmDepth: 0,
            cwd: workspaceDirectory,
            isStreaming: false,
            isCompacting: false
          }
          if (command.type === 'kill') stopped.push(path)
          const data =
            command.type === 'attach'
              ? { snapshot: { state, messages: [] } }
              : command.type === 'get_connection_state'
                ? state
                : { sessions: [state] }
          socket.write(
            `${JSON.stringify({ type: 'response', id: frame.id, success: true, data })}\n`
          )
        })
      })
    )
  )
  const options = { agentDir: agentDirectory }
  const manager = new EngineManager(
    { onEvent() {}, onExit() {}, onStatus() {} },
    {
      mock: false,
      engineOverridePath: () => null,
      bridgeExtensionPath: () => null
    }
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
    assert.equal((await listPrimeBackground(options)).length, 2)
    const selectedPath = process.platform === 'win32' ? `\\\\?\\${paths[1]}` : paths[1]
    const attached = await connectPrimeResident({ sessionPath: selectedPath }, options)
    assert.equal(attached.client.socketPath, endpoints[1].socketPath)
    attached.client.close()
    const identityReads = savedIdentityReads()
    const second = await manager.create(
      { engine: 'prime', cwd: workspaceDirectory, nativeAgentId, sessionPath: selectedPath },
      'second-endpoint'
    )
    const first = await manager.create(
      { engine: 'prime', cwd: workspaceDirectory, nativeAgentId, sessionPath: paths[0] },
      'first-endpoint'
    )
    assert.equal(first.status, 'ready', first.error)
    assert.equal(second.status, 'ready', second.error)
    assert.equal(first.sessionFile, paths[0])
    assert.equal(second.sessionFile, paths[1])
    assert.equal(manager.list().length, 2, 'raw attachment keeps conflicting daemon files distinct')
    assert.equal(
      savedIdentityReads(),
      identityReads,
      'ordinary root opens never inspect saved topology'
    )
    await assert.rejects(stopPrimeBackground(nativeAgentId, options), /matches several sessions/)
    assert.deepEqual(stopped, [], 'ambiguous legacy IDs never stop a resident')
    await stopPrimeBackground({ id: nativeAgentId, sessionPath: selectedPath }, options)
    assert.deepEqual(stopped, [paths[1]], 'the precise selector only stops the requested file')
    console.log(
      'PASS daemon ID conflicts: files stay distinct, path attachment is precise, ambiguous Stop refuses.'
    )
  } finally {
    await manager.disposeAll()
    await Promise.all(endpoints.map((server) => server.close()))
  }
}
