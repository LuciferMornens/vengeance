import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRIDGE_STATUS_PREFIX,
  type AgentInfo,
  type CreateAgentArgs,
  type EngineId
} from '@shared/api/engine'
import type { RpcCommand, RpcResponse } from '@shared/engine-types'
import { callBridge } from '../../src/main/engine/bridge'
import { Emitter, type EngineHandle, type EngineHandleEvents } from '../../src/main/engine/handle'
import { rereadsSignInsAtStart, signInRefreshTargets } from '../../src/main/engine/manager'
import { check } from './harness'

/** `ModelRegistry.refreshAvailability` (the staged Engine's `model-registry.d.ts`, from patch 0010). */
type RefreshAvailability = (options?: { signal?: AbortSignal }) => Promise<void>

/** The parts of a pi extension command context `/vengeance-sign-ins` may reach. */
interface CommandContext {
  ui: { setStatus(key: string, value: string | undefined): void }
  modelRegistry: { refresh(): Promise<never>; refreshAvailability: RefreshAvailability }
}
type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>

/** The parts of `ExtensionAPI` the bridge calls while it registers; no session event fires here. */
class FakePi {
  readonly commands = new Map<string, CommandHandler>()
  readonly events = { on: () => () => undefined, emit: () => undefined }
  on(): void {}
  registerCommand(name: string, options: { handler: CommandHandler }): void {
    this.commands.set(name, options.handler)
  }
}

/** The bridge's runtime imports of the Engine resolve to the running Engine; stand-ins here. */
async function loadBridge(): Promise<(pi: FakePi) => void> {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'vengeance-sign-ins-bridge-'))
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

/**
 * An Engine with the bridge loaded: a `prompt` of a registered command runs its handler before the
 * response, as pi does, and `setStatus` reaches main as an `extension_ui_request`.
 */
class BridgeEngine implements EngineHandle {
  readonly pid = 1
  readonly status = 'ready' as const
  readonly error = undefined
  /** The arguments of every availability re-read the bridge asked for, in order. */
  readonly passes: unknown[][] = []
  /** Full registry refreshes the bridge asked for, which would reload models.json. */
  reloads = 0
  private readonly emitter = new Emitter<EngineHandleEvents>()
  private readonly pi = new FakePi()
  private readonly ctx: CommandContext

  constructor(refreshAvailability: RefreshAvailability = async () => undefined) {
    vengeanceBridge(this.pi)
    this.ctx = {
      ui: {
        setStatus: (statusKey, statusText) =>
          this.emitter.emit('event', {
            type: 'extension_ui_request',
            id: statusKey,
            method: 'setStatus',
            statusKey,
            statusText
          })
      },
      modelRegistry: {
        refresh: async () => {
          this.reloads++
          throw new Error('unexpected models.json reload')
        },
        refreshAvailability: (...args) => {
          this.passes.push(args)
          return refreshAvailability(...args)
        }
      }
    }
  }

  async start(): Promise<void> {}
  async send(command: RpcCommand): Promise<RpcResponse> {
    if (command.type !== 'prompt') throw new Error(`unexpected ${command.type}`)
    const [, name = '', args = ''] = /^\/(\S+) (.*)$/s.exec(command.message) ?? []
    const handler = this.pi.commands.get(name)
    if (handler) await handler(args, this.ctx)
    const disposition = handler ? 'handled' : 'started'
    return { type: 'response', command: 'prompt', success: true, data: { disposition } }
  }
  respondUi(): void {}
  async stop(): Promise<void> {}
  stderr(): string {
    return ''
  }
  on<K extends keyof EngineHandleEvents>(
    event: K,
    listener: (payload: EngineHandleEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, listener)
  }

  /** The bridge's reply to `/vengeance-sign-ins` with a payload of the caller's choosing. */
  async reply(payload: Record<string, unknown>): Promise<unknown> {
    const statusKey = `${BRIDGE_STATUS_PREFIX}raw`
    let reply: string | undefined
    const off = this.on('event', (event) => {
      if (
        event.type === 'extension_ui_request' &&
        event.method === 'setStatus' &&
        event.statusKey === statusKey
      ) {
        reply = event.statusText
      }
    })
    try {
      const message = `/vengeance-sign-ins ${JSON.stringify({ reqId: 'raw', ...payload })}`
      await this.send({ type: 'prompt', message })
    } finally {
      off()
    }
    assert.ok(reply, 'the bridge replied')
    return JSON.parse(reply)
  }
}

