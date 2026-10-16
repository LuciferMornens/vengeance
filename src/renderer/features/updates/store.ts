import { create } from 'zustand'
import type { RunUpdateArgs, UpdatesState } from '@shared/api/updates'
import type { EngineId } from '@shared/api/engine'
import { invoke, on } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast } from '../../ui'
import { refreshAgents, restartEngines } from '../settings/engines'
import { useRuns } from '../settings/process-log'

/** Renderer view of the main-side update checker (engine, packages, Vengeance itself). */

interface UpdatesStore {
  states: Partial<Record<EngineId, UpdatesState>>
  engine: EngineId
  setEngine(engine: EngineId): Promise<void>
  state: UpdatesState | null
  sheetOpen: boolean
  /** Run id of the update shown in the sheet's log. */
  logRunId: string | null
  load(): Promise<void>
  check(): Promise<void>
  run(args: RunUpdateArgs, label: string): Promise<void>
  /** Work offline: pauses background checks (main persists UpdatesPrefs.offline). */
  setOffline(offline: boolean): Promise<void>
  setSheetOpen(open: boolean): void
}

export const useUpdates = create<UpdatesStore>()((set, get) => ({
  states: {},
  engine: 'pi',
  async setEngine(engine) {
    if (get().engine === engine && get().state) return
    set({ engine, state: null, logRunId: null })
    await get().load()
  },
  state: null,
  sheetOpen: false,
  logRunId: null,

  async load() {
    const engine = get().engine
    const state = await invoke('updates:state', engine)
    receiveState(state)
  },

  async check() {
    try {
      const engine = get().engine
      const state = await invoke('updates:check', engine)
      receiveState(state)
    } catch (error) {
      toast({ level: 'error', title: 'Update check failed', description: (error as Error).message })
    }
  },

  async run(args, label) {
    try {
      const engine = args.engine ?? get().engine
      const runId = await invoke('updates:run', { ...args, engine })
      useRuns.getState().label(runId, label)
      if (get().engine === engine) set({ logRunId: runId })
    } catch (error) {
      toast({ level: 'error', title: `${label} failed`, description: (error as Error).message })
    }
  },

  async setOffline(offline) {
    // Main is the single writer of UpdatesPrefs.offline; mirror it into the local prefs without persisting them
    // again, so later renderer writes of `features.updates` carry the same value.
    await invoke('updates:set-offline', offline)
    await get().load()
    useApp.setState((s) => ({
      prefs: {
        ...s.prefs,
        features: {
          ...s.prefs.features,
          updates: { ...s.prefs.features.updates, offline: offline || undefined }
        }
      }
    }))
  },

  setSheetOpen(sheetOpen) {
    set({ sheetOpen })
  }
}))

function receiveState(state: UpdatesState): void {
  const engine = state.engineId ?? 'pi'
  useUpdates.setState((current) => ({
    states: { ...current.states, [engine]: state },
    ...(current.engine === engine ? { state } : {})
  }))
}

on('updates:state', receiveState)

// Engine or packages changed on disk: restart engines (idle now, busy ones once they settle).
on('updates:applied', ({ engineId = 'pi', engine, packages, automatic }) => {
  refreshAgents(engineId)
  if (useAgents.getState().order.length > 0) restartEngines(engineId)
  const what = engine && packages ? 'Engine and packages' : engine ? 'Engine' : 'Packages'
  toast({
    level: 'success',
    title: `${what} updated`,
    description: automatic
      ? 'Updated automatically. Sessions restart as they finish.'
      : 'Sessions restart as they finish.'
  })
})

// The engine was updated outside Vengeance (a terminal `update`, another app): open sessions still run the old one.
on('updates:engine-changed', ({ engineId = 'pi', from, to }) => {
  refreshAgents(engineId)
  const open = useAgents.getState().order.length > 0
  toast({
    level: 'info',
    title: 'Engine updated',
    description: from
      ? `${from} → ${to}. ${open ? 'Open sessions still run the previous version.' : 'New sessions use it.'}`
      : `Now on ${to}.`,
    duration: open ? 0 : undefined,
    action: open ? { label: 'Restart engines', onClick: () => restartEngines(engineId) } : undefined
  })
})
