// Screenshot harness: launches the BUILT app (npm run build first) with the mock engine and a temp
// profile, runs every scenario file in scripts/shots/*.mjs and writes PNGs to .shots/<name>.png.
//
//   npm run shots              all scenario files
//   npm run shots -- shell     only scripts/shots/shell.mjs
//
// Scenario files export `async function scenarios(page, helpers)`; helpers are documented below.
//
// Temp files: every scenario file gets its own temp root (<os tmp>/vengeance-shots-*) that is deleted
// when the file finishes. TEMP/TMP/TMPDIR point into it for the harness process and the launched app,
// so `mkdtemp(join(tmpdir(), …))` in a scenario and the mock engine's own temp folders are cleaned up
// too. `helpers.tempDir(prefix)` creates a folder there explicitly.
import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ELECTRON_SWITCHES } from './qa/lib/platform.mjs'
import { MOCK_WORKSPACE } from './shots/lib/mock-paths.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.shots')
const scenarioDir = join(root, 'scripts', 'shots')
const WIDTH = 1440
const HEIGHT = 900
/** The real temp folder, captured before TEMP/TMP are pointed at a scenario's temp root. */
const systemTmp = tmpdir()
const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR']

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing — run `npm run build` first.')
  process.exit(1)
}

/** Point TEMP/TMP/TMPDIR at `dir` for this process; returns a function that restores the previous values. */
function redirectTemp(dir) {
  const previous = TEMP_VARS.map((name) => [name, process.env[name]])
  for (const name of TEMP_VARS) process.env[name] = dir
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

async function launch(tempRoot) {
  const userData = join(tempRoot, 'user-data')
  await mkdir(userData)
  const app = await electron.launch({
    args: [root, '--force-device-scale-factor=1', ...ELECTRON_SWITCHES],
    env: {
      ...process.env,
      VENGEANCE_MOCK: '1',
      VENGEANCE_TEST: '1',
      VENGEANCE_NO_MICA: '1',
      VENGEANCE_USER_DATA: userData
    },
    timeout: 60_000
  })
  // Electron turns an uncaught main-process exception into a native error dialog. Report it on stderr
  // instead (an own listener replaces Electron's dialog handler) so quitting can be checked per file.
  const mainStderr = []
  app.process().stderr?.on('data', (chunk) => mainStderr.push(String(chunk)))
  await app.evaluate(() => {
    process.on('uncaughtException', (error) =>
      process.stderr.write(`[uncaught main exception] ${error?.stack ?? error}\n`)
    )
  })
  const page = await app.firstWindow()
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.unmaximize()
      win.setContentSize(size.width, size.height)
      win.center()
    },
    { width: WIDTH, height: HEIGHT }
  )
  await page.waitForFunction(
    () => !!window.__vengeanceTest && document.querySelector('header') !== null,
    null,
    { timeout: 30_000 }
  )
  await page.evaluate(() => document.fonts.ready)
  const uncaughtMainErrors = () =>
    mainStderr
      .join('')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[uncaught main exception]'))
  return { app, page, uncaughtMainErrors }
}

function makeHelpers(page, app, file, tempRoot) {
  return {
    app,
    MOCK_WORKSPACE,
    /** A fresh folder under this file's temp root (deleted with it after the file). */
    tempDir: (prefix = 'scratch-') => mkdtemp(join(tempRoot, 'tmp', prefix)),
    /** Save .shots/<name>.png (viewport). Waits for fonts + two frames so motion settles. */
    async shot(name, { settleMs = 450 } = {}) {
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(settleMs)
      const path = join(outDir, `${name}.png`)
      await page.screenshot({ path })
      console.log(`  ✓ ${name}.png  (${file})`)
      return path
    },
    /** Call a method of window.__vengeanceTest. */
    test(method, ...args) {
      return page.evaluate(([m, a]) => window.__vengeanceTest[m](...a), [method, args])
    },
    wait: (ms) => page.waitForTimeout(ms)
  }
}

const only = process.argv.slice(2)
const files = (await readdir(scenarioDir))
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.mjs$/, '')))
  .sort()

await mkdir(outDir, { recursive: true })
let failed = 0
for (const file of files) {
  console.log(`▶ ${file}`)
  const tempRoot = await mkdtemp(join(systemTmp, 'vengeance-shots-'))
  await mkdir(join(tempRoot, 'tmp'))
  const restoreTemp = redirectTemp(join(tempRoot, 'tmp'))
  const { app, page, uncaughtMainErrors } = await launch(tempRoot)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()))
  try {
    const mod = await import(pathToFileURL(join(scenarioDir, file)).href)
    await mod.scenarios(page, makeHelpers(page, app, file, tempRoot))
  } catch (error) {
    failed++
    console.error(`  ✗ ${file}: ${error.stack ?? error}`)
    await page
      .screenshot({ path: join(outDir, `${file.replace(/\.mjs$/, '')}-FAILED.png`) })
      .catch(() => undefined)
  } finally {
    if (errors.length) {
      console.warn(`  ⚠ renderer errors in ${file}:\n    ${errors.join('\n    ')}`)
    }
    await app.close().catch(() => undefined)
    restoreTemp()
    // Windows can hold a just-closed app's files for a moment: retry instead of leaking the folder.
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      (error) => console.warn(`  ⚠ temp folder left behind: ${tempRoot} (${error.message})`)
    )
    const uncaught = uncaughtMainErrors()
    if (uncaught.length) {
      failed++
      console.error(
        `  ✗ ${file}: uncaught main-process exception (a native error dialog in a real run):\n    ${uncaught.join('\n    ')}`
      )
    }
  }
}
console.log(failed ? `${failed} scenario file(s) failed` : `Screenshots in ${outDir}`)
process.exit(failed ? 1 : 0)
