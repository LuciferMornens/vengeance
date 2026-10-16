import { create } from 'zustand'
import type { CreateAgentArgs } from '@shared/api/engine'
import { invoke } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { useApp, workspaceEngine } from '../../store/app'
import { toast } from '../../ui'
import { prepareLaunch, type PrepareLaunchOptions } from '../launch/spawn'

/** Number of engines being spawned (engine:create in flight); the center pane shows a spinner only then. */
export const useEngineSpawns = create<{ pending: number }>(() => ({ pending: 0 }))

export interface SpawnAgentOptions extends PrepareLaunchOptions {
  activationRevision?: number
}

/**
 * Spawn an engine for a session, tracked by `useEngineSpawns`. Every spawn path goes through here:
 * the workspace's launch defaults are merged in and project trust is resolved first (Trust dialog when
 * the folder is undecided), before the spinner shows.
 */
export async function spawnAgent(
  args: CreateAgentArgs,
  options: SpawnAgentOptions = {}
): Promise<string> {
  const activationRevision = options.activationRevision ?? useAgents.getState().requestActivation()
  const prepared = await prepareLaunch(
    { ...args, engine: args.engine ?? workspaceEngine(args.cwd) },
    options
  )
  useEngineSpawns.setState((s) => ({ pending: s.pending + 1 }))
  try {
    return await useAgents.getState().createAgent(prepared, activationRevision)
  } finally {
    useEngineSpawns.setState((s) => ({ pending: s.pending - 1 }))
  }
}

/** Start a new session (new engine process) in a workspace (default: the active one). */
export async function newSession(
  args: Partial<CreateAgentArgs> = {},
  options?: SpawnAgentOptions
): Promise<string | null> {
  const cwd = args.cwd ?? useApp.getState().prefs.activeWorkspace
  if (!cwd) {
    return chooseWorkspace(args)
  }
  try {
    return await spawnAgent({ ...args, cwd }, options)
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not start the engine',
      description: (error as Error).message
    })
    return null
  }
}

/** Make a folder the active workspace and open a session in it. */
export async function openWorkspace(
  path: string,
  args: Partial<CreateAgentArgs> = {}
): Promise<string | null> {
  useApp.getState().openWorkspace(path, args.engine)
  return newSession({ ...args, cwd: path })
}

/** Folder picker → openWorkspace. */
export async function chooseWorkspace(args: Partial<CreateAgentArgs> = {}): Promise<string | null> {
  const path = await invoke('sys:pick-folder', undefined)
  return path ? openWorkspace(path, args) : null
}
