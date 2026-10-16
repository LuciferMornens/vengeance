// A Vengeance launcher whose userData outlives one app run, so app-only preferences
// (`<userData>/app-state.json`) can be checked across a real quit and relaunch. The harness's
// launchApp() always makes (and deletes) a fresh userData; see reports/qa/settings.md, "Harness notes".
// Same isolation as launchApp(): temp userData and TEMP, temp PI_CODING_AGENT_DIR, offline engine,
// no single-instance lock shared with the user's Vengeance.
import { _electron as electron } from 'playwright'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ROOT } from '../lib/app.mjs'
import { SHOTS_DIR } from './settings-ui.mjs'

const execFileAsync = promisify(execFile)
const SIZE = { width: 1440, height: 900 }
const LAUNCH_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 15_000
const INHERITED_ENGINE_VARS = /^(PI_|AI_AGENT$)/

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Kill a process tree this launcher started. */
async function killTree(pid) {
  await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined)
}

/** A temp folder holding the userData and TEMP of every run of one suite; `dispose()` removes it. */
export async function createPersistentProfile() {
  const root = await mkdtemp(join(tmpdir(), 'vengeance-qa-profile-'))
  const userData = join(root, 'user-data')
  const tempFolder = join(root, 'tmp')
  await Promise.all([userData, tempFolder].map((dir) => mkdir(dir)))
  return {
    root,
    userData,
    tempFolder,
    dispose: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/**
 * Launch the built app on `profile` with the fake engine config in `agentDir`. Returns the small
 * subset of the harness app API the settings helpers use (page, test, invoke, rpc, screenshot,
 * send, close) plus `errors()`.
 */
export async function launchPersistentApp({ profile, agentDir }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !INHERITED_ENGINE_VARS.test(name))
  )
  delete env.VENGEANCE_MOCK
  Object.assign(env, {
    VENGEANCE_TEST: '1',
    VENGEANCE_NO_MICA: '1',
    VENGEANCE_USER_DATA: profile.userData,
    TEMP: profile.tempFolder,
    TMP: profile.tempFolder,
    TMPDIR: profile.tempFolder,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0'
  })
  const electronApp = await electron.launch({
    args: [ROOT, '--force-device-scale-factor=1'],
    env,
    timeout: LAUNCH_TIMEOUT_MS
  })
  const appPid = electronApp.process().pid
  const errors = []
  const page = await electronApp.firstWindow()
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`))
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.unmaximize()
    win.setContentSize(size.width, size.height)
    win.center()
  }, SIZE)
  await page.waitForFunction(
    () => !!window.__vengeanceTest && document.querySelector('header') !== null,
    null,
    { timeout: READY_TIMEOUT_MS }
  )
  await page.evaluate(() => document.fonts.ready)
  const isolation = await electronApp.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    holdsLock: app.hasSingleInstanceLock()
  }))
  if (resolve(isolation.userData) !== resolve(profile.userData) || isolation.holdsLock) {
    await killTree(appPid)
    throw new Error(`QA app is not isolated: ${JSON.stringify(isolation)}`)
  }

  const test = (method, ...args) =>
    page.evaluate(([name, values]) => window.__vengeanceTest[name](...values), [method, args])
  const invoke = (channel, ...args) =>
    page.evaluate(([name, values]) => window.vengeance.invoke(name, ...values), [channel, args])

  return {
    page,
    userData: profile.userData,
    test,
    invoke,
    agentState: (agentId) => test('agentState', agentId),
    errors: () => [...errors],
    async rpc(command, agentId) {
      const response = await invoke(
        'engine:command',
        agentId ?? (await test('activeAgentId')),
        command
      )
      if (!response.success) throw new Error(`${command.type}: ${response.error}`)
      return response.data
    },
    /** Type into the one composer, send, and wait for the run to settle. */
    async send(text) {
      const composer = page.getByRole('textbox', { name: 'Message' })
      await composer.fill(text)
      await composer.press('Enter')
      await page.waitForTimeout(200)
      await test('waitForIdle', 60_000)
    },
    async screenshot(name, { settleMs = 400 } = {}) {
      await mkdir(SHOTS_DIR, { recursive: true })
      await page.waitForTimeout(settleMs)
      const path = join(SHOTS_DIR, `${name}.png`)
      await page.screenshot({ path })
      return path
    },
    /** Quit like a user (prefs flush on quit), then kill anything of this run that survived. */
    async close() {
      const engines = await invoke('engine:list').catch(() => [])
      let timer
      const quit = await Promise.race([
        electronApp.close().then(
          () => true,
          () => false
        ),
        new Promise((done) => {
          timer = setTimeout(() => done(false), CLOSE_TIMEOUT_MS)
        })
      ])
      clearTimeout(timer)
      if (!quit || isAlive(appPid)) await killTree(appPid)
      for (const { pid } of engines) if (pid && isAlive(pid)) await killTree(pid)
    }
  }
}
