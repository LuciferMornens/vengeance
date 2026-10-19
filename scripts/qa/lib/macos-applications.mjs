import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { descendants, isAlive, killTree, processTable } from './processes.mjs'
import { isInside } from './tmp.mjs'

const executeFile = promisify(execFile)
const OBSERVER_SOURCE = fileURLToPath(
  new URL('./macos-application-observer.swift', import.meta.url)
)
const COMPILE_TIMEOUT_MS = 120_000
const WAIT_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 100
const OBSERVER_LIFETIME_MS = 15 * 60_000
const CHILD_EXIT_TIMEOUT_MS = 5000
const WITNESS_LIFETIME_MS = 30_000
const WITNESS_TICK_MS = 1000
const REGULAR_ACTIVATION_POLICY = 0
const ACCESSORY_ACTIVATION_POLICY = 1
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_WIDTH_OFFSET = 16
const PNG_HEIGHT_OFFSET = 20

async function until(predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function compileObserver(directory) {
  const executable = join(directory, 'application-observer')
  await executeFile(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
      OBSERVER_SOURCE,
      '-o',
      executable
    ],
    { timeout: COMPILE_TIMEOUT_MS }
  )
  return executable
}

async function processIdentities(pids) {
  if (pids.length === 0) return []
  const result = await executeFile(
    '/bin/ps',
    ['-ww', '-o', 'pid=,lstart=,comm=', '-p', pids.join(',')],
    { timeout: WAIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } }
  ).catch((error) => {
    if (error.code === 1) return { stdout: error.stdout ?? '' }
    throw error
  })
  return result.stdout.split('\n').flatMap((line) => {
    const matched = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(
      line
    )
    return matched
      ? [
          {
            pid: Number(matched[1]),
            started: matched[2].replace(/\s+/g, ' '),
            executable: matched[3].trim()
          }
        ]
      : []
  })
}

function sameIdentity(first, second) {
  return (
    first.pid === second.pid &&
    first.started === second.started &&
    first.executable === second.executable
  )
}

export async function identifyMacQaChild(child) {
  assert.ok(child.pid, 'The QA child must have started')
  const identity = (await processIdentities([child.pid]))[0]
  assert.ok(identity, `Cannot record the creation identity of QA child ${child.pid}`)
  return identity
}

export async function stopMacQaChild(child, identity) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const current = (await processIdentities([child.pid]))[0]
  if (!current) return
  assert.ok(sameIdentity(identity, current), 'Refusing to stop a reused QA child PID')
  child.kill('SIGTERM')
  const exited = await until(
    () => child.exitCode !== null || child.signalCode !== null,
    'the identified QA child to exit',
    CHILD_EXIT_TIMEOUT_MS
  ).then(
    () => true,
    () => false
  )
  if (!exited) {
    const remaining = (await processIdentities([child.pid]))[0]
    if (remaining && sameIdentity(identity, remaining)) await killTree(child.pid)
  }
  const remaining = (await processIdentities([child.pid]))[0]
  assert.ok(!remaining || !sameIdentity(identity, remaining), 'The QA child did not stop')
}

