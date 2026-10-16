import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { CreateAgentArgs, EngineId } from '@shared/api/engine'
import type { SessionListItem } from '@shared/api/sessions'
import type { RpcCommand, RpcSessionState } from '@shared/engine-types'
import type { AgentState } from '../../src/renderer/store/agent-state'
import { check } from './harness'

interface LoadingApi {
  useAgents: {
    getState(): {
      agents: Record<string, AgentState>
      activeAgentId: string | null
      createAgent(args: CreateAgentArgs): Promise<string>
    }
  }
  useSessions: {
    getState(): {
      lists: Record<string, { items: SessionListItem[] }>
      load(cwd: string | null, force?: boolean): Promise<void>
      reloadLoaded(): void
    }
  }
  useApp: { getState(): { openWorkspace(cwd: string): unknown } }
  flushAppPreferences(): Promise<void>
}

function deferred() {
  let release = () => undefined as void
  const promise = new Promise<void>((complete) => {
    release = complete
  })
  return { promise, release }
}

const WORKSPACE = 'C:\\projects\\loading'
const OVERSIZED_LIST_CHARACTERS = 9 * 1024 * 1024

function listedSession(name: string): SessionListItem {
  return {
    id: name,
    path: `${WORKSPACE}\\${name}.jsonl`,
    cwd: WORKSPACE,
    engine: 'pi',
    name,
    createdAt: 0,
    modifiedAt: 1,
    messageCount: 1,
    firstMessage: 'Open this conversation',
    searchText: name
  }
}

