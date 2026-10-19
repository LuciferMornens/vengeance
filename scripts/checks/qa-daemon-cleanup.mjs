import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { shutdownOwnedPrimeDaemons } from '../qa/lib/app.mjs'
import { isAlive, killTree, processTable } from '../qa/lib/processes.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const CHILD_TIMEOUT_MS = 10_000
const POLL_MS = 25
const REUSED_PID_AGE_MS = 60_000
const fixture = await tempRoot('vengeance-qa-daemon-cleanup-')
const children = []

const daemonSource = `
  import { createServer } from 'node:net'
  const endpoint = process.argv[1]
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write(JSON.stringify({ type: 'daemon_hello', protocol: 1 }) + '\\n')
    let buffered = ''
    socket.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\\n')
      if (newline < 0) return
      const request = JSON.parse(buffered.slice(0, newline))
      if (request.command?.type !== 'shutdown') throw new Error('Unexpected fixture command')
      process.send('shutdown')
      socket.end(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
      server.close(() => process.disconnect())
    })
  })
  server.listen(endpoint, () => process.send('ready'))
  process.on('message', message => {
    if (message !== 'stop') return
    for (const socket of sockets) socket.destroy()
    server.close(() => process.disconnect())
  })
`

async function waitFor(predicate, description) {
  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(POLL_MS)
  }
}

function newEndpoint() {
  const name = `vengeance-engine2-${randomBytes(10).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(fixture.dir, `${name}.sock`)
}

async function startDaemon(endpoint = newEndpoint()) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', daemonSource, endpoint], {
    cwd: fixture.dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  const entry = { child, endpoint, ready: false, shutdowns: 0, errors: '' }
  children.push(entry)
  child.stderr.on('data', (chunk) => {
    entry.errors += chunk.toString('utf8')
  })
  child.on('message', (message) => {
    if (message === 'ready') entry.ready = true
    if (message === 'shutdown') entry.shutdowns++
  })
  await waitFor(() => entry.ready || child.exitCode !== null, 'the local daemon fixture')
  assert.ok(entry.ready, entry.errors)
  return entry
}

try {
  const agentDirectory = await fixture.folder('agent')
  const foreign = await startDaemon()
  const reused = await startDaemon()
  const wrongExecutable = await startDaemon()
  const unmatchedEndpoint = newEndpoint()
  const endpointSuffix = await startDaemon(`${unmatchedEndpoint}-other`)
  const snapshot = await processTable()
  const foreignIdentity = snapshot.find((entry) => entry.pid === foreign.child.pid)
  const reusedIdentity = snapshot.find((entry) => entry.pid === reused.child.pid)
  assert.ok(foreignIdentity?.createdMs > 0)
  assert.ok(reusedIdentity?.createdMs > 0)
  const registry = [
    { socketPath: foreign.endpoint, executablePath: process.execPath },
    { socketPath: reused.endpoint, executablePath: process.execPath },
    {
      socketPath: wrongExecutable.endpoint,
      executablePath: join(fixture.dir, 'another-runtime', basename(process.execPath))
    },
    { socketPath: unmatchedEndpoint, executablePath: process.execPath }
  ]
  await writeFile(join(agentDirectory, 'vengeance-daemons.json'), JSON.stringify(registry))
  await shutdownOwnedPrimeDaemons(agentDirectory, [
    foreignIdentity,
    { ...reusedIdentity, createdMs: reusedIdentity.createdMs - REUSED_PID_AGE_MS }
  ])
  await waitFor(() => reused.child.exitCode !== null, 'the owned daemon to exit')
  assert.equal(reused.shutdowns, 1)
  assert.equal(reused.child.exitCode, 0, reused.errors)
  console.log('PASS a reused PID with a newer creation identity is shut down gracefully')

  assert.ok(isAlive(foreign.child.pid))
  assert.equal(foreign.shutdowns, 0)
  console.log('PASS an alive foreign process with the same PID and creation identity is protected')

  assert.ok(isAlive(wrongExecutable.child.pid))
  assert.equal(wrongExecutable.shutdowns, 0)
  assert.ok(isAlive(endpointSuffix.child.pid))
  assert.equal(endpointSuffix.shutdowns, 0)
  console.log('PASS executable paths and endpoint arguments must match exactly')

  await writeFile(join(agentDirectory, 'vengeance-daemons.json'), JSON.stringify([registry[0]]))
  await shutdownOwnedPrimeDaemons(agentDirectory, [{ ...foreignIdentity, createdMs: undefined }])
  assert.ok(isAlive(foreign.child.pid))
  assert.equal(foreign.shutdowns, 0)
  console.log('PASS a foreign process with an unknown creation time remains protected')
} finally {
  const cleanupErrors = []
  try {
    for (const { child } of children) {
      if (child.exitCode !== null) continue
      try {
        if (child.connected) {
          await new Promise((resolveSend, rejectSend) => {
            child.send('stop', (error) => (error ? rejectSend(error) : resolveSend()))
          })
        }
        await waitFor(() => child.exitCode !== null, 'fixture cleanup')
      } catch (error) {
        cleanupErrors.push(error)
      } finally {
        if (child.exitCode === null) {
          try {
            await killTree(child.pid)
            await waitFor(() => child.exitCode !== null, 'forced fixture cleanup')
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
      }
    }
  } finally {
    await fixture.cleanup().catch((error) => cleanupErrors.push(error))
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'QA daemon fixture cleanup failed')
}
