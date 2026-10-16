import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentInfo, EngineId } from '../../src/shared/api/engine'
import type { AgentMessage, SessionEntry } from '../../src/shared/engine-types'
import type { EngineManager } from '../../src/main/engine/manager'
import { createEngineHandoff } from '../../src/main/engine/mock-handoff'
import { MOCK_MODELS } from '../../src/main/engine/mock-data'
import { normalizeMessage } from '../../src/main/engine/prime/normalize'
import { guardPrimeHandoff, PrimeDaemonActivity } from '../../src/main/engine/prime/daemon-activity'
import { PrimeTransport } from '../../src/main/engine/prime/transport'
import {
  assertPrimeHandoffIdle,
  hasHandoffHistory,
  isHandoffMetadataEntry,
  type HandoffSnapshot
} from '../../src/main/engine/switch'
import { check } from './harness'

interface ManagerFixtureModule {
  EngineManager: typeof EngineManager
  failNextStart(): void
}

async function loadManager(): Promise<ManagerFixtureModule> {
  const root = process.cwd()
  const temporary = await mkdtemp(join(tmpdir(), 'vengeance-switch-module-'))
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const outfile = join(temporary, 'manager.mjs')
  try {
    await esbuild.build({
      stdin: {
        contents: [
          "export { EngineManager } from './src/main/engine/manager'",
          "export { failNextStart } from 'fixture:start-failure'"
        ].join('\n'),
        resolveDir: root,
        loader: 'ts'
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      tsconfig: join(root, 'tsconfig.node.json'),
      alias: { '@shared': resolve(root, 'src/shared') },
      plugins: [
        {
          name: 'isolated-electron',
          setup(bundler) {
            bundler.onResolve({ filter: /^fixture:start-failure$/ }, () => ({
              path: 'start-failure',
              namespace: 'fixture'
            }))
            bundler.onResolve({ filter: /^\.\/prime\/mock$/ }, () => ({
              path: 'prime-mock',
              namespace: 'fixture'
            }))
            bundler.onResolve({ filter: /^electron$/ }, () => ({
              path: 'electron',
              namespace: 'fixture'
            }))
            bundler.onLoad({ filter: /^start-failure$/, namespace: 'fixture' }, () => ({
              contents: `let armed = false
              export function failNextStart() {
                armed = true
              }
              export function takeFailure() {
                const fail = armed
                armed = false
                return fail
              }`,
              loader: 'js'
            }))
            bundler.onLoad({ filter: /^prime-mock$/, namespace: 'fixture' }, () => ({
              contents: `import { PrimeMockEngineProcess as NativeMock } from ${JSON.stringify(join(root, 'src/main/engine/prime/mock.ts'))}
              import { takeFailure } from 'fixture:start-failure'
              export class PrimeMockEngineProcess extends NativeMock {
                on(event, listener) {
                  const unsubscribe = super.on(event, listener)
                  if (event !== 'event') return unsubscribe
                  const startup = super.on('status', status => {
                    if (status === 'ready') listener({
                      type: 'extension_ui_request', id: 'startup-editor',
                      method: 'set_editor_text', text: 'Replace the carried draft'
                    })
                  })
                  return () => {
                    unsubscribe()
                    startup()
                  }
                }
                async start() {
                  if (takeFailure()) throw new Error('Fixture candidate startup failed')
                  await super.start()
                }
              }`,
              loader: 'js',
              resolveDir: root
            }))
            bundler.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
              contents: `export const app = {
              isPackaged: false,
              getAppPath: () => ${JSON.stringify(root)},
              getPath: () => ${JSON.stringify(temporary)}
            }
            export const safeStorage = { isEncryptionAvailable: () => false }
            export const shell = {}`,
              loader: 'js'
            }))
          }
        }
      ],
      logLevel: 'warning'
    })
    return (await import(pathToFileURL(outfile).href)) as ManagerFixtureModule
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const { EngineManager: Manager, failNextStart } = await loadManager()

