// Screenshot harness: launches the BUILT app (npm run build first) with the mock engine and a temp
// profile, runs every scenario file in scripts/shots/*.mjs and writes PNGs to .shots/<name>.png.
//
//   npm run shots                  all scenario files
//   npm run shots -- shell         only scripts/shots/shell.mjs
//   npm run shots -- --shard=1/2   shard 1 of 2 (CI runs each shard in its own job)
//
// --shard=<i>/<n> splits every scenario file into n shards by expected duration (SCENARIO_SECONDS)
// and runs shard i (1-based) in name order. The same files always split the same way, and a new
// file lands in some shard on its own. It does not combine with scenario names: a malformed or
// repeated --shard, names next to it, or more shards than files stop the run before any launch, as
// does a name no scenario file has.
//
// Scenario files export `async function scenarios(page, helpers)`; helpers are documented below.
//
// Temp files: every scenario file gets its own temp root (<os tmp>/vengeance-shots-*) that is deleted
// when the file finishes. TEMP/TMP/TMPDIR point into it for the harness process and the launched app,
// so `mkdtemp(join(tmpdir(), …))` in a scenario and the mock engine's own temp folders are cleaned up
// too. `helpers.tempDir(prefix)` creates a folder there explicitly.
import { _electron as electron } from 'playwright'
import { existsSync, realpathSync } from 'node:fs'
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

/**
 * Seconds a scenario file takes on the hosted CI runners, for balancing --shard; a file not listed
 * is expected to take DEFAULT_SCENARIO_SECONDS. On macOS the runner's display clamps 35 responsive
 * sizes, and each waits out responsive.mjs's oversize timeout.
 */
const SCENARIO_SECONDS = new Map([
  ['chat', 105],
  ['composer', 75],
  ['conversation-prompt', 15],
  ['launch', 50],
  ['mcp-status', 20],
  ['prime-engine', 30],
  ['responsive', process.platform === 'darwin' ? 190 : 70],
  ['sessions', 45],
  ['settings', 70],
  ['subagents', 55]
])
const DEFAULT_SCENARIO_SECONDS = 8

const scenarioName = (file) => file.replace(/\.mjs$/, '')
const scenarioSeconds = (file) =>
  SCENARIO_SECONDS.get(scenarioName(file)) ?? DEFAULT_SCENARIO_SECONDS

/** Every scenario file in scripts/shots, in name order. */
export async function scenarioFiles() {
  return (await readdir(scenarioDir)).filter((f) => f.endsWith('.mjs')).sort()
}

/** The `--shard=<i>/<n>` among `args` as { index, count } (index 1-based), or null without one. */
export function parseShard(args) {
  const options = args.filter((arg) => /^--shard(=|$)/.test(arg))
  if (options.length === 0) return null
  if (options.length > 1) throw new Error(`--shard is given ${options.length} times: pass one`)
  const names = args.filter((arg) => arg !== options[0])
  if (names.length > 0) {
    throw new Error(
      `--shard splits every scenario file; drop the scenario names ${names.join(', ')}`
    )
  }
  const match = /^--shard=(\d+)\/(\d+)$/.exec(options[0])
  const index = Number(match?.[1])
  const count = Number(match?.[2])
  if (!match || index < 1 || index > count) {
    throw new Error(`${options[0]}: expected --shard=<i>/<n> with whole numbers 1 <= i <= n`)
  }
  return { index, count }
}

/**
 * `files` split into `count` shards of { files, seconds }: longest expected first, each file joins
 * the shard with the fewest expected seconds so far (the lower shard on a tie). Every file lands in
 * exactly one shard, whatever order `files` come in, and each shard lists its files in name order.
 */
export function splitShards(files, count) {
  if (count > files.length) {
    throw new Error(`--shard: ${count} shards for only ${files.length} scenario files`)
  }
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }))
  const longestFirst = [...files].sort(
    (a, b) => scenarioSeconds(b) - scenarioSeconds(a) || (a < b ? -1 : 1)
  )
  for (const file of longestFirst) {
    const lightest = shards.reduce((least, shard) =>
      shard.seconds < least.seconds ? shard : least
    )
    lightest.files.push(file)
    lightest.seconds += scenarioSeconds(file)
  }
  for (const shard of shards) shard.files.sort()
  return shards
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

/** The scenario files `args` select (see the usage at the top); throws on a usage error. */
async function selectScenarios(args) {
  const all = await scenarioFiles()
  const shard = parseShard(args)
  if (!shard) {
    // A misspelled name or option would otherwise run nothing and pass.
    const unknown = args.filter((name) => !all.some((f) => scenarioName(f) === name))
    if (unknown.length > 0) throw new Error(`No scenario file is named ${unknown.join(', ')}`)
    return all.filter((f) => args.length === 0 || args.includes(scenarioName(f)))
  }
  const { files, seconds } = splitShards(all, shard.count)[shard.index - 1]
  console.log(`Shard ${shard.index}/${shard.count}, about ${seconds} s: ${files.join(', ')}`)
  return files
}

async function main(args) {
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
    console.error('Build output missing — run `npm run build` first.')
    process.exit(1)
  }
  let files
  try {
    files = await selectScenarios(args)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }

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
        .screenshot({ path: join(outDir, `${scenarioName(file)}-FAILED.png`) })
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
}

// Runs only as a script (npm run shots): scripts/checks imports the shard functions above.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main(process.argv.slice(2))
}
