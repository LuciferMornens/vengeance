// Process-cold startup and the first two saved-session visits, with isolated native engines.
// Run after building: node scripts/perf/first-navigation.mjs --label before --runs 3
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createEngineFixture,
  executableHash,
  PRIME_MODELS,
  PRIME_PROVIDER
} from '../qa/engines/integration-fixture.mjs'
import { assertNativeWorkerSocketBudget, launchApp, ROOT } from '../qa/lib/app.mjs'
import { ELECTRON_SWITCHES } from '../qa/lib/platform.mjs'
import { isAlive, killTree, processIdentity } from '../qa/lib/processes.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT, qaTempDir } from '../qa/lib/tmp.mjs'
import { workspaceSessionDir } from '../qa/sessions/lib/session-files.mjs'
import { longSession } from './lib/fixtures.mjs'

const DEFAULT_RUNS = 3
const HISTORY_TURNS = 60
const READY_TIMEOUT_MS = 60_000
const WINDOW_SIZE = { width: 1440, height: 900 }
const CLOSE_TIMEOUT_MS = 5000
const CLOSE_POLL_MS = 50
const HISTORY_SCROLL_STABILITY_MS = 800
const HISTORY_READY_TIMEOUT_MS = 5000
const HISTORY_ENTRY_SCROLL_SCREENS = 4
const DIAGNOSTIC_WARM_FRAMES = 12
const OUTPUT_DIRECTORY = join(ROOT, '.shots', 'perf', 'first-navigation')
const label = argument('--label') ?? 'sample'
const runs = Number(argument('--runs') ?? DEFAULT_RUNS)
const engines = (argument('--engines') ?? 'pi,prime').split(',')
const traceEnabled = process.argv.includes('--trace')
const diagnoseFrames = process.argv.includes('--diagnose-frames')
const focusWindow = process.argv.includes('--focus-window')
const warmFrames = process.argv.includes('--warm-frames')
const recordScrollFailures = process.argv.includes('--record-scroll-failures')
for (const variable of ['QA_PRIME_EXECUTABLE', 'QA_PRIME_SHA256']) {
  assert.equal(
    process.env[variable],
    undefined,
    `${variable} conflicts with bundled-engine measurement`
  )
}
const enginesRoot = resolve(argument('--engines-root') ?? join(ROOT, '.engine-staging', 'bundled'))
const manifest = JSON.parse(await readFile(join(enginesRoot, 'manifest.json'), 'utf8'))
const entryHashes = Object.fromEntries(
  await Promise.all(
    engines.map(async (engine) => [
      engine,
      await executableHash(resolve(enginesRoot, manifest.engines[engine].entry))
    ])
  )
)
const report = {
  label,
  runs,
  historyTurns: HISTORY_TURNS,
  build: {
    mainSha256: await executableHash(join(ROOT, 'out', 'main', 'index.js')),
    rendererIndexSha256: await executableHash(join(ROOT, 'out', 'renderer', 'index.html'))
  },
  recordScrollFailures,
  endpoints: {
    paintedMs: 'Expected marker mounted in transcript DOM; retained for baseline comparison',
    visibleMs: 'Expected marker visible inside transcript and window, without inert/opening layers',
    summary: 'Visible marker latency; mounted marker medians are reported separately'
  },
  diagnostics: {
    traceEnabled,
    diagnoseFrames,
    focusWindow,
    warmFrames,
    warmFrameCount: warmFrames ? DIAGNOSTIC_WARM_FRAMES : 0
  },
  engineBuilds: Object.fromEntries(
    Object.entries(manifest.engines).map(([engine, { version, revision, payloadHash }]) => [
      engine,
      { version, revision, payloadHash }
    ])
  ),
  samples: []
}
const fixture = await createEngineFixture()

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function environment(userData, scratch) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(PI_|PRIME_|VENGEANCE_|ELECTRON_)/i.test(name)
    )
  )
  const isolated = {
    ...inherited,
    VENGEANCE_TEST: '1',
    VENGEANCE_NO_MICA: '1',
    VENGEANCE_USER_DATA: userData,
    PI_CODING_AGENT_DIR: fixture.piDirectory.dir,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    HOME: join(scratch, 'home'),
    TEMP: join(scratch, 'tmp'),
    TMP: join(scratch, 'tmp'),
    TMPDIR: process.platform === 'win32' ? join(scratch, 'tmp') : QA_TMP_ROOT
  }
  for (const [name, value] of Object.entries(fixture.environment)) {
    if (value === undefined) delete isolated[name]
    else isolated[name] = value
  }
  isolated.VENGEANCE_BUNDLED_ENGINES = enginesRoot
  if (process.platform !== 'win32') {
    assertNativeWorkerSocketBudget(isolated.TMPDIR)
    assert.ok(
      isInside(QA_TMP_ROOT, assertOutsideRealHome(isolated.TMPDIR)),
      'Benchmark TMPDIR must stay inside QA_TMP_ROOT'
    )
  }
  return isolated
}

