import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { shutdownOwnedPrimeDaemons } from '../qa/lib/app.mjs'
import { isAlive, killTree, processIdentity, processTable } from '../qa/lib/processes.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const CHILD_TIMEOUT_MS = 10_000
const POLL_MS = 25
const REUSED_PID_AGE_MS = 60_000
/** Short budgets keep the slow-exit cases fast; the fixture's slow exit lands between them. */
const GRACEFUL_MS = 300
const UNVERIFIED_MS = 4_000
const SLOW_EXIT_MS = 1_500
/** A daemon that exits at once must return long before a generous budget runs out. */
const FAST_PATH_BUDGET_MS = 60_000
const fixture = await tempRoot('vengeance-qa-daemon-cleanup-')
const children = []

// argv: the endpoint, then how long the daemon takes to exit after acknowledging a shutdown
// (milliseconds, or 'hold' to keep running until the check stops it).
const daemonSource = `
  import { createServer } from 'node:net'
  const endpoint = process.argv[1]
  const exitDelay = process.argv[2]
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
      if (exitDelay === 'hold') return
      setTimeout(() => server.close(() => process.disconnect()), Number(exitDelay))
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

async function startDaemon(endpoint = newEndpoint(), exitDelay = 0) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', daemonSource, endpoint, String(exitDelay)],
    {
      cwd: fixture.dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    }
  )
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

/** macOS's identity: no creation time, so the PID can never be force-stopped. */
async function unverifiedIdentity(pid) {
  return { ...(await processIdentity(pid)), createdMs: undefined }
}

try {
  const agentDirectory = await fixture.folder('agent')
  // processIdentity resolves the executable's real path on macOS.
  const nodeExecutable = await realpath(process.execPath)
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
    { socketPath: foreign.endpoint, executablePath: nodeExecutable },
    { socketPath: reused.endpoint, executablePath: nodeExecutable },
    {
      socketPath: wrongExecutable.endpoint,
      executablePath: join(fixture.dir, 'another-runtime', basename(process.execPath))
    },
    { socketPath: unmatchedEndpoint, executablePath: nodeExecutable }
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

  const quick = await startDaemon()
  await writeFile(
    join(agentDirectory, 'vengeance-daemons.json'),
    JSON.stringify([{ socketPath: quick.endpoint, executablePath: nodeExecutable }])
  )
  const quickStarted = Date.now()
  await shutdownOwnedPrimeDaemons(agentDirectory, [], { gracefulMs: FAST_PATH_BUDGET_MS })
  assert.ok(
    Date.now() - quickStarted < FAST_PATH_BUDGET_MS / 2,
    'A quick exit waited for the budget'
  )
  await waitFor(() => quick.child.exitCode !== null, 'the quick daemon to exit')
  assert.equal(quick.child.exitCode, 0, quick.errors)
  console.log('PASS a daemon that exits at once returns without waiting for the budget')

  const slow = await startDaemon(newEndpoint(), SLOW_EXIT_MS)
  await writeFile(
    join(agentDirectory, 'vengeance-daemons.json'),
    JSON.stringify([{ socketPath: slow.endpoint, executablePath: nodeExecutable }])
  )
  await shutdownOwnedPrimeDaemons(agentDirectory, [], {
    gracefulMs: GRACEFUL_MS,
    unverifiedMs: UNVERIFIED_MS,
    identify: unverifiedIdentity
  })
  await waitFor(() => slow.child.exitCode !== null, 'the slow daemon to exit')
  assert.equal(slow.shutdowns, 1)
  assert.equal(slow.child.exitCode, 0, slow.errors)
  console.log('PASS an unverifiable daemon gets past the graceful budget to exit on its own')

  const held = await startDaemon(newEndpoint(), 'hold')
  await writeFile(
    join(agentDirectory, 'vengeance-daemons.json'),
    JSON.stringify([{ socketPath: held.endpoint, executablePath: nodeExecutable }])
  )
  const heldStarted = Date.now()
  await assert.rejects(
    shutdownOwnedPrimeDaemons(agentDirectory, [], {
      gracefulMs: GRACEFUL_MS,
      unverifiedMs: UNVERIFIED_MS,
      identify: unverifiedIdentity
    }),
    new RegExp(`Cannot safely force-stop QA daemon ${held.child.pid}: creation time unavailable`)
  )
  assert.ok(Date.now() - heldStarted >= UNVERIFIED_MS, 'The unverified wait ended early')
  assert.ok(isAlive(held.child.pid))
  assert.equal(held.shutdowns, 1)
  console.log('PASS an unverifiable daemon that never exits is reported, never force-stopped')
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
