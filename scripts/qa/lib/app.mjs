// Launch Vengeance for a QA suite: the BUILT app (out/, `npm run build` first) or a packaged exe,
// driven through Playwright `_electron` with a temp profile and (fake mode) a temp engine config.
//
// Isolation from the user's own running Vengeance: VENGEANCE_TEST=1 skips the single-instance lock
// (main/index.ts), so this instance never takes the user's lock or signals their instance, and
// VENGEANCE_USER_DATA points the profile at a temp folder. launchApp() checks both on the live app,
// and close() checks that every Vengeance process that was running before the launch still runs.
// Fake mode also gives the app a temp HOME, so the engine never loads the user's ~/.agents/skills;
// workspaces therefore live outside the user's profile (lib/tmp.mjs explains why).
import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_PROCESS_NAME, ELECTRON_SWITCHES } from './platform.mjs'
import {
  isAlive,
  killTree,
  pidsOfImage,
  processIdentity,
  processTable,
  processWasPresent,
  sameProcess
} from './processes.mjs'
import { snapshotRealConfig, REAL_PROMPT_MAX_CHARS } from './real-guard.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT, qaTempDir } from './tmp.mjs'
import { assertTempPath } from './agent-dir.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DEFAULT_SHOTS_DIR = join(ROOT, '.shots', 'qa')

/**
 * Folder for one area's screenshots: `<QA_REPORT_DIR>/<area>-shots`. QA_REPORT_DIR defaults to
 * the git-ignored `.shots/qa`, so a run never writes outside the repo.
 */
export function reportShotsDir(area) {
  return join(
    process.env.QA_REPORT_DIR ? resolve(process.env.QA_REPORT_DIR) : DEFAULT_SHOTS_DIR,
    `${area}-shots`
  )
}

const DEFAULT_SIZE = { width: 1440, height: 900 }
const LAUNCH_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 15_000
const DEFAULT_SETTLE_MS = 60_000
/** No engine event for this long after idle counts as settled (stats refresh, final frames). */
const QUIET_MS = 300
const POLL_MS = 50
const MAIN_ERROR_MARKER = '[qa main error]'
/** Inherited engine variables (e.g. when QA runs inside an agent) would change engine behavior. */
const INHERITED_ENGINE_VARS = /^(PI_|AI_AGENT$)/
const INHERITED_PRIME_VARS = /^PRIME_/
const DAEMON_SHUTDOWN_TIMEOUT_MS = 5000
/** Engine 2 daemon endpoints: a named pipe on Windows, an absolute Unix socket path elsewhere. */
const DAEMON_ENDPOINT =
  process.platform === 'win32'
    ? /^\\\\\.\\pipe\\vengeance-engine2-[a-f0-9]{20}$/
    : /^\/(?:.+\/)?vengeance-engine2-[a-f0-9]{20}\.sock$/

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

// Native Prime uses two 12-character worker IDs under TMPDIR, outside the app's socket fallback.
const NATIVE_WORKER_NAME = 'worker-000000000000-000000000000.sock'
const UNIX_SOCKET_PATH_CAPACITY = { darwin: 104, linux: 108 }

export function assertNativeWorkerSocketBudget(
  temporaryDirectory,
  { platform = process.platform, userId = process.getuid?.() } = {}
) {
  if (platform === 'win32') return
  const capacity = UNIX_SOCKET_PATH_CAPACITY[platform]
  if (!capacity) throw new Error(`QA has no native socket path budget for ${platform}`)
  if (typeof temporaryDirectory !== 'string' || !posix.isAbsolute(temporaryDirectory)) {
    throw new Error('QA requires an absolute TMPDIR for native Engine 2 workers')
  }
  if (!Number.isInteger(userId) || userId < 0) {
    throw new Error('QA could not determine the native Engine 2 worker user ID')
  }
  const endpoint = `${temporaryDirectory}/prime-agent-${userId}/${NATIVE_WORKER_NAME}`
  const requiredBytes = Buffer.byteLength(endpoint) + 1
  if (requiredBytes > capacity) {
    throw new Error(
      `Native Engine 2 worker socket needs ${requiredBytes} bytes; ${platform} allows ` +
        `${capacity}. Set a shorter QA_TMP_ROOT or a shorter TMPDIR inside it.`
    )
  }
}

