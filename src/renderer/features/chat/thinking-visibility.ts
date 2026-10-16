import { create } from 'zustand'
import type { EngineId } from '@shared/api/engine'
import { useAgents } from '../../store/agents'
import { toast } from '../../ui'
// The effective-settings module directly: the settings feature index is a lazily loaded chunk.
import { getEffectiveSetting, useEffectiveSetting } from '../settings/effective'
import { settingsInvoke } from '../settings/ipc'

/**
 * Thinking-block visibility is scoped to each engine. pi uses `hideThinkingBlock` (effective for the
 * session's folder), with Ctrl+T also persisting the choice to its global settings.
 * The in-memory override makes the toggle instant and holds while a project setting pins the value; it
 * lapses as soon as the setting it was based on changes (Settings, settings.json, or the write landing).
 */
const useOverride = create<Partial<Record<EngineId, { hidden: boolean; base: boolean }>>>(
  () => ({})
)

export function useThinkingHidden(cwd: string | undefined, engine: EngineId): boolean {
  const setting = useEffectiveSetting('hideThinkingBlock', cwd ?? null, engine) === true
  const override = useOverride((state) => state[engine])
  return override && override.base === setting ? override.hidden : setting
}

/** Ctrl+T changes thinking visibility for the active engine, persisting it when supported. */
export function toggleThinkingVisibility(): void {
  const { agents, activeAgentId } = useAgents.getState()
  const agent = activeAgentId ? agents[activeAgentId] : undefined
  const cwd = agent?.info.cwd ?? null
  const engine = agent?.info.engine ?? 'pi'
  const setting = getEffectiveSetting('hideThinkingBlock', cwd, engine) === true
  const override = useOverride.getState()[engine]
  const hidden = !(override && override.base === setting ? override.hidden : setting)
  useOverride.setState({ [engine]: { hidden, base: setting } })
  // Prime has no native thinking visibility setting; its override belongs to this app session.
  if (engine === 'prime') return
  void settingsInvoke(engine, 'settings:set', {
    scope: 'global',
    cwd,
    path: ['hideThinkingBlock'],
    value: hidden
  }).catch((error: Error) =>
    toast({
      level: 'error',
      title: 'Could not save the thinking setting',
      description: error.message
    })
  )
}
