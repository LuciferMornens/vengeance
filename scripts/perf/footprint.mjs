// App footprint, measured the way a user sees it: memory per process as Task Manager counts it (private working set),
// idle CPU, startup time, streaming smoothness and interaction latency. Runs a packaged build against isolated
// profiles and a local fake LLM; nothing touches the user's Vengeance, config or network.
//
//   npm run dist:qa -- --dir
//   node scripts/perf/footprint.mjs --exe release/qa/win-unpacked/VengeanceQA.exe --label before
//   node scripts/perf/footprint.mjs --compare <before.json> <after.json>
//
// `--app-args "--switch-a --switch-b=x"` passes Chromium switches to the exe in production scenarios, to A/B a
// switch on one build without rebuilding (driven scenarios launch through the QA harness, which takes no switches).
// The value is split on whitespace, so a switch value cannot contain spaces.
// `--scenarios fresh,heavy-minimized` runs only the named production scenarios.
// `--settle 70000` samples production scenarios after that many ms instead of 30 s (past on-demand helpers' idle exit).
//
// Production scenarios launch the exe directly (no test hooks, no automation attached, Mica on), seeded with app
// state, and read the tree after it settles. Driven scenarios go through the QA harness (Playwright attached, so its
// absolute numbers carry that overhead; compare them only with each other).
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { createAgentDir } from '../qa/lib/agent-dir.mjs'
import { launchApp, ROOT } from '../qa/lib/app.mjs'
import { startFakeLlm, turn } from '../qa/lib/fake-llm.mjs'
import { isAlive, killTree } from '../qa/lib/processes.mjs'
import { qaTempDir } from '../qa/lib/tmp.mjs'
import { createHeapSampler } from '../qa/performance/heap-sampler.mjs'
import { workspaceSessionDir } from '../qa/sessions/lib/session-files.mjs'
import { longAnswer, longSession, shortSession } from './lib/fixtures.mjs'
import { byKind, mib, sampleTree } from './lib/tree-sample.mjs'

const SETTLE_MS = Number(argValue('--settle') ?? 30_000)
/** How long a minimized scenario waits before sampling: Chromium trims a hidden window within about 30 s. */
const MINIMIZED_SETTLE_MS = 45_000
const SW_MINIMIZE = 6
const SHOW_WINDOW_ASYNC =
  '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'
const SAMPLE_COUNT = 6
const SAMPLE_GAP_MS = 2_500
const CLOSE_TIMEOUT_MS = 20_000
const STARTUP_RUNS = 3
const SWITCH_ROUNDS = 8
const HISTORY_SESSIONS = 150
const DORMANT_SESSIONS = 6
const LONG_FRAME_MS = 50

const execFileAsync = promisify(execFile)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0
}
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Production env: the shell's env without engine/app overrides, pointed at isolated folders, offline. */
function productionEnv({ userData, agentDir, home, temp, prime }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(PI_|PRIME_|VENGEANCE_|ELECTRON_)/i.test(name)
    )
  )
  return {
    ...env,
    VENGEANCE_USER_DATA: userData,
    PI_CODING_AGENT_DIR: agentDir,
    PRIME_AGENT_CODING_AGENT_DIR: prime,
    PRIME_AGENT_SESSION_DIR: join(prime, 'sessions'),
    PRIME_AGENT_CODING_AGENT_SESSION_DIR: join(prime, 'sessions'),
    PRIME_AGENT_KERNEL_VENV: join(prime, 'kernel-venv'),
    HOME: home,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0'
  }
}

function appState({ cwd, openSessions = [], activeSession = null }) {
  return {
    prefs: {
      version: 1,
      theme: 'dark',
      accent: 'ember',
      fontScale: 1,
      density: 'comfortable',
      workspaces: [{ path: cwd, name: basename(cwd), lastOpenedAt: Date.now(), engine: 'pi' }],
      activeWorkspace: cwd,
      defaultEngine: 'pi',
      sidebar: { open: true, width: 268 },
      inspector: { open: false, width: 340, tab: 'overview' },
      onboardingCompleted: true,
      engineOverridePath: null,
      openSessions,
      activeSession,
      features: {}
    },
    window: { x: 80, y: 40, width: 1440, height: 900, maximized: false }
  }
}