function buildEnv({ mode, agentDir, primeDir, userData, tempFolder, homeFolder, extraEnv }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !INHERITED_ENGINE_VARS.test(name) && (mode !== 'fake' || !INHERITED_PRIME_VARS.test(name))
    )
  )
  delete env.VENGEANCE_MOCK
  Object.assign(env, {
    VENGEANCE_TEST: '1',
    VENGEANCE_NO_MICA: '1',
    VENGEANCE_USER_DATA: userData,
    TEMP: tempFolder,
    TMP: tempFolder,
    // Prime scopes worker sockets by supervisor hash and worker ID under this short root.
    TMPDIR: process.platform === 'win32' ? tempFolder : QA_TMP_ROOT
  })
  if (mode === 'fake') {
    // The fake LLM is local; no catalog refresh, version check or telemetry should leave the box.
    Object.assign(env, {
      // The engine (and main's trust check, which mirrors it) finds user skills under
      // `process.env.HOME || homedir()`; on Windows Electron's own paths use USERPROFILE and
      // stay real.
      HOME: homeFolder,
      PI_CODING_AGENT_DIR: agentDir,
      PRIME_AGENT_CODING_AGENT_DIR: primeDir,
      PRIME_AGENT_SESSION_DIR: join(primeDir, 'sessions'),
      PRIME_AGENT_CODING_AGENT_SESSION_DIR: join(primeDir, 'sessions'),
      PRIME_AGENT_KERNEL_VENV: join(primeDir, 'kernel-venv'),
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0'
    })
  }
  for (const [name, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  if (process.platform !== 'win32') {
    assertNativeWorkerSocketBudget(env.TMPDIR)
    if (!isInside(QA_TMP_ROOT, assertOutsideRealHome(env.TMPDIR))) {
      throw new Error('QA requires TMPDIR inside QA_TMP_ROOT for native Engine 2 workers')
    }
  }
  return env
}

async function stopDaemonEndpoint(endpoint) {
  await new Promise((resolveShutdown, rejectShutdown) => {
    const socket = createConnection(endpoint)
    const requestId = 'qa-owned-daemon-shutdown'
    let buffered = ''
    const finish = (error) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) rejectShutdown(error)
      else resolveShutdown()
    }
    const timer = setTimeout(
      () => finish(new Error('The isolated Engine 2 daemon did not stop')),
      DAEMON_SHUTDOWN_TIMEOUT_MS
    )
    socket.on('error', (error) =>
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? undefined : error)
    )
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      while (buffered.includes('\n')) {
        const newline = buffered.indexOf('\n')
        const line = buffered.slice(0, newline).trimEnd()
        buffered = buffered.slice(newline + 1)
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch (error) {
          finish(error)
          return
        }
        if (frame.type === 'daemon_hello') {
          socket.write(
            `${JSON.stringify({
              type: 'command',
              id: requestId,
              protocol: frame.protocol,
              command: { type: 'shutdown', force: true }
            })}\n`
          )
        } else if (frame.type === 'response' && frame.id === requestId) {
          finish(frame.success ? undefined : new Error(frame.error ?? 'Daemon shutdown failed'))
          return
        }
      }
    })
  })
}

