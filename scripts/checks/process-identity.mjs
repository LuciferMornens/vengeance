import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processIdentity } from '../qa/lib/processes.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const CHILD_LIFETIME_MS = 30_000
const RESPONSE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 3000
const POLL_INTERVAL_MS = 25
const fixture = await tempRoot('vengeance-process-identity-')
const spoofedExecutable = join(fixture.dir, 'unrelated executable')
const childSource = `process.title = process.argv[1]
process.send({ title: process.title })
process.on('message', (message) => {
  if (message === 'stop') {
    process.disconnect()
    return
  }
  process.title = message.title
  process.send({ title: process.title })
})
`

async function waitForExit(child) {
  const deadline = Date.now() + EXIT_TIMEOUT_MS
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) throw new Error('The disposable identity child did not exit')
    await delay(POLL_INTERVAL_MS)
  }
}

const child = spawn(process.execPath, ['-e', childSource, spoofedExecutable], {
  cwd: fixture.dir,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  windowsHide: true,
  timeout: CHILD_LIFETIME_MS,
  killSignal: 'SIGKILL'
})
let diagnostics = ''
child.stderr.on('data', (chunk) => {
  diagnostics += String(chunk)
})

try {
  const [ready] = await once(child, 'message', {
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS)
  })
  assert.equal(ready.title, spoofedExecutable)
  const expectedExecutable = await realpath(process.execPath)
  const spoofed = await processIdentity(child.pid)
  assert.equal(spoofed.pid, child.pid)
  assert.equal(spoofed.parentPid, process.pid)
  assert.equal(spoofed.executablePath, expectedExecutable)
  assert.notEqual(spoofed.executablePath, spoofedExecutable)
  console.log('PASS a forged absolute process title cannot replace the real executable identity')

  const renamed = once(child, 'message', {
    signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS)
  })
  child.send({ title: 'pi' })
  assert.equal((await renamed)[0].title, 'pi')
  const engineTitle = await processIdentity(child.pid)
  assert.equal(engineTitle.pid, child.pid)
  assert.equal(engineTitle.parentPid, process.pid)
  assert.equal(engineTitle.executablePath, expectedExecutable)
  console.log('PASS a relative Engine title still resolves to its real executable and parent')

  child.send('stop')
  await waitForExit(child)
  assert.equal(child.exitCode, 0, diagnostics)
  await assert.rejects(processIdentity(child.pid))
  console.log('PASS an exited process has no usable executable identity')
} finally {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForExit(child).catch(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await waitForExit(child)
    })
  } finally {
    await fixture.cleanup()
  }
}