/** Seeds: `fresh` boots into a new session; `heavy` restores a long session with dormant tabs and a big history. */
const SEEDS = {
  async fresh({ cwd }) {
    return appState({ cwd })
  },
  async heavy({ cwd, agentDir }) {
    const dir = workspaceSessionDir(agentDir, cwd)
    const now = Date.now()
    const long = await longSession(cwd, { startedAt: now - 3_600_000 }).write(dir)
    const open = [{ path: long, cwd, engine: 'pi' }]
    for (let index = 0; index < HISTORY_SESSIONS; index++) {
      const path = await shortSession(cwd, index, now - 7_200_000 - index * 3_600_000).write(dir)
      if (index < DORMANT_SESSIONS) open.push({ path, cwd, engine: 'pi' })
    }
    return appState({ cwd, openSessions: open, activeSession: long })
  }
}

/** Production scenarios: a seed, and whether the window is minimized once the app has settled. */
const PRODUCTION_SCENARIOS = {
  fresh: { seed: 'fresh', minimized: false },
  heavy: { seed: 'heavy', minimized: false },
  'heavy-minimized': { seed: 'heavy', minimized: true }
}

/** Minimize the main window of `pid` the way the caption button does, without attaching to the app. */
async function minimizeWindow(pid) {
  const script = [
    `Add-Type -Namespace Footprint -Name User32 -MemberDefinition '${SHOW_WINDOW_ASYNC}'`,
    `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
    `if (-not [Footprint.User32]::ShowWindowAsync($p.MainWindowHandle, ${SW_MINIMIZE})) { exit 1 }`
  ].join('; ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true })
}

async function closeGracefully(pid) {
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`
  spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore'
  })
  const started = Date.now()
  while (isAlive(pid) && Date.now() - started < CLOSE_TIMEOUT_MS) await sleep(250)
  return !isAlive(pid)
}

/** Remove a temp tree; Windows may hold files for a moment after the processes exit. */
async function removeTree(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
    () => undefined
  )
}

/** One production launch of `exe` in scenario `name`: settled memory and idle CPU per process kind, process counts. */
async function productionScenario(exe, appArgs, server, name) {
  const { seed, minimized } = PRODUCTION_SCENARIOS[name]
  const root = await qaTempDir('vengeance-perf-')
  const dirs = {
    userData: join(root, 'user-data'),
    home: join(root, 'home'),
    temp: join(root, 'tmp'),
    prime: join(root, 'prime-agent'),
    cwd: join(root, 'workspaces', 'footprint-project')
  }
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
  await writeFile(join(dirs.cwd, 'README.md'), '# Footprint project\n')
  const agentDir = await createAgentDir({ server })
  const state = await SEEDS[seed]({ cwd: dirs.cwd, agentDir })
  await writeFile(join(dirs.userData, 'app-state.json'), JSON.stringify(state))

  const child = spawn(exe, appArgs, {
    env: productionEnv({ ...dirs, agentDir: agentDir.dir }),
    stdio: 'ignore',
    windowsHide: false
  })
  const pid = child.pid
  try {
    await sleep(SETTLE_MS)
    if (minimized) {
      await minimizeWindow(pid)
      await sleep(MINIMIZED_SETTLE_MS)
    }
    const samples = []
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      samples.push(await sampleTree(pid))
      if (index < SAMPLE_COUNT - 1) await sleep(SAMPLE_GAP_MS)
    }
    const first = samples[0]
    const last = samples.at(-1)
    const elapsed = last.at - first.at
    const kinds = {}
    for (const sample of samples) {
      for (const [kind, bytes] of Object.entries(byKind(sample))) (kinds[kind] ??= []).push(bytes)
    }
    const firstCpuMs = new Map(first.processes.map((row) => [row.pid, row.cpuMs]))
    const kindsCpuMs = {}
    for (const row of last.processes) {
      const cpuMs = row.cpuMs - (firstCpuMs.get(row.pid) ?? 0)
      kindsCpuMs[row.kind] = (kindsCpuMs[row.kind] ?? 0) + cpuMs
    }
    return {
      scenario: name,
      appMiB: mib(median(samples.map((sample) => sample.app.privateWs))),
      appProcesses: last.app.count,
      engineMiB: mib(median(samples.map((sample) => sample.engines.privateWs))),
      engineProcesses: last.engines.count,
      kindsMiB: Object.fromEntries(
        Object.entries(kinds).map(([kind, values]) => [kind, mib(median(values))])
      ),
      idleCpuPercent: round(((last.app.cpuMs - first.app.cpuMs) / elapsed) * 100, 2),
      engineIdleCpuPercent: round(((last.engines.cpuMs - first.engines.cpuMs) / elapsed) * 100, 2),
      kindsIdleCpuPercent: Object.fromEntries(
        Object.entries(kindsCpuMs).map(([kind, cpuMs]) => [kind, round((cpuMs / elapsed) * 100, 2)])
      )
    }
  } finally {
    if (!(await closeGracefully(pid))) await killTree(pid)
    await agentDir.cleanup().catch(() => undefined)
    await removeTree(root)
  }
}