function hasDaemonEndpoint(commandLine, endpoint) {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`).test(commandLine)
}

function executableKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Cleanup requires a QA temp registry and a daemon started during this run. */
export async function shutdownOwnedPrimeDaemons(agentDir, foreignProcesses) {
  assertTempPath(agentDir)
  assertOutsideRealHome(agentDir)
  const registry = await readFile(join(agentDir, 'vengeance-daemons.json'), 'utf8').catch(
    (error) => {
      if (error.code === 'ENOENT') return '[]'
      throw error
    }
  )
  const records = JSON.parse(registry)
  if (!Array.isArray(records)) throw new Error('The QA daemon registry is invalid')
  if (records.length === 0) return
  const table = await processTable()
  for (const record of records) {
    if (!DAEMON_ENDPOINT.test(record.socketPath) || typeof record.executablePath !== 'string') {
      throw new Error('The QA daemon registry contains an invalid endpoint')
    }
    const candidates = table.filter(
      (entry) =>
        !processWasPresent(entry, foreignProcesses) &&
        entry.name.toLowerCase() === basename(record.executablePath).toLowerCase() &&
        hasDaemonEndpoint(entry.commandLine, record.socketPath)
    )
    const owned = []
    for (const entry of candidates) {
      const identity = await processIdentity(entry.pid).catch(() => null)
      if (
        identity &&
        (!(identity.createdMs > 0) || sameProcess(identity, entry)) &&
        executableKey(identity.executablePath) === executableKey(record.executablePath)
      ) {
        owned.push(entry)
      }
    }
    if (owned.length === 0) continue
    try {
      await stopDaemonEndpoint(record.socketPath)
      // The daemon answers before it stops its workers. Killing it mid-stop leaves workers without
      // their stop record, and the next daemon on this agent dir revives unfinished work.
      const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS
      while (owned.some((entry) => isAlive(entry.pid)) && Date.now() < deadline) {
        await sleep(POLL_MS)
      }
    } finally {
      for (const entry of owned) {
        if (!isAlive(entry.pid)) continue
        const current = (await processTable()).find((candidate) => candidate.pid === entry.pid)
        if (!current || !hasDaemonEndpoint(current.commandLine, record.socketPath)) continue
        const identity = await processIdentity(entry.pid).catch(() => null)
        if (
          !identity ||
          executableKey(identity.executablePath) !== executableKey(record.executablePath)
        ) {
          continue
        }
        if (!(identity.createdMs > 0)) {
          throw new Error(
            `Cannot safely force-stop QA daemon ${entry.pid}: creation time unavailable`
          )
        }
        if (sameProcess(identity, entry)) await killTree(entry.pid)
      }
    }
  }
}

async function writeFiles(dir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      typeof content === 'string' || Buffer.isBuffer(content)
        ? content
        : JSON.stringify(content, null, 2)
    )
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(POLL_MS)
  }
}

/**
 * @param {object} options
 * @param {'fake' | 'real'} [options.mode] fake (default): temp engine config from createAgentDir();
 *   real: the user's real engine config, guarded by snapshotRealConfig(), tiny prompts only
 * @param {string} [options.agentDir] PI_CODING_AGENT_DIR for fake mode
 * @param {string} [options.exe] packaged executable instead of the built out/ app
 * @param {string} [options.outDir] screenshot folder (default .shots/qa)
 * @param {Record<string, string | undefined>} [options.env] extra app env (undefined deletes)
 * @param {RegExp[]} [options.allowErrors] renderer/main errors that do not fail the run
 * @param {{ width: number, height: number }} [options.size] window content size
 */
export function launchApp(options = {}) {
  return startApp(options, null)
}

/** `runRoot`: the temp folder of a previous run to launch on again (relaunch()), else a new one. */
async function startApp(options, runRoot, initialPrimeProcesses) {
  const {
    mode = 'fake',
    agentDir,
    exe,
    outDir = DEFAULT_SHOTS_DIR,
    env: extraEnv = {},
    allowErrors = [],
    size = DEFAULT_SIZE
  } = options
  if (mode === 'fake' && !agentDir) {
    throw new Error('launchApp: fake mode needs an agentDir (createAgentDir())')
  }
  if (mode === 'real' && agentDir) {
    throw new Error('launchApp: real mode uses the real config; drop agentDir')
  }
  const executablePath = exe ? resolve(exe) : null
  if (executablePath && !existsSync(executablePath)) {
    throw new Error(`Executable not found: ${executablePath}`)
  }
  if (!executablePath && !existsSync(join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('Build output missing: run `npm run build` first.')
  }

  // sessions/lib/kept-profile.mjs keys on the `vengeance-qa-run-*/user-data` folder names.
  const tempRoot = runRoot ?? (await qaTempDir('vengeance-qa-run-'))
  const userData = join(tempRoot, 'user-data')
  const tempFolder = join(tempRoot, 'tmp')
  const homeFolder = join(tempRoot, 'home')
  const workspacesRoot = join(tempRoot, 'workspaces')
  const primeDir = join(tempRoot, 'prime-agent')
  for (const dir of [userData, tempFolder, homeFolder, workspacesRoot, primeDir]) {
    await mkdir(dir, { recursive: true })
  }

  const realGuard = mode === 'real' ? await snapshotRealConfig() : null
  const foreignPids = await pidsOfImage(APP_PROCESS_NAME)
  const foreignPrimeProcesses =
    initialPrimeProcesses ?? (mode === 'fake' ? await processTable() : [])
  const env = buildEnv({ mode, agentDir, primeDir, userData, tempFolder, homeFolder, extraEnv })
  const args = ['--force-device-scale-factor=1', ...ELECTRON_SWITCHES]
  const app = await electron.launch(
    executablePath
      ? { executablePath, args, env, timeout: LAUNCH_TIMEOUT_MS }
      : { args: [ROOT, ...args], env, timeout: LAUNCH_TIMEOUT_MS }
  )
  const appPid = app.process().pid

  const errors = []
  const allowed = [...allowErrors]
  const mainStderr = []
  app.process().stderr?.on('data', (chunk) => mainStderr.push(String(chunk)))
  // An own listener replaces Electron's native error dialog; main-process failures go to stderr.
  await app.evaluate((_electron, marker) => {
    const report = (error) => process.stderr.write(`${marker} ${error?.stack ?? error}\n`)
    process.on('uncaughtException', report)
    process.on('unhandledRejection', report)
  }, MAIN_ERROR_MARKER)

  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`))
  page.on(
    'console',
    (message) => message.type() === 'error' && errors.push(`[console] ${message.text()}`)
  )
  await app.evaluate(({ BrowserWindow }, contentSize) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.unmaximize()
    win.setContentSize(contentSize.width, contentSize.height)
    win.center()
  }, size)
  await page.waitForFunction(
    () => !!window.__vengeanceTest && document.querySelector('header') !== null,
    null,
    { timeout: READY_TIMEOUT_MS }
  )
  await page.evaluate(() => document.fonts.ready)

  const isolation = await app.evaluate(({ app: electronApp }) => ({
    userData: electronApp.getPath('userData'),
    holdsLock: electronApp.hasSingleInstanceLock()
  }))
  if (resolve(isolation.userData) !== resolve(userData) || isolation.holdsLock) {
    await killTree(appPid)
    throw new Error(
      `QA app is not isolated from the user's Vengeance: ${JSON.stringify(isolation)}`
    )
  }

  const test = (method, ...methodArgs) =>
    page.evaluate(([name, values]) => window.__vengeanceTest[name](...values), [method, methodArgs])
  const invoke = (channel, ...channelArgs) =>
    page.evaluate(
      ([name, values]) => window.vengeance.invoke(name, ...values),
      [channel, channelArgs]
    )
  const agentState = (agentId) => test('agentState', agentId)

  const mainErrors = () =>
    mainStderr
      .join('')
      .split(/\r?\n/)
      .filter((line) => line.startsWith(MAIN_ERROR_MARKER))
  const unexpectedErrors = () =>
    [...errors, ...mainErrors()].filter((text) => !allowed.some((pattern) => pattern.test(text)))

  /**
   * The active session's composer. Only one session pane is visible, but after a switch the old
   * pane fades out (AnimatePresence) for a moment, so wait until exactly one composer is visible.
   */
  async function activeComposer() {
    const visible = page.locator('[data-composer]').filter({ visible: true })
    await waitUntil(
      async () => (await visible.count()) === 1,
      READY_TIMEOUT_MS,
      'a single visible session pane'
    )
    return visible
  }

  let closed = false

  /** Quit, kill this app's surviving tree, run the guards; keep the run folder when asked. */
  async function shutdown({ keepRunFolder, beforeCleanup }) {
    if (closed) return {}
    closed = true
    const engines = await invoke('engine:list').catch(() => [])
    const enginePids = engines
      .filter((engine) => engine.engine !== 'prime')
      .map((engine) => engine.pid)
      .filter(Boolean)
    let closeTimer
    const quitInTime = await Promise.race([
      app.close().then(
        () => true,
        () => false
      ),
      new Promise((resolveTimeout) => {
        closeTimer = setTimeout(() => resolveTimeout(false), CLOSE_TIMEOUT_MS)
      })
    ])
    clearTimeout(closeTimer)
    if (!quitInTime || isAlive(appPid)) await killTree(appPid)
    for (const pid of enginePids) if (isAlive(pid)) await killTree(pid)

    const problems = unexpectedErrors().map((text) => `app error: ${text}`)
    if (
      mode === 'fake' &&
      !keepRunFolder &&
      env.PRIME_AGENT_CODING_AGENT_DIR &&
      isInside(tempRoot, resolve(env.PRIME_AGENT_CODING_AGENT_DIR))
    ) {
      await shutdownOwnedPrimeDaemons(
        env.PRIME_AGENT_CODING_AGENT_DIR,
        foreignPrimeProcesses
      ).catch((error) => problems.push(error.message))
    }
    if (!keepRunFolder && beforeCleanup) {
      try {
        await beforeCleanup()
      } catch (error) {
        problems.push(`beforeCleanup: ${error?.message ?? error}`)
      }
    }
    const gone = foreignPids.filter((pid) => pid !== appPid && !isAlive(pid))
    for (const pid of gone) {
      problems.push(`a ${APP_PROCESS_NAME} the harness did not start exited (pid ${pid})`)
    }
    if (!keepRunFolder) {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
        (error) => console.warn(`  ⚠ temp folder left behind: ${tempRoot} (${error.message})`)
      )
    }
    let report = {}
    if (realGuard) {
      try {
        report = await realGuard.verify()
        if (report.authChanged) {
          console.log('  • auth.json changed during the run (engine OAuth refresh)')
        }
      } catch (error) {
        problems.push(error.message)
      }
    }
    if (problems.length) throw new Error(problems.join('\n'))
    return report
  }

  const qa = {
    mode,
    app,
    page,
    userData,
    test,
    invoke,
    agentState,
    appState: () => test('appState'),
    activeAgentId: () => test('activeAgentId'),

    /** RPC command to an agent (default: the active one); `data`, or throws on success:false. */
    async rpc(command, agentId) {
      const target = agentId ?? (await test('activeAgentId'))
      const response = await invoke('engine:command', target, command)
      if (!response.success) throw new Error(`${command.type}: ${response.error}`)
      return response.data
    },

    /** A fresh temp folder with `files` (relative path → text, Buffer or JSON). */
    async createWorkspace(files = { 'README.md': '# QA workspace\n' }) {
      const cwd = await mkdtemp(join(workspacesRoot, 'ws-'))
      await writeFiles(cwd, files)
      return cwd
    },

    /**
     * Open a workspace in a new session, wait for its engine and for the pane switch to finish.
     * `args` are CreateAgentArgs (model, thinking, noSession…); REAL mode always forces
     * `noSession: true`. Fake mode refuses a `cwd` inside the user's profile (lib/tmp.mjs).
     */
    async openWorkspace({ files, cwd, args = {} } = {}) {
      if (cwd && mode === 'fake') assertOutsideRealHome(cwd)
      const folder = cwd ?? (await qa.createWorkspace(files))
      const launchArgs = mode === 'real' ? { ...args, noSession: true } : args
      const agentId = await test('openWorkspace', folder, launchArgs)
      await waitUntil(
        async () => (await test('activeAgentId')) === agentId,
        READY_TIMEOUT_MS,
        'the new session to become active'
      )
      const composer = await activeComposer()
      await composer
        .getByRole('textbox', { name: 'Message' })
        .waitFor({ timeout: READY_TIMEOUT_MS })
      return { agentId, cwd: folder }
    },

    /** The active session's `Message` textbox (waits out a session switch). */
    async composer() {
      return (await activeComposer()).getByRole('textbox', { name: 'Message' })
    },

    /** Type `text`, press Enter, and wait for the active session's engine to accept it. */
    async send(text) {
      if (mode === 'real' && text.length > REAL_PROMPT_MAX_CHARS) {
        throw new Error(`REAL mode only sends tiny prompts (max ${REAL_PROMPT_MAX_CHARS} chars)`)
      }
      const before = (await agentState())?.entries.length ?? 0
      const composer = await qa.composer()
      await composer.fill(text)
      await composer.press('Enter')
      await waitUntil(
        async () => {
          const state = await agentState()
          return state && (state.phase === 'running' || state.entries.length > before)
        },
        READY_TIMEOUT_MS,
        'the engine to accept the prompt'
      )
    },

    /** Wait for the active agent to idle, its composer to stop running and events to stop. */
    async waitForSettle({ timeoutMs = DEFAULT_SETTLE_MS } = {}) {
      await test('waitForIdle', timeoutMs)
      const composer = await activeComposer()
      await waitUntil(
        async () => (await composer.getAttribute('data-running').catch(() => '')) === null,
        timeoutMs,
        'the composer to stop running'
      )
      let marker = -1
      let since = Date.now()
      await waitUntil(
        async () => {
          const lastEventAt = (await agentState())?.lastEventAt ?? 0
          if (lastEventAt !== marker) {
            marker = lastEventAt
            since = Date.now()
          }
          return Date.now() - since >= QUIET_MS
        },
        timeoutMs,
        'a quiet engine'
      )
    },

    click: (role, name, options = {}) => page.getByRole(role, { name, ...options }).click(),
    clickText: (text, options = {}) => page.getByText(text, options).first().click(),

    /** Save `<outDir>/<name>.png` after fonts and a short motion settle. */
    async screenshot(name, { settleMs = 400 } = {}) {
      await mkdir(outDir, { recursive: true })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(settleMs)
      const path = join(outDir, `${name}.png`)
      await page.screenshot({ path })
      return path
    },

    /** Errors so far that no `allowErrors` / `allowError()` pattern covers. */
    errors: unexpectedErrors,
    /** Let renderer/main errors matching `pattern` pass (for scenarios that provoke them). */
    allowError(pattern) {
      allowed.push(pattern)
    },
    assertNoErrors() {
      const found = unexpectedErrors()
      if (found.length) throw new Error(`App errors:\n  ${found.join('\n  ')}`)
    },

    /**
     * Quit the app, kill whatever of its own process tree survived, delete its temp folders and
     * check the user's Vengeance processes and (REAL mode) config. Throws on app errors or a
     * violated guard; returns `{ authChanged }` in REAL mode.
     * Pass beforeCleanup to release fixture workers that hold files under the app's TMP.
     */
    close: ({ beforeCleanup } = {}) => shutdown({ keepRunFolder: false, beforeCleanup }),

    /**
     * Quit (with the same checks as close()) and launch again on the same profile, workspaces and
     * temp HOME, so app state, open workspaces and sessions are tested across a real restart.
     * `overrides` replace launchApp() options. Close the returned app instead of this one.
     */
    async relaunch(overrides = {}) {
      await shutdown({ keepRunFolder: true })
      return startApp({ ...options, ...overrides }, tempRoot, foreignPrimeProcesses)
    }
  }
  return qa
}