export async function observeMacApplications({ directory, executable, reportDirectory }) {
  assert.equal(process.platform, 'darwin')
  await mkdir(directory, { recursive: true })
  await mkdir(reportDirectory, { recursive: true })
  const foregroundExecutable = await realpath(executable)
  const bundleRoot = dirname(dirname(dirname(foregroundExecutable)))
  assert.ok(bundleRoot.endsWith('.app'), 'QA_PACKAGED_EXE must be inside a macOS app bundle')
  const before = await processTable()
  const preexistingPids = new Set(before.map((entry) => entry.pid))
  const observerExecutable = await compileObserver(directory)
  const observer = spawn(observerExecutable, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: OBSERVER_LIFETIME_MS,
    killSignal: 'SIGKILL'
  })
  const owned = new Map()
  const excluded = new Set()
  const foregroundPids = new Set()
  const frames = []
  const checkpoints = []
  let latest
  let mainPid
  let mainIdentity
  let partial = ''
  let stderr = ''
  let failure
  let closing = false
  let polling
  let pollTimer
  let observerIdentity

  function belongsToRun(application) {
    if (preexistingPids.has(application.pid)) return false
    return (
      owned.has(application.pid) ||
      (application.executable && isInside(bundleRoot, application.executable))
    )
  }

  observer.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  observer.on('error', (error) => {
    failure ??= error
  })
  observer.once('exit', (code, signal) => {
    if (!closing) failure ??= new Error(`AppKit observer exited: ${code}/${signal}: ${stderr}`)
  })
  observer.stdout.setEncoding('utf8')
  observer.stdout.on('data', (chunk) => {
    partial += chunk
    while (partial.includes('\n')) {
      const newline = partial.indexOf('\n')
      const line = partial.slice(0, newline)
      partial = partial.slice(newline + 1)
      try {
        latest = JSON.parse(line)
        frames.push({
          ...latest,
          applications: latest.applications.filter(belongsToRun)
        })
      } catch (error) {
        failure ??= error
      }
    }
  })

  async function pollProcesses() {
    const rootIdentity = mainIdentity
    if (!rootIdentity) return
    const table = await processTable()
    const children = descendants(table, rootIdentity.pid).filter(
      (entry) => !preexistingPids.has(entry.pid) && !owned.has(entry.pid)
    )
    const identities = await processIdentities([
      rootIdentity.pid,
      ...children.map((entry) => entry.pid)
    ])
    const currentRoot = identities.find((candidate) => candidate.pid === rootIdentity.pid)
    if (!currentRoot || !sameIdentity(rootIdentity, currentRoot)) return
    for (const entry of children) {
      const identity = identities.find((candidate) => candidate.pid === entry.pid)
      if (identity) owned.set(entry.pid, { ...entry, identity, observedAt: Date.now() })
    }
  }

  function schedulePoll() {
    pollTimer = setTimeout(() => {
      polling = pollProcesses()
        .catch((error) => {
          failure ??= error
        })
        .finally(() => {
          if (!closing) schedulePoll()
        })
    }, POLL_INTERVAL_MS)
  }

  schedulePoll()
  try {
    observerIdentity = await identifyMacQaChild(observer)
    await until(() => {
      if (failure) throw failure
      return latest
    }, 'the AppKit observer to sample running applications')
  } catch (error) {
    closing = true
    clearTimeout(pollTimer)
    await polling
    if (observerIdentity) await stopMacQaChild(observer, observerIdentity)
    else if (observer.exitCode === null && observer.signalCode === null) observer.kill('SIGKILL')
    throw error
  }

  function assertBackgroundPolicies() {
    if (failure) throw failure
    for (const frame of frames) {
      const unexpected = frame.applications.filter(
        (application) =>
          !excluded.has(application.pid) &&
          !foregroundPids.has(application.pid) &&
          application.activationPolicy === REGULAR_ACTIVATION_POLICY
      )
      assert.deepEqual(unexpected, [], 'Background processes must not register as foreground apps')
    }
  }

  return {
    bundleRoot,
    foregroundExecutable,
    async attach(pid) {
      const identity = (await processIdentities([pid]))[0]
      assert.ok(identity, `Cannot record foreground app ${pid} creation identity`)
      mainPid = pid
      mainIdentity = identity
      foregroundPids.add(pid)
      await pollProcesses()
      await until(
        () =>
          latest.applications.find(
            (application) =>
              application.pid === pid && application.activationPolicy === REGULAR_ACTIVATION_POLICY
          ),
        'the foreground Vengeance app to keep its Dock presence'
      )
    },
    excludeWitness(pid) {
      excluded.add(pid)
    },
    async waitForPolicy(pid, policy) {
      return until(() => {
        if (failure) throw failure
        return latest.applications.find(
          (application) => application.pid === pid && application.activationPolicy === policy
        )
      }, `PID ${pid} to have activation policy ${policy}`)
    },
    async checkpoint(label, requiredPids = []) {
      await pollProcesses()
      const after = Date.now()
      await until(() => latest.time >= after, 'a fresh AppKit policy sample')
      const main = latest.applications.find((application) => application.pid === mainPid)
      assert.equal(
        main?.activationPolicy,
        REGULAR_ACTIVATION_POLICY,
        'The foreground Vengeance app must remain in the Dock'
      )
      assert.equal(main.executable, foregroundExecutable)
      for (const pid of requiredPids) {
        assert.ok(isAlive(pid), `${label}: required background process ${pid} must be alive`)
        assert.ok(owned.has(pid), `${label}: background process ${pid} must belong to this app`)
      }
      const identities = await processIdentities(requiredPids)
      for (const pid of requiredPids) {
        const identity = identities.find((candidate) => candidate.pid === pid)
        assert.ok(
          identity && sameIdentity(owned.get(pid).identity, identity),
          `${label}: required background process ${pid} must keep its creation identity`
        )
      }
      assertBackgroundPolicies()
      const checkpoint = {
        label,
        time: latest.time,
        applications: latest.applications.filter(belongsToRun),
        processes: [...owned.values()].filter((entry) => isAlive(entry.pid)),
        requiredPids
      }
      checkpoints.push(checkpoint)
      return checkpoint
    },
    async desktopScreenshot(label) {
      const screenshot = join(reportDirectory, `${label}-desktop.png`)
      const visibleDock = latest.dockWindows.some(
        (window) => window.onScreen && window.layer === latest.dockWindowLayer
      )
      assert.ok(
        visibleDock,
        'Desktop evidence needs a visible macOS Dock; disable Dock auto-hide on the QA host'
      )
      assert.ok(
        latest.screenCaptureAllowed,
        'Screen Recording permission is required for complete desktop and Dock evidence'
      )
      await executeFile('/usr/sbin/screencapture', ['-x', '-D', '1', screenshot], {
        timeout: WAIT_TIMEOUT_MS
      })
      const bytes = await readFile(screenshot)
      assert.ok(
        bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
        'Desktop capture must be a PNG; Screen Recording permission may be missing'
      )
      const imageWidth = bytes.readUInt32BE(PNG_WIDTH_OFFSET)
      const imageHeight = bytes.readUInt32BE(PNG_HEIGHT_OFFSET)
      assert.ok(imageWidth > 1 && imageHeight > 1, 'Desktop capture has no usable display pixels')
      return {
        path: screenshot,
        imageWidth,
        imageHeight,
        dockWindows: latest.dockWindows,
        screenCaptureAllowed: latest.screenCaptureAllowed
      }
    },
    async assertWorkersExited() {
      const identities = await processIdentities([...owned.keys()])
      const remaining = identities.filter((identity) =>
        sameIdentity(owned.get(identity.pid).identity, identity)
      )
      for (const identity of remaining) {
        const current = (await processIdentities([identity.pid]))[0]
        if (current && sameIdentity(identity, current)) await killTree(identity.pid)
      }
      assert.deepEqual(remaining, [], 'Owned background processes leaked after fixture shutdown')
    },
    async close(extraEvidence = {}) {
      closing = true
      clearTimeout(pollTimer)
      await polling
      await stopMacQaChild(observer, observerIdentity).catch((error) => {
        failure ??= error
      })
      try {
        assertBackgroundPolicies()
      } catch (error) {
        failure ??= error
      }
      const report = {
        platform: process.platform,
        architecture: process.arch,
        foregroundExecutable,
        mainPid,
        mainIdentity,
        foregroundPids: [...foregroundPids],
        observerIdentity,
        excludedWitnessPids: [...excluded],
        checkpoints,
        frames,
        ...extraEvidence,
        observerError: failure?.stack,
        observerStderr: stderr
      }
      if (failure) {
        report.status = 'failed'
        report.error = failure.stack
      }
      await writeFile(
        join(reportDirectory, 'background-apps-evidence.json'),
        `${JSON.stringify(report, null, 2)}\n`
      )
      if (failure) throw failure
    }
  }
}

