import type { ModelInfo } from '@shared/api/settings'
import type { Model as EngineModel } from '@shared/engine-types'
import type { EngineManager } from '../../engine/manager'

/**
 * Model facts from the open engines (RPC `get_available_models`). An online engine may prefer its bundled model
 * data over the cached remote catalog the main process reads offline, so the catalog takes an open engine's facts
 * for the models it lists.
 */

/** An open engine that does not answer within this time is left out of the catalog. */
const ENGINE_MODELS_TIMEOUT_MS = 2_000

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`

async function availableModelsOf(manager: EngineManager, agentId: string): Promise<EngineModel[]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ENGINE_MODELS_TIMEOUT_MS)
  })
  try {
    const response = await Promise.race([
      manager.command(agentId, { type: 'get_available_models' }),
      timeout
    ])
    return response?.success && response.command === 'get_available_models'
      ? response.data.models
      : []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** The models the idle open engines offer, first engine first. */
export async function openEngineModels(manager: EngineManager): Promise<EngineModel[]> {
  const idle = manager
    .list()
    .filter((agent) => agent.engine === 'pi' && agent.status === 'ready' && !agent.busy)
  const lists = await Promise.all(idle.map((agent) => availableModelsOf(manager, agent.agentId)))
  return lists.flat()
}

/**
 * The catalog as running sessions see it: an engine's facts (prices, limits) win for the models it lists (the first
 * engine listing a model counts). `engineOnly` are the models no catalog source has: a session's own extensions
 * (such as project extensions of untrusted folders), or config the session has not reloaded yet.
 */
export function withEngineModels(
  models: ModelInfo[],
  engineModels: EngineModel[]
): { models: ModelInfo[]; engineOnly: EngineModel[] } {
  const live = new Map<string, EngineModel>()
  for (const model of engineModels) {
    if (!live.has(modelKey(model))) live.set(modelKey(model), model)
  }
  const merged = models.map((model) => {
    const engine = live.get(modelKey(model))
    live.delete(modelKey(model))
    if (!engine) return model
    const { name, api, reasoning, input, contextWindow, maxTokens, cost } = engine
    return { ...model, name, api, reasoning, input, contextWindow, maxTokens, cost }
  })
  return { models: merged, engineOnly: [...live.values()] }
}
