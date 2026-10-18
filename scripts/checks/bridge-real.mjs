// Real-engine check of the Vengeance bridge extension (npm run e2e:bridge, after npm run build).
// Launches the BUILT app against the installed engine with a temp workspace, temp session dir and temp
// Electron profile, sends ONE tiny prompt, then exercises every bridge operation through `engine:bridge`:
// in-place tree navigation (same session file, leaf moves), labels, get/set active tools, reload.
import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ELECTRON_SWITCHES } from '../qa/lib/platform.mjs'
import { loadSessionTreeModule } from './session-tree-module.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing — run `npm run build` first.')
  process.exit(1)
}

const { sessionTreeFromEntries } = await loadSessionTreeModule()
const workspace = await mkdtemp(join(tmpdir(), 'vengeance-bridge-ws-'))
const sessionDir = await mkdtemp(join(tmpdir(), 'vengeance-bridge-sessions-'))
const userData = await mkdtemp(join(tmpdir(), 'vengeance-bridge-profile-'))
await writeFile(join(workspace, 'README.md'), '# bridge scratch workspace\n')

const env = { ...process.env, VENGEANCE_TEST: '1', VENGEANCE_NO_MICA: '1', VENGEANCE_USER_DATA: userData }
delete env.VENGEANCE_MOCK

