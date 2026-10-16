// Shell-domain QA helpers on top of the shared harness (scripts/qa/lib):
// - launchRaw(): Playwright launch with a caller-owned, persistent profile (restart tests), no
//   window resize at launch, optional test mode OFF (single instance), packaged exe or out/ app;
// - palette driving, CDP folder drag-and-drop, memory metrics, screenshots into the report folder.
// Process inspection, soft steps and temp folders come from scripts/qa/lib and are re-exported here.
import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { reportShotsDir, ROOT } from '../../lib/app.mjs'
import { isAlive, killTree } from '../../lib/processes.mjs'

export { descendants, isAlive, killTree, processTable } from '../../lib/processes.mjs'
export { softSteps } from '../../lib/steps.mjs'
export { tempRoot } from '../../lib/tmp.mjs'

export const PACKAGED_EXE = join(ROOT, 'release', 'win-unpacked', 'Vengeance.exe')
export const SHOTS_DIR = reportShotsDir('shell')
const INHERITED_ENGINE_VARS = /^(PI_|AI_AGENT$)/
const INHERITED_PRIME_VARS = /^PRIME_/
const MAIN_ERROR_MARKER = '[qa main error]'

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export async function waitUntil(
  predicate,
  { timeoutMs = 30_000, intervalMs = 100, label = 'condition' } = {}
) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(intervalMs)
  }
}

export async function shot(page, name, { settleMs = 400 } = {}) {
  await mkdir(SHOTS_DIR, { recursive: true })
  await page.evaluate(() => document.fonts.ready).catch(() => undefined)
  await page.waitForTimeout(settleMs)
  const path = join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path })
  return path
}

/** Pre-seed `<userData>/app-state.json` (prefs merged over the app defaults at load). */
export async function seedAppState(userData, state) {
  await mkdir(userData, { recursive: true })
  await writeFile(join(userData, 'app-state.json'), JSON.stringify(state, null, 2))
}

/**
 * Launch Vengeance on a caller-owned profile. Unlike lib/app.mjs launchApp() it keeps the saved
 * window bounds (no resize), can run with test mode OFF (`test: false`, which also takes the
 * single-instance lock on the temp profile) and never deletes the profile.
 */
export async function launchRaw({
  exe,
  userData,
  agentDir,
  test = true,
  env: extraEnv = {},
  args: extraArgs = [],
  timeoutMs = 60_000
}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !INHERITED_ENGINE_VARS.test(name) && (!agentDir || !INHERITED_PRIME_VARS.test(name))
    )
  )
  delete env.VENGEANCE_MOCK
  delete env.VENGEANCE_TEST
  const tempFolder = join(userData, '..', 'tmp')
  await mkdir(tempFolder, { recursive: true })
  Object.assign(env, {
    VENGEANCE_NO_MICA: '1',
    VENGEANCE_USER_DATA: userData,
    TEMP: tempFolder,
    TMP: tempFolder,
    TMPDIR: tempFolder
  })
  if (test) env.VENGEANCE_TEST = '1'
  if (agentDir) {
    // Fake mode: the engine's user skills come from $HOME/.agents/skills (see lib/app.mjs).
    const homeFolder = join(userData, '..', 'home')
    await mkdir(homeFolder, { recursive: true })
    const primeDir = join(userData, '..', 'prime-agent')
    await mkdir(primeDir, { recursive: true })
    Object.assign(env, {
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
  const executablePath = exe ? resolve(exe) : null
  if (executablePath && !existsSync(executablePath)) throw new Error(`Missing ${executablePath}`)
  const args = ['--force-device-scale-factor=1', ...extraArgs]
  const started = Date.now()
  const app = await electron.launch(
    executablePath
      ? { executablePath, args, env, timeout: timeoutMs }
      : { args: [ROOT, ...args], env, timeout: timeoutMs }
  )
  const pid = app.process().pid
  const stderr = []
  app.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  await app.evaluate(({ app: electronApp }, marker) => {
    const report = (error) => process.stderr.write(`${marker} ${error?.stack ?? error}\n`)
    process.on('uncaughtException', report)
    process.on('unhandledRejection', report)
    electronApp.on('render-process-gone', (_event, _contents, details) =>
      process.stderr.write(`${marker} render-process-gone ${JSON.stringify(details)}\n`)
    )
  }, MAIN_ERROR_MARKER)
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`))
  page.on('crash', () => errors.push('[crash] renderer process crashed'))
  page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`))
  await page.waitForFunction(() => document.querySelector('header') !== null, null, {
    timeout: timeoutMs
  })
  const invoke = (channel, ...channelArgs) =>
    page.evaluate(
      ([name, values]) => window.vengeance.invoke(name, ...values),
      [channel, channelArgs]
    )
  const mainErrors = () =>
    stderr
      .join('')
      .split(/\r?\n/)
      .filter((line) => line.startsWith(MAIN_ERROR_MARKER))
  return {
    app,
    page,
    pid,
    launchedAt: started,
    invoke,
    stderr: () => stderr.join(''),
    errors: () => [...errors, ...mainErrors()],
    test: (method, ...methodArgs) =>
      page.evaluate(
        ([name, values]) => window.__vengeanceTest[name](...values),
        [method, methodArgs]
      ),
    win: (fn, arg) =>
      app.evaluate(
        ({ BrowserWindow }, [source, value]) => {
          // eslint-disable-next-line no-new-func
          const run = new Function('win', 'value', `return (${source})(win, value)`)
          return run(BrowserWindow.getAllWindows()[0], value)
        },
        [fn.toString(), arg]
      ),
    /** Graceful quit (window close → before-quit → engine shutdown); kill if it hangs. */
    async close({ timeoutMs: quitTimeout = 15_000 } = {}) {
      const quit = await Promise.race([
        app.close().then(
          () => true,
          () => false
        ),
        sleep(quitTimeout).then(() => false)
      ])
      if (!quit || isAlive(pid)) await killTree(pid)
      return quit
    },
    kill: () => killTree(pid)
  }
}

