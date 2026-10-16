// One attempt of the palette renderer-crash repro, in its own Node process because a crashed
// renderer leaves Playwright's connection unusable for further launches in the same process.
// Prints one line: PROBE <json { gone, error, memoryBefore }>.
import assert from 'node:assert/strict'
import { createAgentDir } from '../../lib/agent-dir.mjs'
import { startFakeLlm } from '../../lib/fake-llm.mjs'
import {
  isAlive,
  killTree,
  launchRaw,
  paletteWithoutClosePause,
  sleep,
  tempRoot,
  waitUntil
} from './kit.mjs'

const root = await tempRoot('vengeance-qa-crashprobe-')
const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })
const run = await launchRaw({ userData: root.path('user-data'), agentDir: agentDir.dir })
const workspace = await root.folder('workspace', { 'README.md': '# Palette crash probe\n' })
await run.test('openWorkspace', workspace, { noSession: true })
await run.app.evaluate(({ app, BrowserWindow }) => {
  globalThis.__qaGone = []
  BrowserWindow.getAllWindows()[0].webContents.on('render-process-gone', (_event, details) =>
    globalThis.__qaGone.push({ type: 'Tab', ...details })
  )
  // GPU and network service deaths too: all children dying at once means an outside kill.
  app.on('child-process-gone', (_event, details) => globalThis.__qaGone.push(details))
})
const memoryBefore = await run.app.evaluate(({ app }) =>
  app
    .getAppMetrics()
    .map((m) => `${m.type}:${Math.round(m.memory.workingSetSize / 1024)}MB`)
    .join(' ')
)
let error = null
try {
  const sidebarBefore = (await run.test('appState')).prefs.sidebar.open
  await paletteWithoutClosePause(run.page, 'Toggle sidebar')
  assert.notEqual((await run.test('appState')).prefs.sidebar.open, sidebarBefore)
  await paletteWithoutClosePause(run.page, 'Toggle sidebar')
  assert.equal((await run.test('appState')).prefs.sidebar.open, sidebarBefore)
  await sleep(1000)
} catch (caught) {
  error = caught.message.split('\n')[0]
}
const gone = await Promise.race([
  run.app.evaluate(() => globalThis.__qaGone),
  sleep(8000).then(() => null)
])
console.log(`PROBE ${JSON.stringify({ gone, error, memoryBefore })}`)
// The whole tree, and wait for it: an engine that outlives the app keeps the temp folders locked.
await killTree(run.pid)
await waitUntil(() => !isAlive(run.pid), { timeoutMs: 10_000 }).catch(() => undefined)
await server.close()
await agentDir.cleanup().catch(() => undefined)
await root.cleanup().catch(() => undefined)
process.exit(error || !gone || gone.length ? 1 : 0)