/** Frame gaps (ms) while `action` runs: requestAnimationFrame deltas inside the renderer. */
async function framesDuring(page, action) {
  await page.evaluate(() => {
    const probe = { last: performance.now(), gaps: [], running: true }
    window.__footprintFrames = probe
    const tick = (now) => {
      if (!probe.running) return
      probe.gaps.push(now - probe.last)
      probe.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await action()
  const gaps = await page.evaluate(() => {
    window.__footprintFrames.running = false
    return window.__footprintFrames.gaps
  })
  return {
    frames: gaps.length,
    p95Ms: round(percentile(gaps, 0.95)),
    maxMs: round(Math.max(0, ...gaps)),
    longFrames: gaps.filter((gap) => gap > LONG_FRAME_MS).length
  }
}

async function timed(action) {
  const started = performance.now()
  await action()
  return performance.now() - started
}

/** Startup to an interactive window (harness launch → shell rendered and fonts ready), median of a few cold runs. */
async function startupTimes(exe, server) {
  const times = []
  for (let run = 0; run < STARTUP_RUNS; run++) {
    const agentDir = await createAgentDir({ server })
    const started = performance.now()
    const app = await launchApp({ agentDir: agentDir.dir, exe })
    times.push(performance.now() - started)
    await app.close().catch(() => undefined)
    await agentDir.cleanup().catch(() => undefined)
  }
  return { medianMs: Math.round(median(times)), runsMs: times.map(Math.round) }
}

/** Streaming, tools, session switching, Settings and the palette through the QA harness. */
async function drivenScenario(exe, server) {
  const agentDir = await createAgentDir({ server })
  const app = await launchApp({ agentDir: agentDir.dir, exe, outDir: join(ROOT, '.shots', 'perf') })
  const { page } = app
  try {
    const { cwd } = await app.openWorkspace({
      files: { 'README.md': '# Footprint\n', 'notes.txt': 'notes\n' }
    })
    server.queue(turn.text(longAnswer(), { chunkSize: 40, delayMs: 10 }))
    const streaming = await framesDuring(page, async () => {
      await app.send('Write the overview')
      await app.waitForSettle()
    })
    server.queue(
      turn.toolCalls([
        { name: 'read', args: { path: 'README.md' } },
        { name: 'bash', args: { command: 'echo footprint' } }
      ])
    )
    server.queue(turn.text('Both look fine.'))
    await app.send('Check the readme and run echo')
    await app.waitForSettle()

    for (let index = 0; index < 4; index++) await app.openWorkspace({ cwd })
    const rows = page.locator('section[aria-label="Open sessions"] [data-session-row]')
    const switches = []
    for (let round = 0; round < SWITCH_ROUNDS; round++) {
      const row = rows.nth(round % (await rows.count()))
      switches.push(
        await timed(async () => {
          await row.click()
          await app.composer()
        })
      )
    }
    const settingsOpenMs = await timed(async () => {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await page.locator('input[aria-label="Search settings"]').waitFor()
    })
    const sections = page.getByRole('navigation').getByRole('button')
    const sectionTimes = []
    for (let index = 0; index < (await sections.count()); index++) {
      const section = sections.nth(index)
      const label = (await section.innerText()).trim()
      sectionTimes.push(
        await timed(async () => {
          await section.click()
          await page.getByRole('heading', { name: label, exact: true }).first().waitFor()
        })
      )
    }
    await page.locator('button[aria-label="Close settings"]').click()
    await page.locator('input[aria-label="Search settings"]').waitFor({ state: 'detached' })
    const paletteTimes = []
    for (let round = 0; round < 3; round++) {
      paletteTimes.push(
        await timed(async () => {
          await page.keyboard.press('Control+K')
          await page.getByRole('dialog').waitFor()
        })
      )
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'detached' })
    }
    await sleep(10_000)
    const tree = await sampleTree(app.app.process().pid)
    const heap = await createHeapSampler(app.app, page)
    const heaps = await heap.sample('after-interaction')
    await heap.dispose()
    return {
      streaming,
      switchMedianMs: Math.round(median(switches)),
      switchMaxMs: Math.round(Math.max(...switches)),
      settingsOpenMs: Math.round(settingsOpenMs),
      settingsSectionMedianMs: Math.round(median(sectionTimes)),
      paletteOpenMedianMs: Math.round(median(paletteTimes)),
      afterInteraction: {
        appMiB: mib(tree.app.privateWs),
        kindsMiB: Object.fromEntries(
          Object.entries(byKind(tree)).map(([kind, bytes]) => [kind, mib(bytes)])
        ),
        rendererHeapMiB: mib(heaps.rendererBytes),
        mainHeapMiB: mib(heaps.mainBytes)
      }
    }
  } finally {
    await app.close().catch(() => undefined)
    await agentDir.cleanup().catch(() => undefined)
  }
}

function compareTable(before, after) {
  const rows = []
  const add = (label, a, b, unit, lowerIsBetter = true) => {
    if (a === undefined || b === undefined) return
    const delta = b - a
    const percent = a ? round((delta / a) * 100) : 0
    const better = lowerIsBetter ? delta < 0 : delta > 0
    rows.push(
      `| ${label} | ${a} ${unit} | ${b} ${unit} | ${delta > 0 ? '+' : ''}${round(delta)} ${unit} (${percent > 0 ? '+' : ''}${percent}%)${delta === 0 ? '' : better ? ' ✓' : ' ✗'} |`
    )
  }
  for (const scenario of Object.keys(before.production ?? {})) {
    const a = before.production[scenario]
    const b = after.production?.[scenario]
    if (!b) continue
    add(`${scenario}: app memory`, a.appMiB, b.appMiB, 'MiB')
    for (const kind of new Set([...Object.keys(a.kindsMiB), ...Object.keys(b.kindsMiB)])) {
      add(`${scenario}: ${kind}`, a.kindsMiB[kind] ?? 0, b.kindsMiB[kind] ?? 0, 'MiB')
    }
    add(`${scenario}: app processes`, a.appProcesses, b.appProcesses, '')
    add(`${scenario}: idle CPU`, a.idleCpuPercent, b.idleCpuPercent, '%')
    add(`${scenario}: engine memory`, a.engineMiB, b.engineMiB, 'MiB')
  }
  const da = before.driven
  const db = after.driven
  if (da && db) {
    add('startup (median)', da.startup.medianMs, db.startup.medianMs, 'ms')
    add('streaming p95 frame', da.interaction.streaming.p95Ms, db.interaction.streaming.p95Ms, 'ms')
    add(
      'streaming long frames',
      da.interaction.streaming.longFrames,
      db.interaction.streaming.longFrames,
      ''
    )
    add(
      'session switch (median)',
      da.interaction.switchMedianMs,
      db.interaction.switchMedianMs,
      'ms'
    )
    add('settings open', da.interaction.settingsOpenMs, db.interaction.settingsOpenMs, 'ms')
    add(
      'settings section (median)',
      da.interaction.settingsSectionMedianMs,
      db.interaction.settingsSectionMedianMs,
      'ms'
    )
    add(
      'palette open (median)',
      da.interaction.paletteOpenMedianMs,
      db.interaction.paletteOpenMedianMs,
      'ms'
    )
    add(
      'after interaction: app memory',
      da.interaction.afterInteraction.appMiB,
      db.interaction.afterInteraction.appMiB,
      'MiB'
    )
    add(
      'after interaction: renderer JS heap',
      da.interaction.afterInteraction.rendererHeapMiB,
      db.interaction.afterInteraction.rendererHeapMiB,
      'MiB'
    )
    add(
      'after interaction: main JS heap',
      da.interaction.afterInteraction.mainHeapMiB,
      db.interaction.afterInteraction.mainHeapMiB,
      'MiB'
    )
  }
  return ['| Measure | Before | After | Change |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`)
  }
}

if (process.argv.includes('--compare')) {
  const index = process.argv.indexOf('--compare')
  const [before, after] = await Promise.all([
    readJson(process.argv[index + 1]),
    readJson(process.argv[index + 2])
  ])
  console.log(compareTable(before, after))
} else {
  const exe = resolve(
    argValue('--exe') ?? join(ROOT, 'release', 'qa', 'win-unpacked', 'VengeanceQA.exe')
  )
  const label = argValue('--label') ?? 'run'
  const outDir = resolve(argValue('--out') ?? join(ROOT, '.shots', 'perf'))
  const only = argValue('--only')
  const runs = Number(argValue('--runs') ?? 2)
  const appArgs = (argValue('--app-args') ?? '').split(/\s+/).filter(Boolean)
  const scenarios = argValue('--scenarios')?.split(',') ?? Object.keys(PRODUCTION_SCENARIOS)
  const unknown = scenarios.filter((scenario) => !(scenario in PRODUCTION_SCENARIOS))
  if (unknown.length) throw new Error(`Unknown production scenario: ${unknown.join(', ')}`)
  const server = await startFakeLlm()
  const result = {
    label,
    exe,
    appArgs,
    at: new Date().toISOString(),
    production: {},
    driven: null
  }
  try {
    if (only !== 'driven') {
      for (const scenario of scenarios) {
        const results = []
        for (let run = 0; run < runs; run++) {
          console.log(`• production ${scenario} (run ${run + 1}/${runs})`)
          results.push(await productionScenario(exe, appArgs, server, scenario))
          console.log(
            `  app ${results.at(-1).appMiB} MiB, idle CPU ${results.at(-1).idleCpuPercent}%`
          )
        }
        const pick = (field) => median(results.map((entry) => entry[field]))
        const kinds = {}
        for (const entry of results) {
          for (const [kind, value] of Object.entries(entry.kindsMiB))
            (kinds[kind] ??= []).push(value)
        }
        result.production[scenario] = {
          scenario,
          runs: results,
          appMiB: pick('appMiB'),
          appProcesses: pick('appProcesses'),
          engineMiB: pick('engineMiB'),
          engineProcesses: pick('engineProcesses'),
          idleCpuPercent: pick('idleCpuPercent'),
          engineIdleCpuPercent: pick('engineIdleCpuPercent'),
          kindsMiB: Object.fromEntries(
            Object.entries(kinds).map(([kind, values]) => [kind, median(values)])
          )
        }
      }
    }
    if (only !== 'production') {
      console.log('• driven: startup')
      const startup = await startupTimes(exe, server)
      console.log(`  ${startup.medianMs} ms`)
      console.log('• driven: streaming, switching, settings, palette')
      const interaction = await drivenScenario(exe, server)
      result.driven = { startup, interaction }
    }
  } finally {
    await server.close()
  }
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, `footprint-${label}.json`)
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    JSON.stringify(
      { production: result.production, driven: result.driven },
      (key, value) => (key === 'runs' ? undefined : value),
      2
    )
  )
  console.log(`Saved ${file}`)
}