/** Ctrl+K, type `query`, click the palette row titled `title` (string = start of the row, or RegExp). */
export async function runPalette(page, query, title = query) {
  const input = page.locator('input[role="combobox"]')
  // Never type into a palette that is still playing its close animation (see shell-crash.qa.mjs).
  await input.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(250)
  await page.keyboard.press('Control+k')
  await input.fill(query)
  const option = page
    .getByRole('option')
    .filter({ hasText: typeof title === 'string' ? new RegExp(`^${escapeRegExp(title)}`) : title })
    .first()
  await option.waitFor({ timeout: 5000 })
  // The list re-renders while cmdk filters: highlight the row (hover), then choose it with Enter.
  for (let attempt = 0; attempt < 20; attempt++) {
    await option.hover().catch(() => undefined)
    if ((await option.getAttribute('aria-selected').catch(() => null)) === 'true') break
    await page.waitForTimeout(50)
  }
  await page.keyboard.press('Enter')
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Drag `paths` from the OS onto the element at `selector` through CDP (real File objects with
 * paths, as Explorer drops them).
 */
export async function dropPaths(page, selector, paths) {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`No drop target ${selector}`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: paths, dragOperationsMask: 1 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data })
  await cdp.detach()
}

/** Working-set bytes of the app's Electron processes (main, renderer, GPU, utility). */
export async function electronMemory(app) {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      workingSetKb: metric.memory.workingSetSize,
      privateKb: metric.memory.privateBytes ?? null
    }))
  )
}

/**
 * Two of these in a row drive the palette while it plays its close animation (fill + hover on the
 * closing palette), for renderer-crash.qa.mjs. Hovers are bounded: the closing row detaches and an
 * unbounded hover waits for it forever (that hang, killed from outside, looked like a crash).
 */
export async function paletteWithoutClosePause(page, query) {
  const input = page.locator('input[role="combobox"]')
  await page.keyboard.press('Control+k')
  await input.fill(query)
  const option = page
    .getByRole('option')
    .filter({ hasText: new RegExp(`^${escapeRegExp(query)}`) })
    .first()
  await option.waitFor({ timeout: 5000 })
  for (let attempt = 0; attempt < 20; attempt++) {
    await option.hover({ timeout: 1000 }).catch(() => undefined)
    const selected = await option.getAttribute('aria-selected', { timeout: 1000 }).catch(() => null)
    if (selected === 'true') break
    await page.waitForTimeout(50)
  }
  await page.keyboard.press('Enter')
}
