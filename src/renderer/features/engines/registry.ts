import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  EngineCapabilities,
  EngineDescriptor,
  EngineId,
  EngineLocationInfo
} from '@shared/api/engine'
import type { RpcCommandType } from '@shared/engine-types'
import { invoke, on } from '../../lib/ipc'

interface EngineRegistry {
  descriptors: EngineDescriptor[]
  locations: Partial<Record<EngineId, EngineLocationInfo>>
  loading: boolean
  error: string | null
  load(force?: boolean): Promise<void>
}

let refreshAfterLoad = false

export const useEngineRegistry = create<EngineRegistry>()((set, get) => ({
  descriptors: [],
  locations: {},
  loading: false,
  error: null,
  async load(force = false) {
    if (get().loading) {
      if (force) refreshAfterLoad = true
      return
    }
    if (!force && get().descriptors.length > 0) return
    set({ loading: true, error: null })
    try {
      const descriptors = await invoke('engine:backends')
      set({ descriptors })
      const results = await Promise.allSettled(
        descriptors.map(async (descriptor) => ({
          engine: descriptor.id,
          location: await invoke('engine:describe', descriptor.id)
        }))
      )
      const locations: Partial<Record<EngineId, EngineLocationInfo>> = {}
      for (const result of results) {
        if (result.status === 'fulfilled') {
          locations[result.value.engine] = result.value.location
        }
      }
      if (!refreshAfterLoad) set({ locations })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ loading: false })
      if (refreshAfterLoad) {
        refreshAfterLoad = false
        await get().load(true)
      }
    }
  }
}))

on('updates:applied', ({ engine }) => {
  if (engine) void useEngineRegistry.getState().load(true)
})
on('updates:engine-changed', () => void useEngineRegistry.getState().load(true))

export function engineDescriptor(engine: EngineId): EngineDescriptor | undefined {
  return useEngineRegistry.getState().descriptors.find((descriptor) => descriptor.id === engine)
}

export function supportsEngineCommand(engine: EngineId, command: RpcCommandType): boolean {
  const descriptor = engineDescriptor(engine)
  return descriptor ? descriptor.capabilities.commands.includes(command) : engine === 'pi'
}

export function useEngineCapabilities(engine: EngineId): EngineCapabilities | undefined {
  const capabilities = useEngineRegistry(
    (state) => state.descriptors.find((descriptor) => descriptor.id === engine)?.capabilities
  )
  useEffect(() => {
    void useEngineRegistry.getState().load()
  }, [])
  return capabilities
}
