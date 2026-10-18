import { create } from 'zustand'
import type { CreateAgentArgs, EngineId } from '@shared/api/engine'
import { invoke } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { useApp, workspaceEngine } from '../../store/app'
import { toast } from '../../ui'
import { prepareLaunch, type PrepareLaunchOptions } from '../launch/spawn'

interface SessionOpenings {
  activations: Record<number, number>
  focusIntent: {
    revision: number
    owner: Element | null
    started: boolean
    target: { engine: EngineId; path: string } | null
  } | null
}

export const useSessionOpenings = create<SessionOpenings>(() => ({
  activations: {},
  focusIntent: null
}))

export function requestSessionActivation(): number {
  const owner = document.activeElement
  const revision = useAgents.getState().requestActivation()
  useSessionOpenings.setState({ focusIntent: { revision, owner, started: false, target: null } })
  return revision
}

export function releaseSessionFocus(revision: number): void {
  if (useSessionOpenings.getState().focusIntent?.revision === revision) {
    useSessionOpenings.setState({ focusIntent: null })
  }
}

export function setSessionOpeningTarget(revision: number, engine: EngineId, path: string): void {
  if (useAgents.getState().activationRevision !== revision) return
  useSessionOpenings.setState((state) => ({
    focusIntent:
      state.focusIntent?.revision === revision
        ? { ...state.focusIntent, started: true, target: { engine, path } }
        : state.focusIntent
  }))
}

/** Nested opens share an activation; older completions cannot clear the latest request's feedback. */
export async function withSessionOpening<T>(
  activationRevision: number,
  open: () => Promise<T>
): Promise<T> {
  useSessionOpenings.setState((state) => ({
    focusIntent:
      useAgents.getState().activationRevision !== activationRevision
        ? state.focusIntent
        : {
            revision: activationRevision,
            owner:
              state.focusIntent?.revision === activationRevision
                ? state.focusIntent.owner
                : document.activeElement,
            started: true,
            target:
              state.focusIntent?.revision === activationRevision ? state.focusIntent.target : null
          },
    activations: {
      ...state.activations,
      [activationRevision]: (state.activations[activationRevision] ?? 0) + 1
    }
  }))
  try {
    return await open()
  } finally {
    useSessionOpenings.setState((state) => {
      const activations = { ...state.activations }
      const remaining = activations[activationRevision]! - 1
      if (remaining > 0) activations[activationRevision] = remaining
      else delete activations[activationRevision]
      const superseded = useAgents.getState().activationRevision !== activationRevision
      const releaseFocus =
        remaining === 0 && superseded && state.focusIntent?.revision === activationRevision
      return { activations, focusIntent: releaseFocus ? null : state.focusIntent }
    })
  }
}

export interface SpawnAgentOptions extends PrepareLaunchOptions {
  activationRevision?: number
}

/**
 * Spawn an engine for a session, tracked by `useSessionOpenings`. Every spawn path goes through here:
 * the workspace's launch defaults are merged in and project trust is resolved (Trust dialog when
 * the folder is undecided) while the current foreground request shows its opening state.
 */
export async function spawnAgent(
  args: CreateAgentArgs,
  options: SpawnAgentOptions = {}
): Promise<string> {
  const activationRevision = options.activationRevision ?? requestSessionActivation()
  return withSessionOpening(activationRevision, async () => {
    const prepared = await prepareLaunch(
      { ...args, engine: args.engine ?? workspaceEngine(args.cwd) },
      options
    )
    if (prepared.engine && prepared.sessionPath) {
      setSessionOpeningTarget(activationRevision, prepared.engine, prepared.sessionPath)
    }
    return useAgents.getState().createAgent(prepared, activationRevision)
  })
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
