// Real-engine check of Settings → MCP "Reconnect in open sessions" (npm run e2e:mcp, after npm run build).
// Uses a TEMP engine config dir (PI_CODING_AGENT_DIR) whose mcp.json declares one trivial stdio MCP server
// (written below; it logs every start to a file). The BUILT app opens a temp workspace (--no-session), then
// sends exactly what the MCP section sends to each open session — `/mcp reconnect <server>` through RPC
// `prompt` — and asserts the engine handled it and restarted the server. No model calls, no tokens.
import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ELECTRON_SWITCHES } from '../qa/lib/platform.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing — run `npm run build` first.')
  process.exit(1)
}

const SERVER = 'vengeance-echo'
const agentDir = await mkdtemp(join(tmpdir(), 'vengeance-mcp-agent-'))
const workspace = await mkdtemp(join(tmpdir(), 'vengeance-mcp-ws-'))
const userData = await mkdtemp(join(tmpdir(), 'vengeance-mcp-profile-'))
const startsLog = join(agentDir, 'server-starts.log')
const serverFile = join(agentDir, 'echo-server.mjs')

// Minimal MCP server over stdio (newline-delimited JSON-RPC): initialize, tools/list, tools/call.
await writeFile(
  serverFile,
  `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(startsLog)}, 'start\\n')
let buffer = ''
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    if (request.method === 'initialize') {
      send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: '${SERVER}', version: '1.0.0' } } })
    } else if (request.method === 'tools/list') {
      send({ id: request.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } })
    } else if (request.method === 'tools/call') {
      send({ id: request.id, result: { content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] } })
    } else {
      send({ id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
})
`
)
await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [serverFile] } } }, null, 2))

const env = { ...process.env, VENGEANCE_TEST: '1', VENGEANCE_NO_MICA: '1', VENGEANCE_USER_DATA: userData, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }
delete env.VENGEANCE_MOCK

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

async function starts() {
  try {
    return (await readFile(startsLog, 'utf8')).split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out waiting for ${label}`)
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

  console.log(`• engine config dir ${agentDir}`)
  const agentId = await page.evaluate((cwd) => window.__vengeanceTest.openWorkspace(cwd, { noSession: true }), workspace)
  const commands = (await rpc(agentId, { type: 'get_commands' })).commands
  assert(commands.some((c) => c.name === 'mcp'), 'the session offers /mcp (Settings → MCP targets it)')

  await waitFor(async () => (await starts()) >= 1, 30_000, 'the MCP server to start')
  assert((await starts()) === 1, 'MCP server started once with the session')

  console.log(`• /mcp reconnect ${SERVER}`)
  const result = await rpc(agentId, { type: 'prompt', message: `/mcp reconnect ${SERVER}` })
  assert(result?.disposition === 'handled', `prompt handled as an extension command (${result?.disposition})`)
  await waitFor(async () => (await starts()) >= 2, 30_000, 'the MCP server to restart')
  assert((await starts()) === 2, 'MCP server was restarted by the reconnect')

  console.log('✓ e2e:mcp passed')
  code = 0
} catch (error) {
  console.error(`✗ e2e:mcp failed: ${error.stack ?? error}`)
} finally {
  await app?.close().catch(() => undefined)
  for (const dir of [workspace, userData, agentDir]) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
process.exit(code)
