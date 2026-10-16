// Renderer crash: (1) the scripted palette sequence that crashed the renderer during QA, repeated
// with render-process-gone details and memory recorded each time; (2) what the app does after a
// renderer crash (forced with webContents.forcefullyCrashRenderer): it must not leave a dead,
// blank window, and a run in progress must survive it (the reloaded window adopts the engines;
// engines nobody adopts stop after the grace period).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { launchRaw, runPalette, sleep, tempRoot, waitUntil } from './lib/kit.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const REPEATS = Number(process.env.QA_CRASH_REPEATS ?? 5)
const RENDERER_READ_TIMEOUT_MS = 1000
/** A reply that streams for ~8 s, so the crash lands mid-run and the run outlives the reload. */
const SLOW_REPLY_END = 'the reply reached its end'
const SLOW_REPLY = `${'Still streaming through the crash. '.repeat(9)}${SLOW_REPLY_END}.`
const SLOW_REPLY_DELTA_MS = 100
/** main/index.ts ORPHAN_ENGINE_GRACE_MS */
const ORPHAN_GRACE_MS = 30_000
const failures = []
async function step(label, action) {
  console.log(`  • ${label}`)
  try {
    await action()
    console.log(`    ✓ ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
  }
}

console.log('▶ shell/renderer-crash (fake)')
const root = await tempRoot('vengeance-qa-crash-')
const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })

async function launchWatched(name) {
  const run = await launchRaw({ userData: root.path(name, 'user-data'), agentDir: agentDir.dir })
  await run.app.evaluate(({ BrowserWindow }) => {
    globalThis.__qaGone = []
    BrowserWindow.getAllWindows()[0].webContents.on('render-process-gone', (_event, details) =>
      globalThis.__qaGone.push(details)
    )
  })
  const memory = () =>
    run.app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((m) => `${m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`)
        .join(' ')
    )
  const gone = () =>
    Promise.race([run.app.evaluate(() => globalThis.__qaGone), sleep(8000).then(() => null)])
  return { run, memory, gone }
}

try {
  await step(
    `palette run twice without waiting for the close animation (${REPEATS}×): renderer survives`,
    async () => {
      // The "crash" QA saw here was the probe itself: an unbounded hover on the closing palette's
      // detached row hung, and the run's outer timeout terminated Electron's renderer, GPU and
      // network processes (all exitCode 143 = 128 + SIGTERM). The probe now bounds its hovers; a
      // probe that prints no outcome (killed, hung) still counts as a failure.
      const outcomes = []
      for (let attempt = 1; attempt <= REPEATS; attempt++) {
        const probe = spawnSync(process.execPath, [join(here, 'lib', 'palette-crash-probe.mjs')], {
          encoding: 'utf8',
          timeout: 120_000
        })
        const line =
          (probe.stdout ?? '').split(String.fromCharCode(10)).find((l) => l.startsWith('PROBE ')) ??
          'PROBE null'
        const outcome = JSON.parse(line.slice(6))
        outcomes.push(outcome)
        console.log(`      attempt ${attempt}: ${JSON.stringify(outcome)}`)
      }
      const unsuccessful = outcomes.filter(
        (outcome) => !outcome || outcome.error || outcome.gone?.length
      )
      assert.deepEqual(
        unsuccessful,
        [],
        'each probe finishes both toggles without errors or crashes'
      )
    }
  )

  await step('control: the same toggles with the close animation awaited never crash', async () => {
    const { run, gone } = await launchWatched('palette-control')
    const workspace = await root.folder('palette-control-workspace')
    await run.test('openWorkspace', workspace, { noSession: true })
    for (let i = 0; i < 4; i++) await runPalette(run.page, 'Toggle sidebar')
    await sleep(800)
    assert.deepEqual(await gone(), [])
    await run.close()
  })

  await step(
    'a renderer crash reloads the window; a run in progress continues in it (engines are adopted)',
    async () => {
      const { run, gone } = await launchWatched('forced')
      const ws = await root.folder('ws-crash', { 'README.md': '# crash\n' })
      await run.test('openWorkspace', ws)
      const agentId = await run.test('activeAgentId')
      const enginePids = (await run.invoke('engine:list')).map((engine) => engine.pid)
      server.queue(turn.text(SLOW_REPLY, { chunkSize: 4, delayMs: SLOW_REPLY_DELTA_MS }))
      const composer = run.page.getByRole('textbox', { name: 'Message' })
      await composer.fill('keep going through a display crash')
      await composer.press('Enter')
      await waitUntil(async () => (await run.test('agentState', agentId))?.phase === 'running', {
        timeoutMs: 15_000,
        label: 'the run to start'
      })
      await run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
      )
      // Read through main: Playwright's page object stays marked as crashed after the reload. A
      // read that races the reload's navigation can fail or never settle, so each one is bounded.
      const inRenderer = (source) =>
        Promise.race([
          run.app
            .evaluate(
              ({ BrowserWindow }, js) =>
                BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js),
              source
            )
            .catch(() => null),
          sleep(RENDERER_READ_TIMEOUT_MS).then(() => null)
        ])
      const bodyText = async () => (await inRenderer('document.body.innerText')) ?? ''
      await waitUntil(
        async () => (await bodyText()).includes('Vengeance recovered from a display problem'),
        { timeoutMs: 15_000, label: 'the one-time recovery notice' }
      )
      const details = await gone()
      console.log(`      render-process-gone: ${JSON.stringify(details)}`)
      const adopted = await inRenderer(`(() => {
        const state = window.__vengeanceTest.agentState(${JSON.stringify(agentId)})
        return { active: window.__vengeanceTest.activeAgentId(), phase: state?.phase }
      })()`)
      console.log(`      after the reload: ${JSON.stringify(adopted)}`)
      assert.equal(adopted?.active, agentId, 'the reloaded window shows the same agent')
      assert.equal(adopted?.phase, 'running', 'the run is still in progress after the reload')
      const alive = enginePids.filter((pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      })
      assert.deepEqual(alive, enginePids, 'the engines kept running through the renderer crash')
      await waitUntil(
        async () =>
          (await inRenderer(
            `window.__vengeanceTest.agentState(${JSON.stringify(agentId)})?.phase`
          )) === 'idle',
        { timeoutMs: 30_000, label: 'the run to finish in the reloaded window' }
      )
      // The transcript, not the body text: the sidebar and header also show the prompt as the title.
      const roles = await inRenderer(
        `window.__vengeanceTest.agentState(${JSON.stringify(agentId)}).entries
          .map((e) => e.message.role).filter((role) => role === 'user' || role === 'assistant')`
      )
      assert.deepEqual(roles, ['user', 'assistant'], 'the prompt and the reply show once each')
      await waitUntil(async () => (await bodyText()).includes(SLOW_REPLY_END), {
        timeoutMs: 5_000,
        label: 'the whole reply to show'
      }).catch(async (error) => {
        const reply = await inRenderer(
          `JSON.stringify(window.__vengeanceTest.agentState(${JSON.stringify(agentId)}).entries.at(-1).message.content)`
        )
        throw new Error(
          `${error.message}; last entry: ${reply}; body: ${(await bodyText()).slice(-400)}`
        )
      })
      const view = await run.app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const image = await win.capturePage()
        return { crashed: win.webContents.isCrashed(), emptyCapture: image.isEmpty() }
      })
      assert.deepEqual(view, { crashed: false, emptyCapture: false }, 'the window is not blank')
      await run.kill()
    }
  )

  await step(
    'engines nobody adopts after a renderer crash stop after the grace period',
    async () => {
      const { run } = await launchWatched('orphans')
      const ws = await root.folder('ws-orphans', { 'README.md': '# orphans\n' })
      await run.test('openWorkspace', ws)
      const enginePids = (await run.invoke('engine:list')).map((engine) => engine.pid)
      // A reloaded window that never takes the engines over (the reply envelope is `{ ok, value }`).
      await run.app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('engine:adopt')
        ipcMain.handle('engine:adopt', () => ({ ok: true, value: [] }))
      })
      await run.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
      )
      const started = Date.now()
      const anyAlive = () =>
        enginePids.some((pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })
      await sleep(ORPHAN_GRACE_MS / 2)
      assert.ok(anyAlive(), 'the engines wait for adoption')
      await waitUntil(() => !anyAlive(), {
        timeoutMs: ORPHAN_GRACE_MS + 15_000,
        label: 'the orphaned engines to stop'
      })
      const elapsed = Date.now() - started
      console.log(`      stopped after ${Math.round(elapsed / 1000)} s`)
      const log = run
        .stderr()
        .split(/\r?\n/)
        .filter((line) => line.includes('[vengeance]'))
      assert.ok(elapsed >= ORPHAN_GRACE_MS, `stopped early; main log: ${log.join(' | ')}`)
      await run.kill()
    }
  )
} catch (error) {
  failures.push(error.stack ?? String(error))
} finally {
  await server.close()
  await agentDir.cleanup()
  await root.cleanup().catch(() => undefined)
}

if (failures.length) {
  console.error(`✗ shell/renderer-crash: ${failures.length} failure(s)`)
  process.exitCode = 1
} else console.log('✓ shell/renderer-crash passed')