async function histories(workspace) {
  const pi = []
  const directory = workspaceSessionDir(fixture.piDirectory, workspace)
  for (const title of ['First conversation', 'Second conversation']) {
    const session = longSession(workspace, { turns: HISTORY_TURNS, name: title })
    session.assistant(`${title} final benchmark marker.`)
    pi.push(await session.write(directory))
  }
  if (!engines.includes('prime')) return { pi }
  const setup = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: { ...fixture.environment, VENGEANCE_BUNDLED_ENGINES: enginesRoot }
  })
  const prime = []
  const seedWorkers = []
  try {
    for (const path of pi) {
      const source = await setup.test('openSession', path, 'pi')
      assert.ok(source)
      const destination = await setup.invoke('engine:switch', source, {
        engine: 'prime',
        cwd: workspace,
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off'
      })
      assert.ok(destination.sessionFile)
      seedWorkers.push(await processIdentity(destination.pid))
      prime.push(destination.sessionFile)
      await setup.invoke('engine:dispose', source)
    }
  } finally {
    try {
      await fixture.stopNativeDaemon()
    } finally {
      await setup.close({ beforeCleanup: fixture.stopNativeDaemon })
    }
  }
  for (const worker of seedWorkers) {
    assert.ok(!isAlive(worker.pid), `setup native worker ${worker.pid} exited before sampling`)
  }
  report.seedWorkers = seedWorkers
  return { pi, prime }
}

async function bundledIdentity(page, engine, agentId) {
  const description = await page.evaluate(
    (selectedEngine) => window.vengeance.invoke('engine:describe', selectedEngine),
    engine
  )
  assert.equal(description.found, true)
  assert.equal(description.mock, false)
  assert.equal(description.source, 'bundled')
  assert.equal(description.version, manifest.engines[engine].version)
  const entrySha256 = await executableHash(description.cliPath)
  assert.equal(entrySha256, entryHashes[engine], 'the running entry matches the selected manifest')
  const info = await page.evaluate(async (selectedAgent) => {
    const engines = await window.vengeance.invoke('engine:list')
    return engines.find((entry) => entry.agentId === selectedAgent)
  }, agentId)
  const worker = await processIdentity(info.pid)
  const daemon = engine === 'prime' ? await processIdentity(worker.parentPid) : undefined
  if (engine === 'prime') {
    assert.equal(resolve(worker.executablePath), resolve(description.cliPath))
    assert.equal(resolve(daemon.executablePath), resolve(description.cliPath))
  }
  return { description, entrySha256, worker, daemon }
}

function appState(workspace, engine) {
  return {
    prefs: {
      version: 1,
      theme: 'dark',
      accent: 'ember',
      fontScale: 1,
      density: 'comfortable',
      workspaces: [{ path: workspace, name: 'Navigation benchmark', lastOpenedAt: 1, engine }],
      activeWorkspace: workspace,
      defaultEngine: engine,
      sidebar: { open: true, width: 268 },
      inspector: { open: false, width: 340, tab: 'overview' },
      onboardingCompleted: true,
      engineOverridePath: null,
      openSessions: [],
      activeSession: null,
      features: {}
    },
    window: { x: 80, y: 40, ...WINDOW_SIZE, maximized: false }
  }
}

async function attachIpcProbe(application) {
  await application.evaluate(({ ipcMain }) => {
    globalThis.__navigationIpc = []
    // Electron's private handler map is inspected only by this disposable profiling process.
    for (const [channel, handler] of ipcMain._invokeHandlers) {
      ipcMain._invokeHandlers.set(channel, async (...parameters) => {
        const started = performance.now()
        try {
          return await handler(...parameters)
        } finally {
          globalThis.__navigationIpc.push({
            channel,
            command: channel === 'engine:command' ? parameters[2]?.type : undefined,
            started,
            elapsedMs: performance.now() - started
          })
        }
      })
    }
  })
}

