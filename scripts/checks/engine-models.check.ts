import { strict as assert } from 'node:assert'
import type { AgentInfo } from '@shared/api/engine'
import type { ModelInfo } from '@shared/api/settings'
import type { Model, RpcCommand, RpcResponse } from '@shared/engine-types'
import type { EngineManager } from '../../src/main/engine/manager'
import { openEngineModels, withEngineModels } from '../../src/main/features/settings/engine-models'
import { check } from './harness'

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function catalogModel(provider: string, id: string, cacheRead: number): ModelInfo {
  return {
    provider,
    id,
    name: id,
    api: 'anthropic-messages',
    reasoning: true,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { ...ZERO_COST, cacheRead },
    available: true,
    thinkingLevels: ['off', 'high']
  }
}

function engineModel(provider: string, id: string, cacheRead: number): Model {
  return {
    provider,
    id,
    name: `${id} (engine)`,
    api: 'anthropic-messages',
    baseUrl: 'http://127.0.0.1',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { ...ZERO_COST, cacheRead }
  }
}

function agent(agentId: string, status: AgentInfo['status'], busy = false): AgentInfo {
  return {
    agentId,
    engine: 'pi',
    cwd: 'C:/work',
    status,
    busy,
    mock: true,
    bridge: false,
    createdAt: 0,
    args: { cwd: 'C:/work' }
  }
}

/** A manager whose engines answer get_available_models from `answers` (a missing answer never comes). */
function fakeManager(
  agents: AgentInfo[],
  answers: Record<string, Model[]>,
  asked: string[]
): EngineManager {
  const manager = {
    list: () => agents,
    command: (agentId: string, command: RpcCommand): Promise<RpcResponse> => {
      asked.push(agentId)
      const models = answers[agentId]
      if (!models || command.type !== 'get_available_models') return new Promise(() => undefined)
      return Promise.resolve({
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models }
      })
    }
  }
  // SAFETY: openEngineModels only calls list() and command().
  return manager as unknown as EngineManager
}

await check(
  'withEngineModels (auth-12): an open engine’s facts win for the models it lists',
  () => {
    const { models, engineOnly } = withEngineModels(
      [catalogModel('anthropic', 'sonnet', 0.1)],
      [engineModel('anthropic', 'sonnet', 0.2)]
    )
    assert.equal(models.length, 1)
    assert.equal(models[0]!.cost.cacheRead, 0.2)
    assert.equal(models[0]!.contextWindow, 1_000_000)
    assert.deepEqual(models[0]!.input, ['text', 'image'])
    assert.deepEqual(models[0]!.thinkingLevels, ['off', 'high'], 'catalog-only fields stay')
    assert.deepEqual(engineOnly, [])
  }
)

await check(
  'withEngineModels: models only an engine lists stay apart, once, with the first engine’s facts',
  () => {
    const { models, engineOnly } = withEngineModels(
      [catalogModel('anthropic', 'sonnet', 0.1)],
      [engineModel('session-ext', 'local', 1), engineModel('session-ext', 'local', 2)]
    )
    assert.deepEqual(
      models.map((model) => `${model.provider}/${model.id}`),
      ['anthropic/sonnet']
    )
    assert.deepEqual(
      engineOnly.map((model) => [`${model.provider}/${model.id}`, model.cost.cacheRead]),
      [['session-ext/local', 1]]
    )
  }
)

await check(
  'openEngineModels: only ready, idle engines are asked; a stuck engine is left out',
  async () => {
    const asked: string[] = []
    const manager = fakeManager(
      [
        agent('ready', 'ready'),
        agent('stuck', 'ready'),
        agent('busy', 'ready', true),
        agent('starting', 'starting')
      ],
      {
        ready: [engineModel('anthropic', 'sonnet', 0.2)],
        busy: [engineModel('anthropic', 'opus', 0.5)]
      },
      asked
    )
    const started = Date.now()
    const models = await openEngineModels(manager)
    assert.deepEqual(asked.sort(), ['ready', 'stuck'])
    assert.deepEqual(
      models.map((model) => model.id),
      ['sonnet']
    )
    assert.ok(Date.now() - started < 5_000, 'the stuck engine does not hold the catalog')
  }
)