async function sessionFiles() {
  const out = []
  for (const entry of await readdir(sessionDir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(entry.parentPath ?? entry.path, entry.name))
  }
  return out.sort()
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

let app
let code = 1
try {
  app = await electron.launch({ args: [root, ...ELECTRON_SWITCHES], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('[renderer]', error.message))
  await page.waitForFunction(() => !!window.__vengeanceTest, null, { timeout: 30_000 })

  const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.vengeance.invoke(c, ...a), [channel, args])
  const rpc = async (agentId, command) => {
    const response = await invoke('engine:command', agentId, command)
    if (!response.success) throw new Error(`${command.type}: ${response.error}`)
    return response.data
  }

  console.log(`• opening ${workspace} (sessions in ${sessionDir})`)
  const agentId = await page.evaluate(
    ([cwd, dir]) => window.__vengeanceTest.openWorkspace(cwd, { sessionDir: dir, thinking: 'low' }),
    [workspace, sessionDir]
  )
  const info = (await invoke('engine:list')).find((a) => a.agentId === agentId)
  const stderr = await invoke('engine:stderr', agentId)
  console.log(`• engine pid ${info.pid}; stderr tail: ${JSON.stringify(stderr.slice(-300))}`)
  assert(info.bridge === true, 'bridge loaded (AgentInfo.bridge)')
  assert(!/Failed to load extension/.test(stderr), 'no extension load errors on stderr')
  const commands = await rpc(agentId, { type: 'get_commands' })
  const bridgeCommands = commands.commands.filter((c) => c.name.startsWith('vengeance-'))
  console.log(`• bridge commands: ${bridgeCommands.map((c) => `${c.name} (${c.sourceInfo.source}/${c.sourceInfo.scope})`).join(', ')}`)
  assert(bridgeCommands.length === 6, 'all six bridge commands registered')
  const listed = await page.evaluate(() => /vengeance-(tree|reload|tools|label|subagents|speed)/.test(document.body.innerText))
  assert(!listed, 'bridge commands are not shown in the UI')

  console.log('• prompting "Reply with exactly: ok"')
  await rpc(agentId, { type: 'prompt', message: 'Reply with exactly: ok' })
  await page.waitForFunction(() => window.__vengeanceTest.assistantText().length > 0, null, { timeout: 180_000 })
  await page.evaluate(() => window.__vengeanceTest.waitForIdle(180_000))
  console.log(`• reply: ${JSON.stringify((await page.evaluate(() => window.__vengeanceTest.assistantText())).trim())}`)

  const filesBefore = await sessionFiles()
  const before = await rpc(agentId, { type: 'get_tree' })
  const entries = (await rpc(agentId, { type: 'get_entries' })).entries
  const user = entries.find((e) => e.type === 'message' && e.message.role === 'user')
  const assistant = entries.find((e) => e.type === 'message' && e.message.role === 'assistant')
  assert(filesBefore.length === 1, `one session file before navigation (${filesBefore.length})`)
  assert(before.leafId === assistant.id, 'leaf is the assistant reply')
  const seenIds = new Set()
  const parentsFirst = before.nodes.every((node) => {
    const ordered = node.parentId === null || seenIds.has(node.parentId)
    seenIds.add(node.entry.id)
    return ordered
  })
  assert(parentsFirst && seenIds.size === entries.length, 'get_tree arrives flat in pre-order with every entry')
  assert(before.nodes.find((node) => node.entry.id === assistant.id)?.parentId === user.id, 'the reply hangs off the prompt in get_tree')
  assert(isDeepStrictEqual(before.nodes, sessionTreeFromEntries(entries)), 'the engine get_tree equals the tree built from get_entries')

  console.log('• navigateTree → user message (in place)')
  const tree = await invoke('engine:bridge', agentId, { op: 'tree', entryId: user.id }, undefined)
  console.log(`  result ${JSON.stringify(tree)}`)
  const after = await rpc(agentId, { type: 'get_tree' })
  const messagesAfter = (await rpc(agentId, { type: 'get_messages' })).messages
  assert(tree.cancelled === false && tree.leafId === user.parentId, 'leaf moved to the parent of the user message')
  assert(after.leafId === user.parentId, 'get_tree leaf changed')
  assert(tree.editorText === 'Reply with exactly: ok', 'editorText returned for the composer')
  console.log(`  context roles: ${messagesAfter.map((m) => m.role).join(', ') || '(none)'}`)
  assert(!messagesAfter.some((m) => m.role === 'user' || m.role === 'assistant'), 'context no longer has the exchange')
  assert(JSON.stringify(await sessionFiles()) === JSON.stringify(filesBefore), 'no new session file')

  console.log('• navigateTree → assistant reply (back)')
  const back = await invoke('engine:bridge', agentId, { op: 'tree', entryId: assistant.id }, undefined)
  assert(back.leafId === assistant.id, 'leaf back on the assistant reply')
  const conversation = async () => (await rpc(agentId, { type: 'get_messages' })).messages.filter((m) => m.role === 'user' || m.role === 'assistant').length
  assert((await conversation()) === 2, 'context restored (user + assistant)')

  console.log('• setLabel')
  await invoke('engine:bridge', agentId, { op: 'label', entryId: user.id, label: 'checkpoint' }, undefined)
  const labelled = await rpc(agentId, { type: 'get_tree' })
  assert(labelled.nodes.find((node) => node.entry.id === user.id)?.label === 'checkpoint', 'label visible in get_tree')
  const labelledEntries = (await rpc(agentId, { type: 'get_entries' })).entries
  assert(isDeepStrictEqual(labelled.nodes, sessionTreeFromEntries(labelledEntries)), 'with a label and a moved leaf, get_tree still equals the tree built from get_entries')

  console.log('• getTools / setTools')
  const tools = await invoke('engine:bridge', agentId, { op: 'tools-get' }, undefined)
  console.log(`  active: ${tools.active.join(', ')} (of ${tools.tools.length})`)
  assert(tools.active.includes('bash') && tools.tools.some((t) => t.name === 'read' && t.exposure), 'tools listed with exposure')
  const reduced = await invoke('engine:bridge', agentId, { op: 'tools-set', names: tools.active.filter((n) => n !== 'bash') }, undefined)
  assert(!reduced.active.includes('bash'), 'bash deactivated')
  const restored = await invoke('engine:bridge', agentId, { op: 'tools-set', names: tools.active }, undefined)
  assert(restored.active.includes('bash'), 'bash re-activated')

  console.log('• response speed: read, choose Fast, back to Standard')
  const speed = await invoke('engine:bridge', agentId, { op: 'speed' }, undefined)
  console.log(`  ${JSON.stringify(speed)}`)
  assert(['standard', 'fast', 'ultrafast'].includes(speed.requested) && Array.isArray(speed.options), 'speed state readable')
  const fast = await invoke('engine:bridge', agentId, { op: 'speed', mode: 'fast' }, undefined)
  assert(fast.requested === 'fast', 'Fast requested for the session')
  const standard = await invoke('engine:bridge', agentId, { op: 'speed', mode: 'standard' }, undefined)
  assert(standard.requested === 'standard' && standard.effective === 'standard', 'speed back to Standard')

  console.log('• reload')
  const pidBefore = (await invoke('engine:list')).find((a) => a.agentId === agentId).pid
  await invoke('engine:bridge', agentId, { op: 'reload' }, undefined)
  const afterReload = (await invoke('engine:list')).find((a) => a.agentId === agentId)
  assert(afterReload.pid === pidBefore && afterReload.status === 'ready', 'same engine process after reload')
  assert(afterReload.bridge === true, 'bridge still loaded after reload')
  assert((await conversation()) === 2, 'session intact after reload')

  const statuses = await page.evaluate(() => document.body.innerText.includes('__vengeance'))
  assert(!statuses, 'bridge replies never reach the UI')

  console.log('✓ e2e:bridge passed')
  code = 0
} catch (error) {
  console.error(`✗ e2e:bridge failed: ${error.stack ?? error}`)
} finally {
  await app?.close().catch(() => undefined)
  for (const dir of [workspace, sessionDir, userData]) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
process.exit(code)