// AppKit initialization in a Node addon models native dependencies registering their host app.
export async function checkMacNodeWitness(observer, helperExecutable, directory, environment) {
  const addonSource = join(directory, 'appkit-witness.m')
  const addon = join(directory, 'appkit-witness.node')
  await writeFile(
    addonSource,
    `#import <AppKit/AppKit.h>
__attribute__((visibility("default")))
void *napi_register_module_v1(void *environment, void *exports) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp finishLaunching];
    }
    return exports;
}
`
  )
  await executeFile(
    '/usr/bin/xcrun',
    [
      'clang',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-framework',
      'AppKit',
      '-mmacosx-version-min=13.0',
      addonSource,
      '-o',
      addon
    ],
    { timeout: COMPILE_TIMEOUT_MS }
  )
  await executeFile('/usr/bin/codesign', ['--force', '--sign', '-', addon], {
    timeout: WAIT_TIMEOUT_MS
  })
  const script = [
    `require(${JSON.stringify(addon)})`,
    `setInterval(() => {}, ${WITNESS_TICK_MS})`
  ].join('\n')
  const results = []
  for (const [role, executable, policy] of [
    ['foreground-executable', observer.foregroundExecutable, REGULAR_ACTIVATION_POLICY],
    ['background-helper', helperExecutable, ACCESSORY_ACTIVATION_POLICY]
  ]) {
    const child = spawn(executable, ['-e', script], {
      cwd: directory,
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: WITNESS_LIFETIME_MS,
      killSignal: 'SIGKILL'
    })
    let stderr = ''
    let spawnError
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      spawnError = error
    })
    observer.excludeWitness(child.pid)
    let identity
    try {
      identity = await identifyMacQaChild(child)
      const application = await observer.waitForPolicy(child.pid, policy)
      assert.ok(isAlive(child.pid), `${role} witness must remain alive`)
      assert.equal(application.executable, await realpath(executable))
      results.push({ role, executable, identity, application, stderr })
    } catch (error) {
      throw new Error(`${role} witness failed: ${spawnError?.message ?? error.message}\n${stderr}`)
    } finally {
      if (identity) await stopMacQaChild(child, identity)
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }
  return { addon, results }
}