async function fixture() {
  const root = process.cwd()
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const bundled = await esbuild.build({
    stdin: {
      contents: `
        export { useAgents } from './src/renderer/store/agents';
        export { useSessions } from './src/renderer/features/sessions/store';
        export { useApp, flushAppPreferences } from './src/renderer/store/app';
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@shared': resolve(root, 'src', 'shared') }
  })
  let items = [listedSession('first')]
  let catalogGate: ReturnType<typeof deferred> | undefined
  let listGate: ReturnType<typeof deferred> | undefined
  let catalogFailure = false
  const lists: EngineId[] = []
  const module = { exports: {} }
  runInNewContext(bundled.outputFiles![0]!.text, {
    module,
    exports: module.exports,
    process: { env: { NODE_ENV: 'test' } },
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    cancelAnimationFrame: () => undefined,
    window: {
      vengeance: {
        platform: 'win32',
        async invoke(channel: string, ...args: unknown[]) {
          if (channel === 'app:set-state' || channel === 'engine:dispose') return
          if (channel === 'sessions:list') {
            const query = args[0] as { engine: EngineId }
            lists.push(query.engine)
            const snapshot = structuredClone(query.engine === 'pi' ? items : [])
            await listGate?.promise
            return { sessionDir: WORKSPACE, sessions: snapshot }
          }
          if (channel === 'engine:create') {
            const options = args[0] as CreateAgentArgs
            return {
              agentId: args[1],
              engine: options.engine ?? 'pi',
              cwd: options.cwd,
              args: options,
              status: 'ready',
              busy: false,
              createdAt: 0,
              mock: true,
              bridge: false
            }
          }
          assert.equal(channel, 'engine:command')
          const command = args[1] as RpcCommand
          const response = (data: unknown) => ({
            type: 'response',
            command: command.type,
            success: true,
            data
          })
          if (command.type === 'get_state') {
            const state: RpcSessionState = {
              sessionId: String(args[0]),
              sessionName: 'Loaded history',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'all',
              autoCompactionEnabled: true,
              messageCount: 1,
              pendingMessageCount: 0
            }
            return response(state)
          }
          if (command.type === 'get_messages') {
            return response({
              messages: [{ role: 'user', content: 'Saved conversation is readable', timestamp: 1 }]
            })
          }
          if (command.type === 'get_commands') {
            await catalogGate?.promise
            if (catalogFailure) throw new Error('Command catalog unavailable')
            return response({ commands: [] })
          }
          if (command.type === 'get_available_thinking_levels') return response({ levels: ['off'] })
          if (command.type === 'get_session_stats') return response({ sessionId: String(args[0]) })
          throw new Error(`Unexpected command ${command.type}`)
        }
      }
    }
  })
  const api = module.exports as LoadingApi
  api.useApp.getState().openWorkspace(WORKSPACE)
  return {
    api,
    lists,
    setItems(next: SessionListItem[]) {
      items = next
    },
    delayCatalog(fail = false) {
      catalogGate = deferred()
      catalogFailure = fail
      return catalogGate.release
    },
    delayLists() {
      listGate = deferred()
      return () => {
        listGate?.release()
        listGate = undefined
      }
    },
    async close() {
      catalogGate?.release()
      listGate?.release()
      await api.flushAppPreferences()
    }
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done))
}

await check('session loading: history appears before command discovery finishes', async () => {
  const test = await fixture()
  try {
    const release = test.delayCatalog()
    const opening = test.api.useAgents.getState().createAgent({ cwd: WORKSPACE })
    await settle()
    const state = test.api.useAgents.getState()
    const agent = state.agents[state.activeAgentId!]!
    assert.equal(agent.entries.length, 1, 'history must not wait for slow extension discovery')
    assert.equal(agent.sessionName, 'Loaded history')
    release()
    await opening
  } finally {
    await test.close()
  }
})

await check('session loading: a failed catalog leaves saved history available', async () => {
  const test = await fixture()
  try {
    const release = test.delayCatalog(true)
    const opening = test.api.useAgents.getState().createAgent({ cwd: WORKSPACE })
    const failure = assert.rejects(opening, /Command catalog unavailable/)
    await settle()
    release()
    await failure
    const state = test.api.useAgents.getState()
    assert.equal(state.agents[state.activeAgentId!]!.entries.length, 1)
  } finally {
    await test.close()
  }
})

await check(
  'session listings: fresh navigation skips IPC and unchanged refresh reuses rows',
  async () => {
    const test = await fixture()
    try {
      const sessions = test.api.useSessions
      await sessions.getState().load(WORKSPACE)
      const initial = Object.values(sessions.getState().lists)[0]!.items
      assert.equal(test.lists.length, 2)
      await sessions.getState().load(WORKSPACE)
      assert.equal(
        test.lists.length,
        2,
        'returning to a fresh workspace must not rescan both engines'
      )
      await sessions.getState().load(WORKSPACE, true)
      assert.equal(test.lists.length, 4)
      assert.equal(Object.values(sessions.getState().lists)[0]!.items, initial)

      test.setItems([listedSession('renamed')])
      sessions.getState().reloadLoaded()
      await sessions.getState().load(WORKSPACE)
      assert.equal(test.lists.length, 6, 'a mutation must bypass freshness')
      assert.equal(Object.values(sessions.getState().lists)[0]!.items[0]!.name, 'renamed')
    } finally {
      await test.close()
    }
  }
)

await check(
  'session listings: invalidation cannot recreate an evicted oversized list',
  async () => {
    const test = await fixture()
    try {
      const sessions = test.api.useSessions
      test.setItems([
        { ...listedSession('large'), searchText: 'x'.repeat(OVERSIZED_LIST_CHARACTERS) }
      ])
      const release = test.delayLists()
      const loading = sessions.getState().load(WORKSPACE)
      test.api.useApp.getState().openWorkspace('C:\\projects\\elsewhere')
      test.setItems([listedSession('small')])
      sessions.getState().reloadLoaded()
      release()
      await loading
      assert.equal(Object.keys(sessions.getState().lists).length, 0)
      test.api.useApp.getState().openWorkspace(WORKSPACE)
      await sessions.getState().load(WORKSPACE)
      assert.equal(Object.values(sessions.getState().lists)[0]!.items[0]!.name, 'small')
    } finally {
      await test.close()
    }
  }
)

await check('session listings: changes during a scan trigger a fresh follow-up', async () => {
  const test = await fixture()
  try {
    const sessions = test.api.useSessions
    const release = test.delayLists()
    const loading = sessions.getState().load(WORKSPACE)
    test.setItems([listedSession('new-arrival')])
    sessions.getState().reloadLoaded()
    release()
    await loading
    await sessions.getState().load(WORKSPACE)
    assert.equal(test.lists.length, 4)
    assert.equal(Object.values(sessions.getState().lists)[0]!.items[0]!.name, 'new-arrival')
  } finally {
    await test.close()
  }
})

await check(
  'session listings: an invalidated offscreen scan stays stale until revisited',
  async () => {
    const test = await fixture()
    try {
      const sessions = test.api.useSessions
      const release = test.delayLists()
      const loading = sessions.getState().load(WORKSPACE)
      test.api.useApp.getState().openWorkspace('C:\\projects\\elsewhere')
      test.setItems([listedSession('changed-offscreen')])
      sessions.getState().reloadLoaded()
      release()
      await loading
      assert.equal(test.lists.length, 2, 'offscreen invalidation must not start background scans')
      test.api.useApp.getState().openWorkspace(WORKSPACE)
      await sessions.getState().load(WORKSPACE)
      assert.equal(test.lists.length, 4, 'returning must not treat the stale result as fresh')
      assert.equal(Object.values(sessions.getState().lists)[0]!.items[0]!.name, 'changed-offscreen')
    } finally {
      await test.close()
    }
  }
)
