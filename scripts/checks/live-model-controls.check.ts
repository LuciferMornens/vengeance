import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { AgentInfo, CreateAgentArgs } from '@shared/api/engine'
import type {
  EngineEvent,
  Model,
  RpcCommand,
  RpcSessionState,
  ThinkingLevel
} from '@shared/engine-types'
import type { AgentState } from '../../src/renderer/store/agent-state'
import { check } from './harness'

interface StoreModule {
  useAgents: {
    subscribe(listener: (state: { agents: Record<string, AgentState> }) => void): () => void
    getState(): {
      agents: Record<string, AgentState>
      createAgent(args: CreateAgentArgs): Promise<string>
      disposeAgent(agentId: string): Promise<void>
      restartAgent(agentId: string): Promise<void>
      prompt(agentId: string, text: string): Promise<void>
      setModel(
        agentId: string,
        provider: string,
        modelId: string,
        thinking?: ThinkingLevel
      ): Promise<void>
      setThinkingLevel(agentId: string, level: ThinkingLevel): Promise<void>
      refreshCapabilities(agentId: string): Promise<void>
      refresh(agentId: string): Promise<void>
      applyEvents(events: Map<string, EngineEvent[]>): void
    }
  }
  startAgentEventPump(): void
}

function model(modelId: string): Model {
  return {
    id: modelId,
    name: modelId,
    provider: 'local',
    api: 'openai-responses',
    baseUrl: 'http://localhost',
    reasoning: modelId !== 'plain',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000
  }
}

function deferred() {
  let release = () => undefined as void
  const promise = new Promise<void>((complete) => {
    release = complete
  })
  return { promise, release }
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done))
}

function waitForAgent(
  store: StoreModule['useAgents'],
  agentId: string,
  predicate: (agent: AgentState) => boolean,
  message: string
): Promise<void> {
  const READINESS_TIMEOUT_MS = 2000
  return new Promise((complete, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(message))
    }, READINESS_TIMEOUT_MS)
    const unsubscribe = store.subscribe((state) => {
      const agent = state.agents[agentId]
      if (!agent || !predicate(agent)) return
      clearTimeout(timeout)
      unsubscribe()
      complete()
    })
  })
}

async function fixture() {
  const root = process.cwd()
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const bundle = await esbuild.build({
    entryPoints: [join(root, 'src', 'renderer', 'store', 'agents.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@shared': resolve(root, 'src', 'shared') }
  })
  const listeners = new Map<string, (event: unknown) => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const infos = new Map<string, AgentInfo>()
  const states = new Map<string, RpcSessionState>()
  const mutations: string[] = []
  const prompts: string[] = []
  let blockMutation: ReturnType<typeof deferred> | undefined
  let blockState: ReturnType<typeof deferred> | undefined
  let refuseRestart = false
  let failMutation = false
  let refusedRead: RpcCommand['type'] | undefined
  const levels = (state: RpcSessionState): ThinkingLevel[] =>
    state.model?.reasoning ? ['off', 'low', 'high'] : ['off']
  const emit = (agentId: string, event: EngineEvent) =>
    listeners.get('engine:event')?.({ agentId, event })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles![0]!.text, {
    module,
    exports: module.exports,
    process: { env: { NODE_ENV: 'test' } },
    crypto: { randomUUID },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setTimeout(callback: () => void, delay: number) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        callback()
      }, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout,
    window: {
      vengeance: {
        platform: 'win32',
        on(channel: string, listener: (event: unknown) => void) {
          listeners.set(channel, listener)
          return () => listeners.delete(channel)
        },
        async invoke(channel: string, ...args: unknown[]) {
          if (channel === 'engine:create') {
            const options = args[0] as CreateAgentArgs
            const agentId = args[1] as string
            const info: AgentInfo = {
              agentId,
              engine: options.engine ?? 'pi',
              cwd: options.cwd,
              args: options,
              status: 'ready',
              busy: false,
              createdAt: 0,
              mock: true,
              bridge: false
            }
            infos.set(agentId, info)
            states.set(agentId, {
              model: model('reasoning'),
              thinkingLevel: 'low',
              sessionId: agentId,
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'all',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0
            })
            return info
          }
          if (channel === 'engine:list') return [...infos.values()]
          const agentId = args[0] as string
          if (channel === 'engine:dispose') {
            infos.delete(agentId)
            states.delete(agentId)
            return
          }
          if (channel === 'engine:restart') {
            if (refuseRestart) throw new Error('Another resident is still busy')
            const info = infos.get(agentId)!
            listeners.get('engine:status')?.({ agentId, info: { ...info, status: 'starting' } })
            listeners.get('engine:status')?.({ agentId, info })
            return info
          }
          assert.equal(channel, 'engine:command')
          const command = args[1] as RpcCommand
          const state = states.get(agentId)!
          const response = (data?: unknown) => ({
            type: 'response',
            success: true,
            command: command.type,
            data
          })
          if (command.type === refusedRead) {
            refusedRead = undefined
            return {
              type: 'response',
              command: command.type,
              success: false,
              error: 'Read refused'
            }
          }
          if (command.type === 'get_state') {
            const snapshot = { ...state }
            const gate = blockState
            blockState = undefined
            await gate?.promise
            return response(snapshot)
          }
          if (command.type === 'get_available_thinking_levels')
            return response({ levels: levels(state) })
          if (command.type === 'get_commands') return response({ commands: [] })
          if (command.type === 'get_messages') return response({ messages: [] })
          if (command.type === 'get_session_stats') return response({ sessionId: agentId })
          if (command.type === 'prompt') {
            prompts.push(state.model!.id)
            return response({ disposition: 'started' })
          }
          assert.ok(command.type === 'set_model' || command.type === 'set_thinking_level')
          mutations.push(command.type === 'set_model' ? command.modelId : command.level)
          const gate = blockMutation
          blockMutation = undefined
          await gate?.promise
          if (failMutation) {
            failMutation = false
            return {
              type: 'response',
              command: command.type,
              success: false,
              error: 'Native refusal'
            }
          }
          if (command.type === 'set_model') {
            state.model = model(command.modelId)
            if (!state.model.reasoning) state.thinkingLevel = 'off'
            // Extensions can replace the requested model before the command replies.
            return response(model('stale-command-result'))
          }
          state.thinkingLevel = levels(state).includes(command.level) ? command.level : 'off'
          return response()
        }
      }
    }
  })
  const api = module.exports as StoreModule
  api.startAgentEventPump()
  return {
    store: api.useAgents,
    states,
    mutations,
    prompts,
    emit,
    reportStatus(agentId: string, status: AgentInfo['status']) {
      const info = infos.get(agentId)!
      listeners.get('engine:status')?.({ agentId, info: { ...info, status } })
    },
    delayMutation() {
      blockMutation = deferred()
      return blockMutation
    },
    delayState() {
      blockState = deferred()
      return blockState
    },
    refuseRestart() {
      refuseRestart = true
    },
    failMutation() {
      failMutation = true
    },
    failRead(command: 'get_state' | 'get_commands') {
      refusedRead = command
    },
    async close() {
      for (const agentId of [...infos.keys()]) await api.useAgents.getState().disposeAgent(agentId)
      for (const timer of timers) clearTimeout(timer)
    }
  }
}