async function closeApplication(application) {
  if (!application) return
  const processId = application.process().pid
  const closing = application.close().catch((error) => error)
  const deadline = Date.now() + CLOSE_TIMEOUT_MS
  while (isAlive(processId) && Date.now() < deadline) {
    await new Promise((resolvePoll) => setTimeout(resolvePoll, CLOSE_POLL_MS))
  }
  if (isAlive(processId)) await killTree(processId)
  // Electron can exit while a detached native daemon still holds its child stdio open.
  await fixture.stopNativeDaemon()
  const closeError = await closing
  if (closeError) throw closeError
}

async function saveTimeline(profiler, path) {
  const completed = new Promise((resolveTrace) => {
    profiler.once('Tracing.tracingComplete', resolveTrace)
  })
  await profiler.send('Tracing.end')
  const { stream } = await completed
  const chunks = []
  try {
    for (;;) {
      const chunk = await profiler.send('IO.read', { handle: stream })
      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data)
      if (chunk.eof) break
    }
    await writeFile(path, chunks.join(''))
  } finally {
    await profiler.send('IO.close', { handle: stream })
  }
}

async function verifyHistoryScrolling(page) {
  const transcript = page.locator('[data-transcript-scroll]')
  const rectangle = await transcript.boundingBox()
  await page.mouse.move(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2)
  await page.mouse.wheel(0, -rectangle.height * HISTORY_ENTRY_SCROLL_SCREENS)
  await page.waitForFunction(
    () => {
      const scroller = document.querySelector('[data-transcript-scroll]')
      const viewport = scroller.getBoundingClientRect()
      return [...scroller.querySelectorAll('[data-virtual-segments] > [data-index]')].some(
        (row) => {
          const rectangle = row.getBoundingClientRect()
          return (
            rectangle.bottom > viewport.top && rectangle.top < viewport.bottom && row.textContent
          )
        }
      )
    },
    null,
    { timeout: HISTORY_READY_TIMEOUT_MS }
  )
  await page.evaluate(() => {
    const transcript = document.querySelector('[data-transcript-scroll]')
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    transcript.scrollTop = 0
  })
  try {
    await page
      .locator('[data-transcript-scroll]')
      .getByText('Turn 0: tighten the request handling in area 0 and run its tests.', {
        exact: true
      })
      .waitFor({ timeout: HISTORY_READY_TIMEOUT_MS })
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const transcript = document.querySelector('[data-transcript-scroll]')
      return {
        scrollTop: transcript.scrollTop,
        scrollHeight: transcript.scrollHeight,
        clientHeight: transcript.clientHeight,
        rows: [...transcript.querySelectorAll('[data-index]')].map((element) => ({
          index: element.getAttribute('data-index'),
          transform: element.style.transform
        })),
        text: transcript.textContent.slice(0, 200)
      }
    })
    throw new Error(`Oldest history did not appear: ${JSON.stringify(snapshot)}`, { cause: error })
  }
  await page.waitForTimeout(HISTORY_SCROLL_STABILITY_MS)
  const scrollTop = await page.evaluate(
    () => document.querySelector('[data-transcript-scroll]').scrollTop
  )
  assert.ok(scrollTop < 1, 'reading the oldest history stays at the top')
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await page.waitForFunction(() => {
    const transcript = document.querySelector('[data-transcript-scroll]')
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 1
  })
  return { firstUpwardScroll: true, oldestHistory: true, stableReader: true, jumpToLatest: true }
}

