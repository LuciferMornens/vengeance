import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  ENGINE_MCP_REQUEST_EVENT,
  ENGINE_MCP_STATE_EVENT,
  MCP_STATUS_KEY
} from '../../resources/bridge/mcp-status-core'
import { check } from './harness'

/** The parts of a pi extension context the bridge reads in these checks. */
interface FakeContext {
  ui: { setStatus(key: string, value: string | undefined): void }
  getSystemPrompt(): string
  sessionManager: { getBranch(): unknown[] }
  model: undefined
  modelRegistry: { isUsingOAuth(): boolean }
}

type Handler = (event: unknown, ctx: FakeContext) => unknown
type Listener = (data: unknown) => void
type Reply = { ok: true; data: unknown } | { ok: false; error: string }

/** An `ExtensionAPI` double: events run when the check fires them, commands when it calls them. */
class FakePi {
  private readonly handlers = new Map<string, Handler[]>()
  private readonly commands = new Map<string, Handler>()
  private readonly listeners = new Map<string, Listener[]>()
  private requests = 0
  active = ['read', 'bash']
  prompt = 'base'
  readonly statuses = new Map<string, string | undefined>()
  /** Every MCP status the bridge published, in order. */
  readonly published: Array<string | undefined> = []
  readonly ctx: FakeContext = {
    ui: {
      setStatus: (key, value) => {
        this.statuses.set(key, value)
        if (key === MCP_STATUS_KEY) this.published.push(value)
      }
    },
    getSystemPrompt: () => this.prompt,
    sessionManager: { getBranch: () => [] },
    model: undefined,
    modelRegistry: { isUsingOAuth: () => false }
  }
  readonly events = {
    on: (name: string, listener: Listener) => {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return () => undefined
    },
    emit: (name: string, data: unknown) => {
      for (const listener of this.listeners.get(name) ?? []) listener(data)
    }
  }

  on(name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
  }
  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, options.handler)
  }
  getActiveTools(): string[] {
    return [...this.active]
  }
  getAllTools(): Array<{ name: string }> {
    return this.active.map((name) => ({ name }))
  }
  setActiveTools(names: string[]): void {
    this.active = [...names]
  }
  setLabel(): void {}
  appendEntry(): void {}

  async fire(name: string, event: Record<string, unknown> = {}): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) {
      await handler({ type: name, ...event }, this.ctx)
    }
  }
  /** A run of one turn: `during` is the prompt with the sections added when it started. */
  async run(during: string): Promise<void> {
    const base = this.prompt
    this.prompt = during
    await this.fire('turn_start', { turnIndex: 0 })
    this.prompt = base
    await this.fire('agent_settled', { aborted: false })
  }
  async call(name: string, payload: Record<string, unknown> = {}): Promise<Reply> {
    const handler = this.commands.get(name)
    assert.ok(handler, `${name} is registered`)
    const reqId = `r${++this.requests}`
    await handler(JSON.stringify({ reqId, ...payload }), this.ctx)
    const body = this.statuses.get(`__vengeance:${reqId}`)
    assert.ok(body, `${name} replied`)
    return JSON.parse(body) as Reply
  }
  async systemPrompt(): Promise<unknown> {
    const reply = await this.call('vengeance-system-prompt')
    assert.ok(reply.ok)
    return reply.data
  }
}

/** The bridge's runtime imports of the Engine resolve to the running Engine; stand-ins here. */
async function loadBridge(): Promise<(pi: FakePi) => void> {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'vengeance-bridge-module-'))
  try {
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const outfile = join(directory, 'bridge.mjs')
    await esbuild.build({
      entryPoints: [join(root, 'resources', 'bridge', 'vengeance-bridge.ts')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      plugins: [
        {
          name: 'engine-stand-in',
          setup(bundler) {
            bundler.onResolve({ filter: /^@earendil-works\// }, (args) => ({
              path: args.path,
              namespace: 'fixture'
            }))
            bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
              contents: [
                'export const convertToLlm = () => []',
                'export const calculateCost = () => undefined'
              ].join('\n'),
              loader: 'js'
            }))
          }
        }
      ],
      logLevel: 'warning'
    })
    // The bundle's default export is the extension factory, typed here at the module boundary.
    const loaded = (await import(pathToFileURL(outfile).href)) as { default: (pi: FakePi) => void }
    return loaded.default
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const vengeanceBridge = await loadBridge()