await check(
  'live selections serialize rapid changes and reject stale capability reads',
  async () => {
    const test = await fixture()
    try {
      const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
      const delayedState = test.delayState()
      const refresh = test.store.getState().refreshCapabilities(agentId)
      const delayedChange = test.delayMutation()
      const first = test.store.getState().setModel(agentId, 'local', 'plain')
      const second = test.store.getState().setThinkingLevel(agentId, 'high')
      assert.equal(test.store.getState().agents[agentId]!.modelChangePending, true)
      await settle()
      assert.deepEqual(test.mutations, ['plain'])
      delayedChange.release()
      await Promise.all([first, second])
      delayedState.release()
      await refresh
      const agent = test.store.getState().agents[agentId]!
      assert.deepEqual(test.mutations, ['plain', 'high'])
      assert.equal(agent.model?.id, 'plain')
      assert.equal(agent.thinkingLevel, 'off', 'display the native clamp, not requested effort')
      assert.equal(agent.session?.model?.id, 'plain')
      assert.deepEqual([...agent.thinkingLevels], ['off'])
      assert.equal(agent.modelChangePending, false)
      test.failMutation()
      await assert.rejects(test.store.getState().setThinkingLevel(agentId, 'low'), /Native refusal/)
      await test.store.getState().setModel(agentId, 'local', 'reasoning', 'high')
      assert.equal(test.store.getState().agents[agentId]!.thinkingLevel, 'high')
    } finally {
      await test.close()
    }
  }
)

await check(
  'session replacement cancels queued model changes and their thinking suffix',
  async () => {
    const test = await fixture()
    try {
      const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
      const delayedChange = test.delayMutation()
      const changing = test.store.getState().setModel(agentId, 'local', 'reasoning', 'high')
      const queued = test.store.getState().setThinkingLevel(agentId, 'low')
      const rejected = Promise.all([
        assert.rejects(changing, /session changed/),
        assert.rejects(queued, /session changed/)
      ])
      await settle()
      const state = {
        ...test.states.get(agentId)!,
        sessionId: 'replacement',
        model: model('plain')
      }
      test.states.set(agentId, state)
      test.emit(agentId, {
        type: 'engine_native_event',
        engine: 'prime',
        name: 'session_snapshot',
        data: { state, messages: [], steering: [], followUp: [] }
      })
      delayedChange.release()
      await rejected
      assert.deepEqual(test.mutations, ['reasoning'])
      assert.equal(test.store.getState().agents[agentId]!.model?.id, 'plain')
      assert.equal(test.store.getState().agents[agentId]!.modelChangePending, false)
    } finally {
      await test.close()
    }
  }
)

