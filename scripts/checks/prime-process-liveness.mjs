import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { isAlive } from '../qa/lib/processes.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const RESPONSE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 3000
const CHILD_LIFETIME_MS = 30_000
const POLL_INTERVAL_MS = 25
const linux = process.platform === 'linux'
const bundled = await build({
  entryPoints: [
    fileURLToPath(new URL('../../src/main/engine/prime/process-liveness.ts', import.meta.url))
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent'
})
const { nativeProcessIsAlive } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

// The Python parent holds its own exited child until the test asks it to waitpid.
const pythonSource = `import json
import os
import signal
import sys

read_end, write_end = os.pipe()
worker = os.fork()
if worker == 0:
    os.close(write_end)
    os.read(read_end, 1)
    os._exit(0)
os.close(read_end)

def interrupt(signum, frame):
    raise TimeoutError("Disposable zombie witness interrupted")

def release_worker():
    global write_end
    if write_end is not None:
        os.close(write_end)
        write_end = None

signal.signal(signal.SIGTERM, interrupt)
print(json.dumps({"pid": worker}), flush=True)
try:
    for command in sys.stdin:
        if command.strip() == "exit":
            release_worker()
        elif command.strip() == "reap":
            release_worker()
            os.waitpid(worker, 0)
            worker = 0
            print(json.dumps({"reaped": True}), flush=True)
            break
finally:
    release_worker()
    if worker:
        try:
            os.kill(worker, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(worker, 0)
`
const nodeSource = `console.log(JSON.stringify({ pid: process.pid }))
process.stdin.on('data', () => process.exit(0))
process.stdin.resume()
`
const executable = linux ? (process.env.PYTHON ?? 'python3') : process.execPath
const argumentsList = linux ? ['-I', '-B', '-u', '-c', pythonSource] : ['-e', nodeSource]
const fixture = await tempRoot('vengeance-process-liveness-')
const child = spawn(executable, argumentsList, {
  cwd: fixture.dir,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  timeout: CHILD_LIFETIME_MS,
  killSignal: 'SIGTERM'
})
const reader = createInterface({ input: child.stdout })
const lines = reader[Symbol.asyncIterator]()
let diagnostics = ''
let spawnError
let failure
child.on('error', (error) => {
  spawnError = error
})
child.stdin.on('error', (error) => {
  spawnError ??= error
})
child.stderr.on('data', (chunk) => {
  diagnostics += String(chunk)
})

async function within(task, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(`${label}: ${diagnostics}`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function waitForExit() {
  while (child.exitCode === null && child.signalCode === null) await delay(POLL_INTERVAL_MS)
}

try {
  const first = await within(lines.next(), RESPONSE_TIMEOUT_MS, 'No disposable child PID')
  if (spawnError) throw spawnError
  assert.equal(first.done, false, diagnostics)
  const { pid } = JSON.parse(first.value)
  assert.equal(await nativeProcessIsAlive(pid), true)
  assert.equal(isAlive(pid), true)
  console.log('PASS production and QA liveness keep a disposable live process alive')

  if (linux) {
    child.stdin.write('exit\n')
    await within(
      (async () => {
        while (!/^State:\s+Z\b/m.test(await readFile(join('/proc', String(pid), 'status'), 'utf8')))
          await delay(POLL_INTERVAL_MS)
      })(),
      RESPONSE_TIMEOUT_MS,
      'The disposable child did not become an unreaped zombie'
    )
    process.kill(pid, 0)
    assert.equal(await nativeProcessIsAlive(pid), false)
    assert.equal(isAlive(pid), false)
    console.log('PASS an actual unreaped Linux zombie is exited despite successful kill(pid, 0)')
    child.stdin.write('reap\n')
    const reaped = await within(lines.next(), RESPONSE_TIMEOUT_MS, 'The parent did not reap')
    assert.deepEqual(JSON.parse(reaped.value), { reaped: true })
  } else {
    child.stdin.write('reap\n')
    console.log('SKIP Linux zombie witness on this host; live and reaped checks still run')
  }
  await within(waitForExit(), EXIT_TIMEOUT_MS, 'The disposable parent did not exit')
  assert.equal(child.exitCode, 0, diagnostics)
  assert.equal(await nativeProcessIsAlive(pid), false)
  assert.equal(isAlive(pid), false)
  console.log('PASS a reaped process has no live native runtime')
} catch (error) {
  failure = error
} finally {
  reader.close()
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end('reap\n')
      await within(waitForExit(), EXIT_TIMEOUT_MS, 'The disposable parent did not clean up').catch(
        async () => {
          child.kill('SIGTERM')
          await within(waitForExit(), EXIT_TIMEOUT_MS, 'The parent did not reap before exiting')
        }
      )
    }
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'Liveness assertion and fixture cleanup failed')
      : error
  } finally {
    await fixture.cleanup().catch((error) => {
      failure ??= error
    })
  }
}
if (failure) throw failure