function engineState(state: string): unknown {
  return {
    version: 1,
    servers: [{ name: 'docs', state, exposure: 'codemode', oauth: false }],
    configErrors: []
  }
}

async function started(): Promise<FakePi> {
  const pi = new FakePi()
  vengeanceBridge(pi)
  await pi.fire('session_start', { reason: 'startup' })
  return pi
}

await check('bridge prompt: a turn’s prompt is complete while its inputs hold', async () => {
  const pi = await started()
  assert.deepEqual(await pi.systemPrompt(), { text: 'base', partial: true })
  await pi.run('base\n\n<mcp_servers>')
  assert.deepEqual(await pi.systemPrompt(), { text: 'base\n\n<mcp_servers>' })
  // The same MCP status published again changes nothing.
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connected'))
  await pi.run('base\n\n<mcp_servers>docs')
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connected'))
  assert.deepEqual(await pi.systemPrompt(), { text: 'base\n\n<mcp_servers>docs' })
  await pi.fire('session_start', { reason: 'new' })
  assert.deepEqual(await pi.systemPrompt(), { text: 'base', partial: true })
})

await check('bridge prompt: a tool, base prompt or MCP change makes it partial', async () => {
  const pi = await started()
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connected'))
  const full = 'base\n\n<mcp_servers>docs'
  // Another extension changes the tools, whether or not the base prompt lists them.
  await pi.run(full)
  pi.setActiveTools(['read'])
  assert.deepEqual(await pi.systemPrompt(), { text: 'base', partial: true })
  await pi.run(full)
  // The bridge's own tool change.
  assert.ok((await pi.call('vengeance-tools', { op: 'set', names: ['bash'] })).ok)
  assert.deepEqual(await pi.systemPrompt(), { text: 'base', partial: true })
  await pi.run(full)
  // Skills, context files or tool descriptions the base prompt holds.
  pi.prompt = 'base with a new skill'
  assert.deepEqual(await pi.systemPrompt(), { text: 'base with a new skill', partial: true })
  await pi.run(`${pi.prompt}\n\n<mcp_servers>docs`)
  // A server that was disabled or reconnected, by the app or a typed command.
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('disabled'))
  assert.deepEqual(await pi.systemPrompt(), { text: 'base with a new skill', partial: true })
})

await check('bridge MCP: each change publishes once, one made before the session too', async () => {
  const pi = new FakePi()
  vengeanceBridge(pi)
  const states = () =>
    pi.published.map((json) => {
      const status = JSON.parse(json ?? 'null') as { servers: Array<{ state: string }> } | null
      return status?.servers[0]?.state
    })
  // The built-in extension published before the bridge could: the bridge asks it for its state.
  pi.events.on(ENGINE_MCP_REQUEST_EVENT, (data) => {
    const request = data as { action: string; reply: (state: unknown) => void }
    if (request.action === 'state') request.reply(engineState('connected'))
  })
  await pi.fire('session_start', { reason: 'startup' })
  assert.deepEqual(states(), ['connected'])
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connected'))
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('failed'))
  assert.deepEqual(states(), ['connected', 'failed'])
})

await check('bridge MCP: a slow action leaves its outcome to the published state', async () => {
  const pi = await started()
  pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connected'))
  pi.events.on(ENGINE_MCP_REQUEST_EVENT, (data) => {
    const request = data as { action: string; reply: (error?: string) => void }
    // Sign-out fails at once; a reconnect handshake outlasts the bridge's wait.
    if (request.action === 'logout') request.reply('Sign-out failed')
    else if (request.action === 'reconnect') {
      pi.events.emit(ENGINE_MCP_STATE_EVENT, engineState('connecting'))
    }
  })
  assert.deepEqual(await pi.call('vengeance-mcp', { action: 'logout', server: 'docs' }), {
    ok: false,
    error: 'Sign-out failed'
  })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const reconnect = pi.call('vengeance-mcp', { action: 'reconnect', server: 'docs' })
    mock.timers.tick(50_000)
    const reply = await reconnect
    assert.ok(reply.ok)
    const status = reply.data as { servers: Array<{ state: string }> }
    assert.equal(status.servers[0]?.state, 'connecting')
  } finally {
    mock.timers.reset()
  }
  // Without the built-in extension nothing would ever answer.
  const bare = await started()
  assert.deepEqual(await bare.call('vengeance-mcp', { action: 'reconnect', server: 'docs' }), {
    ok: false,
    error: 'The built-in MCP extension is not loaded'
  })
})
