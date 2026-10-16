// App state survives a normal quit: prefs changed in the UI (theme, workspaces) and the window
// bounds must be in <userData>/app-state.json after quitting, and come back on the next launch.
// Also: an engine location set in the UI must be the one new sessions spawn with.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { startFakeLlm } from '../lib/fake-llm.mjs'
import { launchRaw, sleep, tempRoot, waitUntil } from './lib/kit.mjs'

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

console.log('▶ shell/persistence (fake, persistent temp profile)')
const root = await tempRoot('vengeance-qa-persist-')
const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })
const userData = root.path('profile', 'user-data')
const first = await root.folder('first', { 'README.md': '# one\n' })
const second = await root.folder('second', { 'README.md': '# two\n' })
const saved = async () => JSON.parse(await readFile(join(userData, 'app-state.json'), 'utf8'))
const launch = () => launchRaw({ userData, agentDir: agentDir.dir })
let run

try {
  run = await launch()

  await step('UI changes after an engine started are on disk while the app runs', async () => {
    await run.test('openWorkspace', first)
    await run.test('openSettings', 'general')
    await run.page.getByRole('button', { name: /Bone/ }).click()
    await run.test('closeSettings')
    await run.test('openWorkspace', second)
    await run.win((win) => win.setBounds({ x: 140, y: 100, width: 1200, height: 780 }))
    await sleep(1200)
    const state = await saved()
    assert.equal(state.prefs.theme, 'light')
    assert.equal(state.prefs.workspaces.length, 2)
    assert.equal(state.window?.width, 1200)
  })

  await step(
    'after a normal quit app-state.json still has them (theme, workspaces, window)',
    async () => {
      // Regression check for shell-0 (fixed in 9472547): a second AppStateStore flushed a stale copy on quit.
      assert.equal(await run.close(), true, 'quit gracefully')
      const state = await saved()
      assert.equal(state.prefs.theme, 'light', `theme after quit: ${state.prefs.theme}`)
      assert.equal(
        state.prefs.workspaces.length,
        2,
        `workspaces after quit: ${state.prefs.workspaces.length}`
      )
      assert.equal(state.prefs.onboardingCompleted !== undefined, true)
      assert.equal(state.window?.width, 1200, `window after quit: ${JSON.stringify(state.window)}`)
    }
  )

  await step('the next launch restores them', async () => {
    run = await launch()
    const { prefs } = await run.test('appState')
    assert.equal(prefs.theme, 'light')
    assert.equal(prefs.workspaces.length, 2)
    assert.equal(prefs.activeWorkspace?.toLowerCase(), second.toLowerCase())
    const bounds = await run.win((win) => win.getBounds())
    assert.equal(bounds.width, 1200)
  })

  await step('Settings → Engine custom location applies to the next spawned session', async () => {
    // Regression check for shell-0: the EngineManager read the override from the stale store.
    const missing = root.path('no-engine-here')
    await run.test('setPrefs', { engineOverridePath: missing })
    await sleep(600)
    const info = await run.invoke('engine:info')
    assert.equal(info.found, false, 'engine:info honours the override')
    await run.test('openWorkspace', first).catch(() => undefined)
    const agentId = await run.test('activeAgentId')
    const state = await waitUntil(
      async () => {
        const agent = await run.test('agentState', agentId)
        return agent && agent.status !== 'starting' ? agent : null
      },
      { timeoutMs: 60_000, label: 'spawn outcome' }
    )
    assert.equal(
      state.status,
      'crashed',
      `spawn ignored the missing engine location (status ${state.status})`
    )
    await run.test('setPrefs', { engineOverridePath: null })
  })

  const errors = run.errors()
  if (errors.length) failures.push(`app errors: ${errors.join(' | ')}`)
} catch (error) {
  failures.push(error.stack ?? String(error))
} finally {
  await run?.close().catch(() => undefined)
  await server.close()
  await agentDir.cleanup()
  await root.cleanup()
}

if (failures.length) {
  console.error(`✗ shell/persistence: ${failures.length} failure(s)`)
  process.exitCode = 1
} else console.log('✓ shell/persistence passed')