async function visit(page, path, engine, title) {
  return page.evaluate(
    async ({ sessionPath, selectedEngine, expectedText, diagnostic }) => {
      const started = performance.now()
      const gaps = []
      const longTasks = []
      const frames = []
      const taskDetails = []
      if (diagnostic) performance.mark(`${expectedText}:start`)
      let lastFrame = started
      let sampling = true
      let paintedAt
      let visibleAt
      const observer = new PerformanceObserver((entries) => {
        longTasks.push(...entries.getEntries().map((entry) => entry.duration))
        if (diagnostic) {
          taskDetails.push(
            ...entries
              .getEntries()
              .map((entry) => ({ at: entry.startTime, duration: entry.duration }))
          )
        }
      })
      observer.observe({ type: 'longtask' })
      const sample = () => {
        const now = performance.now()
        gaps.push(now - lastFrame)
        if (diagnostic) {
          frames.push({
            at: now,
            gap: now - lastFrame,
            visibility: document.visibilityState,
            focused: document.hasFocus()
          })
        }
        lastFrame = now
        const transcript = document.querySelector('[data-transcript-scroll]')
        const markerMounted = transcript?.textContent.includes(expectedText)
        if (paintedAt === undefined && markerMounted) {
          paintedAt = now
          if (diagnostic) performance.mark(`${expectedText}:mounted`)
        }
        if (
          visibleAt === undefined &&
          markerMounted &&
          !transcript.closest('[inert]') &&
          !document.querySelector('[data-session-opening]')
        ) {
          const marker = [...transcript.querySelectorAll('p')].find(
            (paragraph) => paragraph.textContent === expectedText
          )
          if (marker?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
            const rectangle = marker.getBoundingClientRect()
            const viewport = transcript.getBoundingClientRect()
            const left = Math.max(0, rectangle.left, viewport.left)
            const right = Math.min(innerWidth, rectangle.right, viewport.right)
            const top = Math.max(0, rectangle.top, viewport.top)
            const bottom = Math.min(innerHeight, rectangle.bottom, viewport.bottom)
            if (right > left && bottom > top) {
              visibleAt = now
              if (diagnostic) performance.mark(`${expectedText}:visible`)
            }
          }
        }
        if (sampling) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      const agentId = await window.__vengeanceTest.openSession(sessionPath, selectedEngine)
      const readyAt = performance.now()
      if (diagnostic) performance.mark(`${expectedText}:ready`)
      const deadline = started + 60_000
      while (visibleAt === undefined && performance.now() < deadline) {
        await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      }
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
      sampling = false
      observer.disconnect()
      if (visibleAt === undefined) throw new Error('Saved transcript never became visible')
      return {
        agentId,
        paintedMs: paintedAt - started,
        visibleMs: visibleAt - started,
        completeMs: readyAt - started,
        maximumFrameGapMs: Math.max(0, ...gaps),
        blockingMs: longTasks.reduce((total, duration) => total + Math.max(0, duration - 50), 0),
        longTasks,
        diagnostic: diagnostic ? { started, readyAt, frames, taskDetails } : undefined
      }
    },
    {
      sessionPath: path,
      selectedEngine: engine,
      expectedText: `${title} final benchmark marker.`,
      diagnostic: diagnoseFrames
    }
  )
}

async function sample(workspace, paths, engine, run) {
  const scratch = await qaTempDir('vengeance-first-navigation-')
  const userData = join(scratch, 'user-data')
  for (const directory of [userData, join(scratch, 'home'), join(scratch, 'tmp')]) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(join(userData, 'app-state.json'), JSON.stringify(appState(workspace, engine)))
  const started = performance.now()
  let application
  let page
  try {
    application = await electron.launch({
      args: [ROOT, '--force-device-scale-factor=1', ...ELECTRON_SWITCHES],
      env: environment(userData, scratch),
      timeout: READY_TIMEOUT_MS
    })
    page = await application.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.waitForFunction(
      () => !!window.__vengeanceTest && document.querySelector('header'),
      null,
      { timeout: READY_TIMEOUT_MS }
    )
    await page.evaluate(() => document.fonts.ready)
    const shellMs = performance.now() - started
    if (focusWindow) {
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.show()
        window.focus()
      })
      await page.bringToFront()
      await page.waitForFunction(
        () => document.visibilityState === 'visible' && document.hasFocus()
      )
    }
    const windowState = diagnoseFrames
      ? await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          return {
            visible: window.isVisible(),
            focused: window.isFocused(),
            minimized: window.isMinimized(),
            backgroundThrottling: window.webContents.getBackgroundThrottling()
          }
        })
      : undefined
    const warmup = warmFrames
      ? await page.evaluate(async (count) => {
          const frames = []
          let previous = performance.now()
          for (let index = 0; index < count; index++) {
            await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame))
            const at = performance.now()
            frames.push({ at, gap: at - previous, focused: document.hasFocus() })
            previous = at
          }
          return frames
        }, DIAGNOSTIC_WARM_FRAMES)
      : undefined
    await attachIpcProbe(application)
    const profiler = await page.context().newCDPSession(page)
    await profiler.send('Profiler.enable')
    if (traceEnabled) {
      await profiler.send('Tracing.start', {
        categories:
          'devtools.timeline,v8,blink.user_timing,toplevel,disabled-by-default-devtools.timeline',
        transferMode: 'ReturnAsStream'
      })
    }
    await profiler.send('Profiler.start')
    const first = await visit(page, paths[0], engine, 'First conversation')
    const second = await visit(page, paths[1], engine, 'Second conversation')
    const cached = await visit(page, paths[0], engine, 'First conversation')
    const { profile } = await profiler.send('Profiler.stop')
    if (traceEnabled) {
      await saveTimeline(profiler, join(OUTPUT_DIRECTORY, `${label}-${engine}-${run}.trace.json`))
    }
    await profiler.detach()
    await writeFile(
      join(OUTPUT_DIRECTORY, `${label}-${engine}-${run}.cpuprofile`),
      JSON.stringify(profile)
    )
    await page
      .locator('[data-transcript-scroll] pre .syn-keyword')
      .first()
      .waitFor({ timeout: READY_TIMEOUT_MS })
    const code = await page.locator('[data-transcript-scroll] pre').last().innerText()
    assert.ok(code.includes('const value27 = items.filter'))
    const workerUrls = page.workers().map((worker) => worker.url())
    const ipc = await application.evaluate(() => globalThis.__navigationIpc)
    const paints = await page.evaluate(() =>
      performance
        .getEntriesByType('paint')
        .map((entry) => ({ name: entry.name, at: entry.startTime }))
    )
    await page.waitForFunction(
      () => {
        const transcript = document.querySelector('[data-transcript-scroll]')
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 1
      },
      null,
      { timeout: HISTORY_READY_TIMEOUT_MS }
    )
    const screenshot = join(OUTPUT_DIRECTORY, `${label}-${engine}-${run}.png`)
    await page.screenshot({ path: screenshot })
    let scrolling
    try {
      scrolling = { passed: true, ...(await verifyHistoryScrolling(page)) }
    } catch (error) {
      if (!recordScrollFailures) throw error
      scrolling = { passed: false, error: error.stack ?? String(error) }
      await page.screenshot({
        path: join(OUTPUT_DIRECTORY, `${label}-${engine}-${run}-SCROLL-FAILED.png`)
      })
    }
    const identity = await bundledIdentity(page, engine, first.agentId)
    assert.deepEqual(errors, [])
    return {
      engine,
      run,
      shellMs,
      windowState,
      warmup,
      first,
      second,
      cached,
      ipc,
      paints,
      workerUrls,
      screenshot,
      scrolling,
      identity
    }
  } catch (error) {
    await page
      ?.screenshot({ path: join(OUTPUT_DIRECTORY, `${label}-${engine}-${run}-FAILED.png`) })
      .catch(() => undefined)
    throw error
  } finally {
    try {
      await closeApplication(application)
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}

try {
  assert.ok(Number.isSafeInteger(runs) && runs > 0)
  assert.ok(engines.every((engine) => engine === 'pi' || engine === 'prime'))
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  const workspace = await fixture.root.folder('navigation-workspace', {
    'README.md': '# Benchmark\n'
  })
  const paths = await histories(workspace)
  for (const engine of engines) {
    for (let run = 1; run <= runs; run++) {
      const measurement = await sample(workspace, paths[engine], engine, run)
      report.samples.push(measurement)
      console.log(
        `${engine} ${run}: shell ${measurement.shellMs.toFixed(0)}ms; ` +
          `first visible ${measurement.first.visibleMs.toFixed(0)}ms ` +
          `(mounted ${measurement.first.paintedMs.toFixed(0)}ms); ` +
          `second visible ${measurement.second.visibleMs.toFixed(0)}ms; ` +
          `cached visible ${measurement.cached.visibleMs.toFixed(0)}ms`
      )
    }
  }
  report.summary = engines.map((engine) => {
    const samples = report.samples.filter((entry) => entry.engine === engine)
    return {
      engine,
      shellMs: median(samples.map((entry) => entry.shellMs)),
      firstMs: median(samples.map((entry) => entry.first.visibleMs)),
      secondMs: median(samples.map((entry) => entry.second.visibleMs)),
      cachedMs: median(samples.map((entry) => entry.cached.visibleMs)),
      firstMountedMs: median(samples.map((entry) => entry.first.paintedMs)),
      secondMountedMs: median(samples.map((entry) => entry.second.paintedMs)),
      cachedMountedMs: median(samples.map((entry) => entry.cached.paintedMs))
    }
  })
  const output = resolve(OUTPUT_DIRECTORY, `${label}.json`)
  report.scrollFailures = report.samples.filter((entry) => !entry.scrolling.passed).length
  report.qualified = report.scrollFailures === 0
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`Report: ${output}`)
  if (!report.qualified) {
    console.error(`Series is NOT qualified: ${report.scrollFailures} samples failed scroll checks`)
    process.exitCode = 1
  }
} finally {
  await fixture.cleanup()
}