await check(
  'refused sign-in bridge: main has an Engine re-read every sign-in once, without reloading models.json',
  async () => {
    const engine = new BridgeEngine()
    assert.equal(await callBridge(engine, { op: 'sign-ins' }, 1000), null)
    assert.deepEqual(engine.passes, [[]])
    assert.equal(engine.reloads, 0)
    const failing = new BridgeEngine(async () => {
      throw new Error('auth.json: Unexpected end of JSON input')
    })
    await assert.rejects(
      callBridge(failing, { op: 'sign-ins' }, 1000),
      /auth\.json: Unexpected end of JSON input/
    )
  }
)

await check(
  'refused sign-in bridge: the re-read takes nothing from the payload, so it covers every provider and its filter',
  async () => {
    // A re-read narrowed to some providers would rebuild the others' availability without their model filters
    // (GitHub Copilot's per-plan models).
    const engine = new BridgeEngine()
    assert.deepEqual(await engine.reply({ providers: ['openai'] }), { ok: true, data: null })
    assert.deepEqual(engine.passes, [[]])
    assert.equal(engine.reloads, 0)
  }
)

function agent(
  agentId: string,
  engine: EngineId,
  overrides: Partial<Omit<AgentInfo, 'agentId' | 'engine'>> = {}
): AgentInfo {
  return {
    agentId,
    engine,
    cwd: 'C:/work',
    status: 'ready',
    mock: true,
    busy: false,
    bridge: true,
    createdAt: 0,
    args: { cwd: 'C:/work' },
    ...overrides
  }
}

await check(
  'refused sign-in bridge: every ready Engine conversation with the bridge that reads the auth.json re-reads it',
  () => {
    const elsewhere = { PI_CODING_AGENT_DIR: 'D:/other-agent' }
    const targets = signInRefreshTargets(
      [
        agent('first', 'pi'),
        // A reply in progress does not hold it back: pi runs extension commands at once.
        agent('replying', 'pi', { busy: true }),
        agent('no-bridge', 'pi', { bridge: false }),
        agent('starting', 'pi', { status: 'starting' }),
        agent('crashed', 'pi', { status: 'crashed' }),
        agent('engine-2', 'prime'),
        // Its launch env names another agent dir: another auth.json, whose marks are its own.
        agent('other-dir', 'pi', { args: { cwd: 'C:/work', launch: { env: elsewhere } } })
      ],
      (args) => args.launch?.env?.PI_CODING_AGENT_DIR === undefined
    )
    assert.deepEqual(
      targets.map((info) => info.agentId),
      ['first', 'replying']
    )
  }
)

await check(
  'refused sign-in bridge: a conversation that starts on an auth.json with refused sign-ins re-reads them once ready',
  () => {
    const marked = { PI_CODING_AGENT_DIR: 'D:/marked-agent' }
    const refused = (args: CreateAgentArgs) =>
      args.launch?.env?.PI_CODING_AGENT_DIR === marked.PI_CODING_AGENT_DIR
    const started = (
      overrides: Partial<Omit<AgentInfo, 'agentId' | 'engine'>> = {},
      engine: EngineId = 'pi'
    ) =>
      agent('started', engine, { args: { cwd: 'C:/work', launch: { env: marked } }, ...overrides })
    assert.equal(rereadsSignInsAtStart(started(), refused), true)
    // Its own auth.json holds no mark: the Engine's first read is current.
    assert.equal(rereadsSignInsAtStart(agent('clean', 'pi'), refused), false)
    assert.equal(rereadsSignInsAtStart(started({ bridge: false }), refused), false)
    assert.equal(rereadsSignInsAtStart(started({ status: 'crashed' }), refused), false)
    assert.equal(rereadsSignInsAtStart(started({}, 'prime'), refused), false)
  }
)