const timestamp = '2026-10-16T12:00:00.000Z'
const historyMessage: AgentMessage = {
  role: 'user',
  content: 'Keep the complete history through an engine switch.',
  timestamp: Date.parse(timestamp)
}
const historyEntry: SessionEntry = {
  type: 'message',
  id: 'history-user',
  parentId: null,
  timestamp,
  message: historyMessage
}

await check('engine switch: native custom history keeps its ISO timestamp across snapshots', () => {
  const nativeMessage = {
    role: 'custom',
    customType: 'vengeance-engine-history',
    content: 'Historical entry imported from the other engine',
    display: true,
    timestamp
  }
  const normalized = normalizeMessage(nativeMessage)
  assert.equal(normalized.timestamp, Date.parse(timestamp))
  assert.deepEqual(normalizeMessage(nativeMessage), normalized)
})

await check(
  'engine switch: native summary blocks active children after the parent settles',
  async () => {
    await assert.rejects(
      assertPrimeHandoffIdle({
        nativeAgentId: 'source',
        async nativeCommand(type) {
          assert.equal(type, 'list')
          return {
            sessions: [
              {
                activeSessionId: 'source',
                isStreaming: false,
                isCompacting: false,
                isRunningTools: false,
                hasRunningSubagents: true
              }
            ]
          }
        }
      }),
      /child agents are idle/
    )
  }
)

class ActivityTransport extends PrimeTransport {
  override get connected(): boolean {
    return true
  }
}

await check(
  'engine switch: side-question guard blocks admitted and newly started questions',
  async () => {
    const transport = new ActivityTransport('engine-switch-side-question-fixture')
    const activity = new PrimeDaemonActivity(transport)
    const payload = { activeSessionId: 'source', sideQuestionId: 'question' }
    await activity.request('start_side_question', payload, async () => ({}))
    assert.throws(() => guardPrimeHandoff(transport.socketPath), /side questions/)
    transport.emit('event', {
      type: 'side_question_event',
      activeSessionId: 'source',
      event: { id: 'question', status: 'complete' }
    })
    const guard = guardPrimeHandoff(transport.socketPath)
    try {
      await assert.rejects(
        activity.request('start_side_question', payload, async () => ({})),
        /switching engines/
      )
      transport.emit('event', {
        type: 'side_question_event',
        activeSessionId: 'source',
        event: { id: 'external-question', status: 'running' }
      })
      assert.throws(() => guard.assertIdle(), /side questions/)
    } finally {
      transport.emit('close', { expected: true })
      guard.release()
    }
  }
)

await check('engine switch: only the selected branch decides whether history is empty', () => {
  const snapshot: HandoffSnapshot = {
    state: {
      sessionId: 'source',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0
    },
    entries: [historyEntry],
    messages: [],
    leafId: null
  }
  assert.equal(hasHandoffHistory(snapshot), false)
  snapshot.leafId = historyEntry.id
  assert.equal(hasHandoffHistory(snapshot), true)
  snapshot.entries = [
    {
      type: 'custom_message',
      id: 'custom',
      parentId: null,
      timestamp,
      customType: 'historical-note',
      content: 'Keep the standalone note',
      display: true
    }
  ]
  snapshot.leafId = 'custom'
  assert.equal(hasHandoffHistory(snapshot), true)
})

