import { strict as assert } from 'node:assert'
import {
  BRIDGE_STATUS_PREFIX,
  hasBridgeCommands,
  isBridgeCommand,
  type BridgeToolsState,
  type BridgeTreeResult
} from '../../src/shared/api/engine'
import type {
  EngineEvent,
  RpcCommand,
  RpcResponse,
  RpcSlashCommand
} from '../../src/shared/engine-types'
import { bridgeLoadFailed, callBridge } from '../../src/main/engine/bridge'
import { Emitter, type EngineHandle, type EngineHandleEvents } from '../../src/main/engine/handle'
import { MockEngineProcess } from '../../src/main/engine/mock'
import { check } from './harness'

/** Engine double: answers `prompt` like pi does for an extension command, emitting `events` first. */
class FakeEngine implements EngineHandle {
  readonly pid = 1
  readonly status = 'ready' as const
  readonly error = undefined
  readonly sent: RpcCommand[] = []
  private readonly emitter = new Emitter<EngineHandleEvents>()
  constructor(
    private readonly answer: (message: string) => {
      events: EngineEvent[]
      disposition: 'handled' | 'started'
    }
  ) {}
  async start(): Promise<void> {}
  async send(command: RpcCommand): Promise<RpcResponse> {
    this.sent.push(command)
    if (command.type !== 'prompt') throw new Error('unexpected command')
    const { events, disposition } = this.answer(command.message)
    for (const event of events) this.emitter.emit('event', event)
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
}

function reqIdOf(message: string): string {
  return (JSON.parse(message.slice(message.indexOf(' ') + 1)) as { reqId: string }).reqId
}

function status(reqId: string, body: unknown): EngineEvent {
  return {
    type: 'extension_ui_request',
    id: 'x',
    method: 'setStatus',
    statusKey: `${BRIDGE_STATUS_PREFIX}${reqId}`,
    statusText: JSON.stringify(body)
  }
}

const bridgeCommand = (
  name: string,
  path = 'C:\\Vengeance\\resources\\bridge\\vengeance-bridge.ts'
): RpcSlashCommand => ({
  name,
  source: 'extension',
  sourceInfo: { path, source: 'cli', scope: 'temporary', origin: 'top-level' }
})

await check('hasBridgeCommands / isBridgeCommand: all commands from the bridge file', () => {
  const all = [
    'vengeance-tree',
    'vengeance-reload',
    'vengeance-tools',
    'vengeance-label',
    'vengeance-subagents',
    'vengeance-speed',
    'vengeance-system-prompt',
    'vengeance-mcp',
    'vengeance-sign-ins'
  ].map((n) => bridgeCommand(n))
  assert.equal(hasBridgeCommands(all), true)
  assert.equal(hasBridgeCommands(all.slice(1)), false)
  assert.equal(isBridgeCommand(all[0]!), true)
  assert.equal(isBridgeCommand(bridgeCommand('vengeance-tree', '/home/u/other.ts')), false)
  assert.equal(isBridgeCommand({ ...bridgeCommand('todos'), name: 'todos' }), false)
})

await check(
  "bridgeLoadFailed: recognizes pi's extension load diagnostic for the bridge only",
  () => {
    assert.equal(
      bridgeLoadFailed('Error: Failed to load extension "C:\\x\\vengeance-bridge.ts": boom'),
      true
    )
    assert.equal(bridgeLoadFailed('Error: Failed to load extension "C:\\x\\other.ts": boom'), false)
  }
)

await check(
  'callBridge: sends /<command> <json> and resolves with the setStatus reply',
  async () => {
    const engine = new FakeEngine((message) => ({
      events: [
        status(reqIdOf(message), {
          ok: true,
          data: { cancelled: false, leafId: 'p1', editorText: 'hi' }
        })
      ],
      disposition: 'handled'
    }))
    const result = await callBridge(
      engine,
      { op: 'tree', entryId: 'e1', summarize: true, label: 'L' },
      1000
    )
    assert.deepEqual(result, { cancelled: false, leafId: 'p1', editorText: 'hi' })
    const message = (engine.sent[0] as { message: string }).message
    assert.ok(message.startsWith('/vengeance-tree {'))
    assert.deepEqual(
      { ...JSON.parse(message.slice('/vengeance-tree '.length)), reqId: 'r' },
      { reqId: 'r', entryId: 'e1', summarize: true, label: 'L' }
    )
  }
)

await check('callBridge: error reply, extension_error and unhandled prompts reject', async () => {
  const replyError = new FakeEngine((message) => ({
    events: [status(reqIdOf(message), { ok: false, error: 'Entry e9 not found' })],
    disposition: 'handled'
  }))
  await assert.rejects(
    callBridge(replyError, { op: 'label', entryId: 'e9' }, 1000),
    /Entry e9 not found/
  )
  const thrown = new FakeEngine(() => ({
    events: [
      {
        type: 'extension_error',
        extensionPath: 'command:vengeance-tools',
        event: 'command',
        error: 'bad payload'
      }
    ],
    disposition: 'handled'
  }))
  await assert.rejects(callBridge(thrown, { op: 'tools-get' }, 1000), /bad payload/)
  const notLoaded = new FakeEngine(() => ({ events: [], disposition: 'started' }))
  await assert.rejects(callBridge(notLoaded, { op: 'reload' }, 1000), /bridge not loaded/)
  const otherKey = new FakeEngine(() => ({
    events: [status('someone-else', { ok: true, data: null })],
    disposition: 'handled'
  }))
  await assert.rejects(callBridge(otherKey, { op: 'reload' }, 1000), /did not answer/)
})

await check(
  'MockEngineProcess: bridge commands listed and tree/tools/label operate on the mock session',
  async () => {
    const mock = new MockEngineProcess({ cwd: 'C:\\Users\\dev\\projects\\aurora' })
    await mock.start()
    const commands = await mock.send({ type: 'get_commands' })
    assert.ok(
      commands.success &&
        commands.command === 'get_commands' &&
        hasBridgeCommands(commands.data.commands)
    )

    // One short run so the session has a user message + reply.
    const settled = new Promise<void>((resolve) =>
      mock.on('event', (e) => e.type === 'agent_settled' && resolve())
    )
    await mock.play({ script: 'short', prompt: 'hello', instant: true })
    await settled
    const entries = await mock.send({ type: 'get_entries' })
    assert.ok(entries.success && entries.command === 'get_entries')
    const user = entries.data.entries.find(
      (e) => e.type === 'message' && e.message.role === 'user'
    )!

    const tree = await callBridge(mock, { op: 'tree', entryId: user.id }, 1000)
    assert.deepEqual(tree satisfies BridgeTreeResult, {
      cancelled: false,
      leafId: user.parentId,
      editorText: 'hello'
    })
    const messages = await mock.send({ type: 'get_messages' })
    assert.ok(
      messages.success && messages.command === 'get_messages' && messages.data.messages.length === 0
    )
    const prompt = await callBridge(mock, { op: 'system-prompt' }, 1000)
    assert.ok(prompt.text.includes('careful coding assistant'))
    const afterPrompt = await mock.send({ type: 'get_messages' })
    assert.ok(afterPrompt.success && afterPrompt.command === 'get_messages')
    assert.equal(afterPrompt.data.messages.length, 0)

    const tools: BridgeToolsState = await callBridge(
      mock,
      { op: 'tools-set', names: ['read', 'nope'] },
      1000
    )
    assert.deepEqual(tools.active, ['read'])
    assert.ok(tools.tools.length > 5)

    await callBridge(mock, { op: 'label', entryId: user.id, label: 'start' }, 1000)
    const labelled = await mock.send({ type: 'get_tree' })
    assert.ok(labelled.success && labelled.command === 'get_tree')
    assert.equal(labelled.data.nodes.find((n) => n.entry.id === user.id)?.label, 'start')
    await mock.stop()
  }
)
