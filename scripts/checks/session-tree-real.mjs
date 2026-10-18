// Real-engine check of long session trees (npm run e2e:tree, after npm run build). No model calls, no tokens.
// Uses a TEMP engine config dir (PI_CODING_AGENT_DIR, never the user's ~/.pi/agent) with PI_OFFLINE and one
// synthetic session file far deeper than the engine can serialize as a nested `get_tree`:
//   1. the installed engine itself answers get_tree with an error for it and keeps serving commands;
//   2. the BUILT app still shows its tree: sessions:tree (closed file) and get_tree (open session, rebuilt
//      from get_entries) both arrive flat, equal the engine's SessionManager rules, and render in Branches.
import { _electron as electron } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/** Linear entries: past the ~2200 the engine can JSON.stringify as a nested tree (pi 1.1.0). */
const LINEAR_ENTRIES = 3000
/** An abandoned side question hangs off this entry. */
const FORK_AT = 1500
const STEP_MS = 1000

const { sessionTreeFromEntries } = await loadSessionTreeModule()
const agentDir = await mkdtemp(join(tmpdir(), 'vengeance-tree-agent-'))
const workspace = await mkdtemp(join(tmpdir(), 'vengeance-tree-ws-'))
const userData = await mkdtemp(join(tmpdir(), 'vengeance-tree-profile-'))
const sessionDir = join(agentDir, 'sessions', 'deep')
await mkdir(sessionDir, { recursive: true })

const env = { ...process.env, VENGEANCE_TEST: '1', VENGEANCE_NO_MICA: '1', VENGEANCE_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }
delete env.VENGEANCE_MOCK

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

/** The synthetic session: a linear exchange, one side branch and a label, in file order. */
function sessionEntries() {
  const start = Date.UTC(2026, 0, 1)
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const entries = []
  const add = (parentId, role, text) => {
    const timestamp = start + entries.length * STEP_MS
    const id = `e${entries.length.toString(16).padStart(7, '0')}`
    const message =
      role === 'user'
        ? { role, content: text, timestamp }
        : { role, content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage, stopReason: 'stop', timestamp }
    entries.push({ type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message })
    return id
  }
  let leafId = null
  let forkId = null
  for (let i = 0; i < LINEAR_ENTRIES; i++) {
    leafId = add(leafId, i % 2 === 0 ? 'user' : 'assistant', i % 2 === 0 ? `Question ${i / 2}` : `Answer ${(i - 1) / 2}`)
    if (i === FORK_AT) forkId = leafId
  }
  const side = add(forkId, 'user', 'Abandoned side question')
  const labelTime = start + entries.length * STEP_MS
  entries.push({ type: 'label', id: 'label-side', parentId: leafId, timestamp: new Date(labelTime).toISOString(), targetId: side, label: 'side idea' })
  return entries
}

/** One engine process speaking RPC over stdio; `send` resolves with the response to its command. */
function startEngine(engine, sessionPath) {
  const childEnv = { ...env }
  if (engine.runtime === 'electron') childEnv.ELECTRON_RUN_AS_NODE = '1'
  const child = spawn(engine.nodePath, [engine.cliPath, '--mode', 'rpc', '--session', sessionPath, '--no-extensions'], { cwd: workspace, env: childEnv })
  const pending = new Map()
  let buffer = ''
  let nextId = 0
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const record = JSON.parse(line)
      if (record.type === 'response' && pending.has(record.id)) pending.get(record.id)(record)
    }
  })
  return {
    send(command) {
      const id = `t-${++nextId}`
      return new Promise((resolve) => {
        pending.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
      })
    },
    alive: () => child.exitCode === null,
    stop: () => child.kill()
  }
}

/** Write the synthetic session; the engine appends to a session it opens, so each user gets its own file. */
async function writeSession(name, entries) {
  const path = join(sessionDir, `${name}.jsonl`)
  const header = { type: 'session', version: 3, id: name, timestamp: entries[0].timestamp, cwd: workspace }
  await writeFile(path, [header, ...entries].map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

const entries = sessionEntries()
const sessionPath = await writeSession('deep', entries)
const engineSessionPath = await writeSession('deep-engine', entries)
const expected = sessionTreeFromEntries(entries)

let app
let engine
let code = 1
try {
  app = await electron.launch({ args: [root, ...ELECTRON_SWITCHES], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('[renderer]', error.message))
  await page.waitForFunction(() => !!window.__vengeanceTest, null, { timeout: 30_000 })
  const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.vengeance.invoke(c, ...a), [channel, args])
  const info = await invoke('engine:info')
  assert(info.found, `installed engine found (${info.version})`)

  console.log(`• the engine alone, ${entries.length} entries`)
  engine = startEngine(info, engineSessionPath)
  const engineTree = await engine.send({ type: 'get_tree' })
  console.log(`  get_tree: ${engineTree.success ? 'success' : `error "${engineTree.error}"`}`)
  assert(!engineTree.success, 'the engine cannot send this tree nested (the case the fallback covers)')
  const state = await engine.send({ type: 'get_state' })
  assert(state.success && engine.alive(), 'the engine keeps serving commands after the failed get_tree')
  engine.stop()
  engine = undefined

  console.log('• sessions:tree (closed file, in-process SDK)')
  const fileTree = await invoke('sessions:tree', sessionPath)
  assert(isDeepStrictEqual(fileTree.nodes, expected), `flat tree with all ${entries.length} entries, equal to the get_entries rules`)
  assert(fileTree.nodes.find((node) => node.entry.id === entries.at(-2).id)?.label === 'side idea', 'the side question carries its label')

  console.log('• get_tree through the open session')
  const agentId = await page.evaluate(([cwd, path]) => window.__vengeanceTest.openWorkspace(cwd, { sessionPath: path }), [workspace, sessionPath])
  const response = await invoke('engine:command', agentId, { type: 'get_tree' })
  const live = await invoke('engine:command', agentId, { type: 'get_entries' })
  assert(response.success && live.success, 'get_tree and get_entries answer')
  assert(isDeepStrictEqual(response.data.nodes, sessionTreeFromEntries(live.data.entries)), 'get_tree answers with the tree rebuilt from get_entries')
  assert(response.data.leafId === live.data.leafId, 'with the engine leaf')
  const listed = new Set(response.data.nodes.map((node) => node.entry.id))
  assert(entries.every((entry) => listed.has(entry.id)), `all ${entries.length} entries of the file are in it`)
  const agentState = await invoke('engine:command', agentId, { type: 'get_state' })
  const agent = (await invoke('engine:list')).find((a) => a.agentId === agentId)
  assert(agentState.success && agent.status === 'ready', 'the agent stays ready (not crashed)')

  await page.evaluate(() => window.__vengeanceTest.setPrefs({ inspector: { open: true, width: 360, tab: 'branches' } }))
  await page.getByText('Session tree').waitFor({ timeout: 30_000 })
  await page.getByText(`Answer ${LINEAR_ENTRIES / 2 - 1}`).first().waitFor({ timeout: 30_000 })
  assert((await page.getByText('Could not load the session tree').count()) === 0, 'the Branches tab renders the deep tree')
  console.log('✓ e2e:tree passed')
  code = 0
} catch (error) {
  console.error(`✗ e2e:tree failed: ${error.stack ?? error}`)
} finally {
  engine?.stop()
  await app?.close().catch(() => undefined)
  for (const dir of [agentDir, workspace, userData]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
}
process.exit(code)