await check('engine switch: native metadata alone is an empty conversation', () => {
  const metadataTypes = [
    'model_change',
    'thinking_level_change',
    'service_tier_change',
    'session_info',
    'session_state',
    'label',
    'usage',
    'child_usage_attributed',
    'git_state',
    'custom',
    'context_edit',
    'future_metadata'
  ]
  const snapshot: HandoffSnapshot = {
    state: {
      sessionId: 'metadata-only',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0
    },
    entries: [],
    messages: [],
    leafId: null
  }
  for (const [index, type] of metadataTypes.entries()) {
    assert.equal(isHandoffMetadataEntry(type), true, type)
    // Unknown native metadata uses the same envelope as the modeled entry types.
    const entry = {
      type,
      id: `metadata-${index}`,
      parentId: snapshot.leafId,
      timestamp
    } as SessionEntry
    snapshot.entries.push(entry)
    snapshot.leafId = entry.id
    assert.equal(hasHandoffHistory(snapshot), false, type)
  }
  for (const type of ['message', 'custom_message', 'compaction', 'branch_summary']) {
    assert.equal(isHandoffMetadataEntry(type), false, type)
    // Only the native context-bearing kind matters to the history-presence guard.
    const entry = { type, id: 'conversation', parentId: snapshot.leafId, timestamp } as SessionEntry
    assert.equal(
      hasHandoffHistory({ ...snapshot, entries: [...snapshot.entries, entry], leafId: entry.id }),
      true,
      type
    )
  }
})

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'vengeance-switch-check-'))
  const files: string[] = []
  const statuses: AgentInfo[] = []
  const events: string[] = []
  const editorChanges: string[] = []
  let failLookup = false
  const manager = new Manager(
    {
      onEvent: (agentId, event) => {
        events.push(agentId)
        if (event.type === 'extension_ui_request' && event.method === 'set_editor_text') {
          editorChanges.push(event.text)
        }
      },
      onExit: ({ agentId }) => events.push(agentId),
      onStatus: (_agentId, _status, info) => statuses.push(info)
    },
    {
      mock: true,
      engineOverridePath: () => {
        if (failLookup) throw new Error('Fixture target lookup failed')
        return null
      },
      bridgeExtensionPath: () => null
    }
  )
  return {
    cwd,
    manager,
    statuses,
    events,
    editorChanges,
    failLookup: () => {
      failLookup = true
    },
    async openHistory(engine: EngineId = 'pi'): Promise<AgentInfo> {
      const generated = await createEngineHandoff(
        {
          sourceEngine: engine === 'pi' ? 'prime' : 'pi',
          targetEngine: engine,
          cwd,
          messages: [historyMessage],
          entries: [historyEntry],
          leafId: historyEntry.id
        },
        null
      )
      files.push(generated.path)
      const sourceModel = MOCK_MODELS[1]!
      return manager.create({
        engine,
        cwd,
        sessionPath: generated.path,
        name: 'History handoff',
        provider: sourceModel.provider,
        model: sourceModel.id,
        thinking: 'high'
      })
    },
    async close(): Promise<void> {
      for (const status of statuses) {
        if (status.sessionFile?.endsWith('.json')) files.push(status.sessionFile)
      }
      for (const agent of manager.list()) {
        if (agent.sessionFile?.endsWith('.json')) files.push(agent.sessionFile)
      }
      await manager.disposeAll()
      await Promise.all(files.map((file) => rm(file, { force: true })))
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

await check(
  'engine switch: keeps identity/history and publishes only the committed backend',
  async () => {
    const test = await fixture()
    try {
      const source = await test.openHistory()
      test.statuses.length = 0
      test.events.length = 0
      const target = await test.manager.switchEngine(source.agentId, {
        engine: 'prime',
        cwd: test.cwd
      })
      assert.equal(target.agentId, source.agentId)
      assert.equal(target.engine, 'prime')
      assert.equal(target.sessionName, source.sessionName)
      assert.equal(target.createdAt, source.createdAt)
      assert.notEqual(target.sessionFile, source.sessionFile)
      assert.equal(test.manager.list().length, 1)
      assert.deepEqual(
        test.statuses.map((info) => [info.agentId, info.engine, info.status]),
        [[source.agentId, 'prime', 'ready']]
      )
      assert.ok(test.events.length > 0)
      assert.ok(test.events.every((agentId) => agentId === source.agentId))
      assert.deepEqual(test.editorChanges, [], 'startup extensions must not replace the user draft')
      const messages = await test.manager.command(source.agentId, { type: 'get_messages' })
      assert.ok(messages.success && messages.command === 'get_messages')
      assert.deepEqual(messages.data.messages, [historyMessage])
      const state = await test.manager.command(source.agentId, { type: 'get_state' })
      assert.ok(state.success && state.command === 'get_state')
      assert.equal(state.data.model?.id, MOCK_MODELS[0]!.id)
      assert.equal(
        (JSON.parse(await readFile(source.sessionFile!, 'utf8')) as object) !== null,
        true
      )
      const returned = await test.manager.switchEngine(source.agentId, {
        engine: 'pi',
        cwd: test.cwd
      })
      assert.equal(returned.engine, 'pi')
      const entries = await test.manager.command(source.agentId, { type: 'get_entries' })
      assert.ok(entries.success && entries.command === 'get_entries')
      assert.deepEqual(entries.data.entries, [historyEntry])
    } finally {
      await test.close()
    }
  }
)

await check(
  'engine switch: failure leaves the source usable and restart stays backend pinned',
  async () => {
    const test = await fixture()
    try {
      const source = await test.openHistory()
      test.failLookup()
      await assert.rejects(
        test.manager.switchEngine(source.agentId, { engine: 'prime', cwd: test.cwd }),
        /Fixture target lookup failed/
      )
      assert.equal(test.manager.get(source.agentId)?.engine, 'pi')
      assert.equal(test.manager.list().length, 1)
      const state = await test.manager.command(source.agentId, { type: 'get_state' })
      assert.ok(state.success)
      await assert.rejects(
        test.manager.restart(source.agentId, { engine: 'prime' }),
        /different engine when creating a new session/
      )
    } finally {
      await test.close()
    }
  }
)

await check(
  'engine switch: guards concurrent calls, workspace changes, and close races',
  async () => {
    const test = await fixture()
    try {
      const source = await test.openHistory()
      const reading = test.manager.command(source.agentId, { type: 'get_messages' })
      await assert.rejects(
        test.manager.switchEngine(source.agentId, { engine: 'prime', cwd: test.cwd }),
        /current session operation/
      )
      await reading
      await assert.rejects(
        test.manager.switchEngine(source.agentId, {
          engine: 'prime',
          cwd: join(test.cwd, 'another-workspace')
        }),
        /current workspace/
      )
      const switching = test.manager.switchEngine(source.agentId, {
        engine: 'prime',
        cwd: test.cwd
      })
      await assert.rejects(
        test.manager.command(source.agentId, { type: 'new_session' }),
        /engine switch to finish/
      )
      await test.manager.dispose(source.agentId)
      await assert.rejects(switching)
      assert.deepEqual(test.manager.list(), [])
    } finally {
      await test.close()
    }
  }
)

await check('engine switch: candidate startup failure keeps the source usable', async () => {
  const test = await fixture()
  try {
    const source = await test.openHistory()
    failNextStart()
    const model = MOCK_MODELS[0]!
    await assert.rejects(
      test.manager.switchEngine(source.agentId, {
        engine: 'prime',
        cwd: test.cwd,
        provider: model.provider,
        model: model.id,
        thinking: 'medium'
      }),
      /Fixture candidate startup failed/
    )
    assert.equal(test.manager.list().length, 1)
    assert.equal(test.manager.get(source.agentId)?.engine, 'pi')
    const messages = await test.manager.command(source.agentId, { type: 'get_messages' })
    assert.ok(messages.success && messages.command === 'get_messages')
    assert.deepEqual(messages.data.messages, [historyMessage])
    assert.ok(await readFile(source.sessionFile!, 'utf8'))
  } finally {
    await test.close()
  }
})

await check('engine switch: empty temporary sessions stay temporary', async () => {
  const test = await fixture()
  try {
    const source = await test.manager.create({ engine: 'pi', cwd: test.cwd, noSession: true })
    const target = await test.manager.switchEngine(source.agentId, {
      engine: 'prime',
      cwd: test.cwd
    })
    assert.equal(target.args.noSession, true)
    assert.equal(target.sessionFile, undefined)
    await test.manager.mockPlay(source.agentId, {
      script: 'short',
      prompt: 'Keep this temporary conversation private',
      instant: true
    })
    await assert.rejects(
      test.manager.switchEngine(source.agentId, { engine: 'pi', cwd: test.cwd }),
      /Temporary sessions with messages/
    )
    assert.equal(test.manager.get(source.agentId)?.engine, 'prime')
  } finally {
    await test.close()
  }
})
