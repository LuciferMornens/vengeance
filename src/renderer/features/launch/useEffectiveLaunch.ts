import { useMemo } from 'react'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'
import type { LaunchOptions, PrimeLaunchOptions } from '@shared/api/launch'
import { useAgents } from '../../store/agents'
import { effectiveLaunchArgs, formatEngineArgs, normalizeLaunchOptions } from './options'

/** What an agent's engine process was started with (read-only; for the inspector and diagnostics). */
export interface EffectiveLaunch {
  engine: EngineId
  /** `--approve` / `--no-approve` / null when the engine resolved project trust itself. */
  trust: boolean | null
  /** Structured launch options after workspace defaults were merged. */
  options: LaunchOptions | undefined
  /** Engine CLI flags from trust + launch options (session/model flags excluded). */
  args: string[]
  /** Quoted CLI arguments or formatted native startup configuration. */
  display: string
  /** Names of extra environment variables (values are never exposed here). */
  envKeys: string[]
  /** Native startup overrides for the engine that uses a daemon configuration. */
  configuration: PrimeLaunchOptions | undefined
}

/**
 * Effective launch configuration of a running agent, from `AgentInfo.args` (what `engine:create` received,
 * kept across restarts). Returns null for unknown agents.
 */
export function useEffectiveLaunch(agentId: string | null | undefined): EffectiveLaunch | null {
  const info = useAgents((state) => (agentId ? state.agents[agentId]?.info : undefined))
  return useMemo(() => {
    if (!info) return null
    const args = info.args
    const engine = normalizeEngineId(info.engine)
    const options = normalizeLaunchOptions(args.launch, engine)
    const flags = effectiveLaunchArgs({ ...args, engine })
    return {
      engine,
      trust: engine === 'pi' ? (args.approve ?? null) : null,
      options,
      args: flags,
      display:
        engine === 'prime'
          ? JSON.stringify(options?.prime ?? {}, null, 2)
          : formatEngineArgs(flags),
      envKeys: Object.keys(options?.env ?? {}),
      configuration: options?.prime
    }
  }, [info])
}
