// Robustness: the Engine killed mid-run (crash state, Restart engine, session kept), stderr noise,
// quitting with a running agent and a running tool (no orphan processes of OUR app, no main-process
// error), closing the window while a dialog is open, and single-instance with test mode OFF.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import electron from 'electron'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { inspectRequest, startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { ROOT } from '../lib/app.mjs'
import { ELECTRON_SWITCHES } from '../lib/platform.mjs'
import {
  descendants,
  isAlive,
  killTree,
  launchRaw,
  processTable,
  shot,
  sleep,
  tempRoot,
  waitUntil
} from './lib/kit.mjs'

const failures = []
const only = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY) : null
async function step(label, action) {
  if (only && !only.test(label)) return
  console.log(`  • ${label}`)
  try {
    await action()
    console.log(`    ✓ ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
  }
}

/** A user extension that writes to stderr at load and on every agent start (engine noise). */
const NOISY_EXTENSION = [
  'export default function (pi) {',
  "  for (let i = 0; i < 200; i++) console.error(`[noise] startup line ${i} ${'x'.repeat(120)}`)",
  "  pi.on('agent_start', () => { for (let i = 0; i < 50; i++) console.error(`[noise] turn line ${i}`) })",
  '}',
  ''
].join('\n')

console.log('▶ shell/robustness (fake)')
const root = await tempRoot('vengeance-qa-robust-')
const server = await startFakeLlm()
const agentDir = await createAgentDir({
  server,
  files: { 'extensions/qa-noise.ts': NOISY_EXTENSION }
})

const composer = (page) => page.getByRole('textbox', { name: 'Message' }).first()
async function send(run, text) {
  await composer(run.page).fill(text)
  await composer(run.page).press('Enter')
}
async function settle(run) {
  await run.test('waitForIdle', 60_000)
  await sleep(400)
}

try {
  // ── Engine killed mid-run ──────────────────────────────────────────────────────────────────
  let run = await launchRaw({ userData: root.path('kill', 'user-data'), agentDir: agentDir.dir })
  const ws = await root.folder('ws-kill', { 'README.md': '# kill\n' })

  await step(
    'stderr noise from an extension: session works, no noise in the transcript or errors',
    async () => {
      await run.test('openWorkspace', ws)
      server.queue(turn.text('First answer survives.'))
      await send(run, 'first prompt')
      await settle(run)
      await run.page.getByText('First answer survives.').waitFor()
      const stderr = await run.invoke('engine:stderr', await run.test('activeAgentId'))
      assert.match(stderr, /\[noise\] startup line 199/)
      const body = await run.page.locator('main').innerText()
      assert.doesNotMatch(body, /\[noise\]/)
      assert.deepEqual(run.errors(), [])
    }
  )

  let killedPid
  await step(
    'Engine killed mid-run: crash card with the reason, Restart engine, Close tab',
    async () => {
      const agentId = await run.test('activeAgentId')
      const from = server.requests.length
      server.queue(turn.hang({ text: 'partial before the kill' }))
      await send(run, 'second prompt (will be killed)')
      await server.waitForRequest(undefined, { from })
      await run.page.getByText('partial before the kill').waitFor()
      ;[{ pid: killedPid }] = await run.invoke('engine:list')
      await killTree(killedPid)
      await waitUntil(async () => (await run.test('agentState', agentId))?.status === 'crashed', {
        label: 'crashed state'
      })
      await run.page.getByText('The engine stopped').waitFor()
      await run.page.getByText(/Your conversation is saved/).waitFor()
      await run.page.getByRole('button', { name: 'Restart engine' }).waitFor()
      // The sidebar row has its own "Close tab" icon button; this one is on the crash card.
      await run.page.locator('main').getByRole('button', { name: 'Close tab' }).waitFor()
      await shot(run.page, 'robust-1-engine-killed')
      const state = await run.test('agentState', agentId)
      assert.equal(state.phase, 'idle', `no endless spinner after the crash (phase ${state.phase})`)
    }
  )

  await step(
    'Diagnostics shows the engine stderr tail (noise) without raw protocol JSON',
    async () => {
      await run.page.getByRole('button', { name: 'Diagnostics' }).click()
      const pre = await run.page.locator('pre').last().innerText()
      assert.match(pre, /\[noise\]/)
      assert.doesNotMatch(pre, /"type":"(response|message_update)"/)
    }
  )

  await step('Restart engine resumes the same session file with the earlier messages', async () => {
    const agentId = await run.test('activeAgentId')
    const sessionBefore = (await run.test('agentState', agentId)).info.sessionFile
    await run.page.getByRole('button', { name: 'Restart engine' }).click()
    await waitUntil(async () => (await run.test('agentState', agentId))?.status === 'ready', {
      timeoutMs: 60_000,
      label: 'restarted'
    })
    const info = (await run.test('agentState', agentId)).info
    assert.equal(info.sessionFile, sessionBefore)
    assert.notEqual(info.pid, killedPid)
    const response = await run.invoke('engine:command', agentId, { type: 'get_messages' })
    const texts = JSON.stringify(response.data.messages)
    assert.match(texts, /first prompt/)
    assert.match(texts, /First answer survives\./)
    await run.page.getByText('First answer survives.').waitFor()
    const from = server.requests.length
    server.queue(turn.text('Back after restart.'))
    await send(run, 'after restart')
    await settle(run)
    const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
    assert.ok(
      sent.messages.some((m) => m.text.includes('first prompt')),
      'history goes to the model'
    )
    await shot(run.page, 'robust-2-restarted')
  })

  // ── Quit while an agent runs a tool ───────────────────────────────────────────────────────
  await step(
    'quit while running a long bash tool: every process of this app exits, no main error',
    async () => {
      server.queue(
        turn.toolCalls([{ id: 'toolu_sleep', name: 'bash', args: { command: 'sleep 120' } }]),
        turn.text('never reached')
      )
      await send(run, 'run a long command')
      await waitUntil(
        async () => {
          const table = await processTable()
          return descendants(table, run.pid).some(
            (p) => /sleep/i.test(p.name) || /sleep 120/.test(p.commandLine)
          )
        },
        { timeoutMs: 30_000, label: 'sleep 120 running' }
      )
      const tree = descendants(await processTable(), run.pid)
      const engines = tree.filter(
        (p) => /node(\.exe)?$/i.test(p.name) || /pi-coding-agent/.test(p.commandLine)
      )
      console.log(
        `      app tree before quit: ${tree.length} processes (${engines.length} engine/node)`
      )
      const started = Date.now()
      const closing = run.close({ timeoutMs: 20_000 })
      let mainGoneAfter = null
      for (let second = 2; second <= 20; second += 3) {
        await sleep(3000)
        if (mainGoneAfter === null && !isAlive(run.pid)) mainGoneAfter = second + 1
        const living = tree.filter((p) => isAlive(p.pid)).map((p) => p.name)
        console.log(
          `      +${second + 1}s: main ${isAlive(run.pid) ? 'alive' : 'gone'}; alive: ${living.join(', ') || 'none'}`
        )
        if (!isAlive(run.pid)) break
      }
      const graceful = await closing
      const quitMs = Date.now() - started
      await sleep(1500)
      const alive = tree.filter((p) => isAlive(p.pid))
      console.log(
        `      quit took ${quitMs} ms (graceful: ${graceful}); survivors: ${alive.map((p) => `${p.name}#${p.pid}`).join(', ') || 'none'}`
      )
      for (const p of alive) await killTree(p.pid)
      // Playwright's close() may not resolve after the app exits; what matters is that the main process left.
      assert.equal(
        mainGoneAfter !== null && mainGoneAfter <= 10,
        true,
        `main exited within 10 s (${mainGoneAfter})`
      )
      assert.deepEqual(
        alive.map((p) => `${p.name}#${p.pid}`),
        [],
        'orphaned processes after quit'
      )
      assert.deepEqual(run.errors(), [], 'no renderer/main errors')
    }
  )

  // ── Closing during dialogs ───────────────────────────────────────────────────────────────
  await step(
    'closing the window while the Trust dialog is open quits cleanly, nothing spawned',
    async () => {
      run = await launchRaw({ userData: root.path('dialog', 'user-data'), agentDir: agentDir.dir })
      const trusty = await root.folder('ws-dialog', {
        '.pi/skills/s/SKILL.md': '---\nname: s\ndescription: d\n---\nx\n'
      })
      void run.test('openWorkspace', trusty).catch(() => undefined)
      await run.page.getByRole('dialog', { name: /^Trust “/ }).waitFor()
      const before = descendants(await processTable(), run.pid)
      await run.win((win) => win.close())
      await waitUntil(() => !isAlive(run.pid), { timeoutMs: 15_000, label: 'app exit' })
      const stray = before.filter((p) => isAlive(p.pid))
      for (const p of stray) await killTree(p.pid)
      assert.deepEqual(
        stray.map((p) => p.name),
        []
      )
      assert.deepEqual(
        run.errors().filter((e) => !/Target page|closed/.test(e)),
        []
      )
    }
  )

  await step('closing the window with Settings and the palette open quits cleanly', async () => {
    run = await launchRaw({ userData: root.path('dialog2', 'user-data'), agentDir: agentDir.dir })
    const plain = await root.folder('ws-dialog2', { 'README.md': '# d\n' })
    await run.test('openWorkspace', plain)
    await run.test('openSettings', 'general')
    await run.page.keyboard.press('ControlOrMeta+k')
    const before = descendants(await processTable(), run.pid)
    await run.win((win) => win.close())
    await waitUntil(() => !isAlive(run.pid), { timeoutMs: 15_000, label: 'app exit' })
    await sleep(1000)
    const stray = before.filter((p) => isAlive(p.pid))
    for (const p of stray) await killTree(p.pid)
    assert.deepEqual(
      stray.map((p) => p.name),
      []
    )
  })

  // ── A package whose extension cannot load ────────────────────────────────────────────────
  await step(
    'a broken package stops the engine: the crash card offers "Remove <package>", which brings it back',
    async () => {
      const brokenPackage = await root.folder('qa-broken-pkg', {
        'package.json': { name: 'qa-broken-pkg', version: '1.0.0', keywords: ['pi-package'] },
        'extensions/broken.ts': 'export default function (pi) {\n  this is not typescript\n}\n'
      })
      const brokenAgentDir = await createAgentDir({
        server,
        settings: { packages: [brokenPackage] }
      })
      run = await launchRaw({
        userData: root.path('broken', 'user-data'),
        agentDir: brokenAgentDir.dir
      })
      try {
        const ws = await root.folder('ws-broken', { 'README.md': '# broken\n' })
        void run.test('openWorkspace', ws).catch(() => undefined)
        const card = run.page.locator('main')
        await card.getByText('The engine stopped').waitFor({ timeout: 60_000 })
        const reason = await card
          .getByText(/Failed to load extension/)
          .first()
          .innerText()
        assert.doesNotMatch(
          reason,
          /[A-Za-z]:[\\/]/,
          `the reason shows display paths only: ${reason}`
        )
        const remove = card.getByRole('button', { name: /^Remove / })
        await remove.waitFor({ timeout: 20_000 })
        await shot(run.page, 'robust-4-broken-package')
        await remove.click()
        const agentId = await run.test('activeAgentId')
        await waitUntil(async () => (await run.test('agentState', agentId))?.status === 'ready', {
          timeoutMs: 60_000,
          label: 'engine ready after removing the package'
        })
        const settings = await brokenAgentDir.readJson('settings.json')
        assert.deepEqual(settings.packages ?? [], [], 'the package entry is gone')
        await run.page.getByRole('textbox', { name: 'Message' }).first().waitFor()
      } finally {
        await run.close()
        await brokenAgentDir.cleanup()
      }
    }
  )

  // ── Single instance (test mode OFF) ──────────────────────────────────────────────────────
  await step(
    'single instance (test mode off): a 2nd launch exits and hands its folder to the 1st',
    async () => {
      const userData = root.path('single', 'user-data')
      run = await launchRaw({ userData, agentDir: agentDir.dir, test: false })
      const holds = await run.app.evaluate(({ app }) => app.hasSingleInstanceLock())
      assert.equal(holds, true, 'first instance holds the lock on its temp profile')
      const folder = await root.folder('ws-second-instance', { 'README.md': '# hand-off\n' })
      const env = {
        ...process.env,
        VENGEANCE_USER_DATA: userData,
        PI_CODING_AGENT_DIR: agentDir.dir,
        PI_OFFLINE: '1'
      }
      delete env.VENGEANCE_TEST
      const second = spawn(electron, [ROOT, ...ELECTRON_SWITCHES, folder], { env, stdio: 'ignore' })
      const exitCode = await new Promise((resolveExit) => {
        const timer = setTimeout(() => resolveExit('still running after 20 s'), 20_000)
        second.on('exit', (code) => {
          clearTimeout(timer)
          resolveExit(code)
        })
      })
      if (exitCode === 'still running after 20 s') await killTree(second.pid)
      assert.equal(exitCode, 0, `second instance exit: ${exitCode}`)
      await waitUntil(
        async () =>
          (await run.invoke('app:get-state')).activeWorkspace?.toLowerCase() ===
          folder.toLowerCase(),
        { timeoutMs: 20_000, label: 'folder handed to the first instance' }
      )
      await run.page.getByRole('textbox', { name: 'Message' }).first().waitFor({ timeout: 60_000 })
      await shot(run.page, 'robust-3-second-instance-folder')
      assert.equal(await run.page.evaluate(() => typeof window.__vengeanceTest), 'undefined')
      await run.close()
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
  console.error(`✗ shell/robustness: ${failures.length} failure(s)`)
  process.exitCode = 1
} else console.log('✓ shell/robustness passed')