await check('a prompt waits for the selected model without blocking other sessions', async () => {
  const test = await fixture()
  try {
    const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
    const otherId = await test.store.getState().createAgent({ cwd: 'other', engine: 'pi' })
    const delayedChange = test.delayMutation()
    const changing = test.store.getState().setModel(agentId, 'local', 'plain')
    const prompt = test.store.getState().prompt(agentId, 'Use my selection')
    await settle()
    assert.deepEqual(test.prompts, [])
    await test.store.getState().prompt(otherId, 'Independent session')
    assert.deepEqual(test.prompts, ['reasoning'])
    delayedChange.release()
    await Promise.all([changing, prompt])
    assert.deepEqual(test.prompts, ['reasoning', 'plain'])
  } finally {
    await test.close()
  }
})

await check(
  'settled model refreshes cannot cancel a restarted native command catalog',
  async () => {
    const test = await fixture()
    try {
      const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
      test.reportStatus(agentId, 'starting')
      test.reportStatus(agentId, 'ready')
      const snapshot = waitForAgent(
        test.store,
        agentId,
        (agent) => agent.snapshotRevision > 0,
        'The native attachment snapshot did not reach the renderer'
      )
      test.emit(agentId, {
        type: 'engine_native_event',
        engine: 'prime',
        name: 'session_snapshot',
        data: { state: test.states.get(agentId), messages: [], steering: [], followUp: [] }
      })
      await snapshot
      const catalog = waitForAgent(
        test.store,
        agentId,
        (agent) => agent.commandsStatus === 'ready',
        'The settled-model refresh canceled the restarted native command catalog'
      )
      test.emit(agentId, { type: 'agent_settled', aborted: false })
      await catalog
      assert.equal(test.store.getState().agents[agentId]!.historyLoaded, true)
    } finally {
      await test.close()
    }
  }
)

await check(
  'refresh failures keep only the current generation’s authoritative command catalog',
  async () => {
    const test = await fixture()
    try {
      const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
      const catalog = test.store.getState().agents[agentId]!.commands
      for (const refresh of ['refreshCapabilities', 'refresh'] as const) {
        for (const command of ['get_state', 'get_commands'] as const) {
          test.failRead(command)
          await assert.rejects(test.store.getState()[refresh](agentId), /Read refused/)
          const agent = test.store.getState().agents[agentId]!
          assert.equal(agent.commandsStatus, 'ready')
          assert.equal(agent.commands, catalog)
        }
      }
      test.reportStatus(agentId, 'starting')
      test.reportStatus(agentId, 'ready')
      test.failRead('get_commands')
      await assert.rejects(test.store.getState().refreshCapabilities(agentId), /Read refused/)
      assert.equal(test.store.getState().agents[agentId]!.commandsStatus, 'error')
    } finally {
      await test.close()
    }
  }
)

await check('refused restart preserves the running session and rejects to its caller', async () => {
  const test = await fixture()
  try {
    const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'prime' })
    test.store.getState().applyEvents(
      new Map([
        [
          agentId,
          [
            { type: 'agent_start' },
            { type: 'queue_update', steering: ['keep queued'], followUp: [] },
            {
              type: 'extension_ui_request',
              id: 'dialog',
              method: 'confirm',
              title: 'Continue?',
              message: 'Ready'
            }
          ]
        ]
      ])
    )
    const before = test.store.getState().agents[agentId]!
    test.refuseRestart()
    await assert.rejects(test.store.getState().restartAgent(agentId), /resident is still busy/)
    const after = test.store.getState().agents[agentId]!
    assert.equal(after.phase, 'running')
    assert.equal(after.status, 'ready')
    assert.equal(after.engineGeneration, before.engineGeneration)
    assert.equal(after.queue, before.queue)
    assert.equal(after.ext, before.ext)
    assert.equal(after.error, undefined)
  } finally {
    await test.close()
  }
})

await check(
  'settled turns refresh model-dependent thinking levels without replacing history',
  async () => {
    const test = await fixture()
    try {
      const agentId = await test.store.getState().createAgent({ cwd: 'project', engine: 'pi' })
      const native = test.states.get(agentId)!
      native.model = model('plain')
      native.thinkingLevel = 'off'
      const before = test.store.getState().agents[agentId]!.entries
      const updated = new Promise<void>((complete, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe()
          reject(new Error('Settled state did not refresh'))
        }, 2_000)
        const unsubscribe = test.store.subscribe((state) => {
          if (state.agents[agentId]!.thinkingLevel === 'off') {
            clearTimeout(timeout)
            unsubscribe()
            complete()
          }
        })
      })
      test.emit(agentId, { type: 'agent_settled', aborted: false })
      await updated
      const agent = test.store.getState().agents[agentId]!
      assert.equal(agent.model?.id, 'plain')
      assert.deepEqual([...agent.thinkingLevels], ['off'])
      assert.equal(agent.entries, before)
    } finally {
      await test.close()
    }
  }
)
