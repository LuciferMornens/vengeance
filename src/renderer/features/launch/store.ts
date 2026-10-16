import { create } from 'zustand'
import { DEFAULT_ENGINE_ID, type EngineId } from '@shared/api/engine'
import {
  engineLaunchWorkspaces,
  type ExtensionFlagsResult,
  type LaunchOptions,
  type TrustChoice,
  type TrustPreflight
} from '@shared/api/launch'
import { invoke, on } from '../../lib/ipc'
import { normalizePath, samePath } from '../../lib/paths'
import { useApp, workspaceEngine } from '../../store/app'

/**
 * Launch feature UI state: the Trust dialog queue, the launch-options dialog, per-workspace defaults
 * (AppPersistedState.features.launch) and the extension-flag discovery cache shown by the editor.
 */

/** `decide` = before an engine starts (4 answers); `manage` = re-open a workspace's saved decision. */
export type TrustDialogMode = 'decide' | 'manage'

/** `manage` answers: save a decision or forget the saved one. */
export type TrustManageChoice = 'trust-remember' | 'distrust-remember' | 'forget'

/** A `manage` answer, plus whether to restart the folder's open sessions with it. */
export interface TrustManageResult {
  choice: TrustManageChoice
  restartOpen: boolean
}

export interface TrustRequest {
  id: number
  engine: EngineId
  mode: TrustDialogMode
  preflight: TrustPreflight
  resolve(choice: TrustChoice | TrustManageChoice | null, restartOpen?: boolean): void
}

/** `workspace` edits the saved defaults; `session` starts one new session with these options. */
export type LaunchDialogMode = 'workspace' | 'session'

export interface LaunchDialogState {
  mode: LaunchDialogMode
  cwd: string
  engine: EngineId
}

export type FlagsState =
  | { status: 'loading' }
  | { status: 'ready'; result: ExtensionFlagsResult }
  | { status: 'error'; message: string }

interface LaunchStore {
  trustQueue: TrustRequest[]
  dialog: LaunchDialogState | null
  /** Extension flag discovery per engine and workspace path. */
  flags: Record<string, FlagsState>
}

export const useLaunch = create<LaunchStore>(() => ({ trustQueue: [], dialog: null, flags: {} }))

let requestCounter = 0

export function requestTrustChoice(
  preflight: TrustPreflight,
  mode: 'decide',
  engine?: EngineId
): Promise<TrustChoice | null>
export function requestTrustChoice(
  preflight: TrustPreflight,
  mode: 'manage',
  engine?: EngineId
): Promise<TrustManageResult | null>
export function requestTrustChoice(
  preflight: TrustPreflight,
  mode: TrustDialogMode,
  engine: EngineId = DEFAULT_ENGINE_ID
): Promise<TrustChoice | TrustManageResult | null> {
  return new Promise((resolve) => {
    const id = ++requestCounter
    const request: TrustRequest = {
      id,
      engine,
      mode,
      preflight,
      resolve: (choice, restartOpen = false) => {
        useLaunch.setState((s) => ({ trustQueue: s.trustQueue.filter((r) => r.id !== id) }))
        if (choice === null || mode === 'decide') resolve(choice as TrustChoice | null)
        else resolve({ choice: choice as TrustManageChoice, restartOpen })
      }
    }
    useLaunch.setState((s) => ({ trustQueue: [...s.trustQueue, request] }))
  })
}

export function openLaunchDialog(
  mode: LaunchDialogMode,
  cwd: string,
  engine = workspaceEngine(cwd)
): void {
  useLaunch.setState({ dialog: { mode, cwd, engine } })
}

export function closeLaunchDialog(): void {
  useLaunch.setState({ dialog: null })
}

export function launchFlagsKey(cwd: string, engine: EngineId): string {
  return `${engine}:${normalizePath(cwd)}`
}

/** Run (or reuse) extension flag discovery for one engine in a workspace. */
export async function loadExtensionFlags(
  cwd: string,
  engine = workspaceEngine(cwd),
  refresh = false
): Promise<void> {
  if (engine !== 'pi') return
  const key = launchFlagsKey(cwd, engine)
  const current = useLaunch.getState().flags[key]
  if (!refresh && current && current.status !== 'error') return
  const set = (state: FlagsState) =>
    useLaunch.setState((s) => ({ flags: { ...s.flags, [key]: state } }))
  set({ status: 'loading' })
  try {
    set({
      status: 'ready',
      result: await invoke('engine:extension-flags', engine, { cwd, refresh })
    })
  } catch (error) {
    set({ status: 'error', message: (error as Error).message })
  }
}

/** The saved key for a workspace path: the same folder may arrive with another case or separator style. */
function workspaceKey(workspaces: Record<string, LaunchOptions>, cwd: string): string | undefined {
  return Object.keys(workspaces).find((key) => samePath(key, cwd))
}

/**
 * Drop every cached flag discovery (flags come from installed packages, resources, settings and trust). An open
 * launch dialog asks again right away so it never sits on a skeleton.
 */
function forgetExtensionFlags(engine: EngineId): void {
  useLaunch.setState((state) => ({
    flags: Object.fromEntries(
      Object.entries(state.flags).filter(([key]) => !key.startsWith(`${engine}:`))
    )
  }))
  const open = useLaunch.getState().dialog
  if (open?.engine === engine) void loadExtensionFlags(open.cwd, engine)
}

on('settings:changed', ({ area, engine = DEFAULT_ENGINE_ID }) => {
  if (area === 'packages' || area === 'resources' || area === 'settings' || area === 'trust')
    forgetExtensionFlags(engine)
})
on('updates:applied', ({ engineId = DEFAULT_ENGINE_ID }) => forgetExtensionFlags(engineId))

export function getWorkspaceLaunchDefaults(
  cwd: string,
  engine = workspaceEngine(cwd)
): LaunchOptions | undefined {
  const workspaces = engineLaunchWorkspaces(useApp.getState().prefs.features.launch, engine)
  const key = workspaceKey(workspaces, cwd)
  return key === undefined ? undefined : workspaces[key]
}

export function setWorkspaceLaunchDefaults(
  cwd: string,
  options: LaunchOptions | undefined,
  engine = workspaceEngine(cwd)
): void {
  const prefs = useApp.getState().prefs.features.launch ?? {}
  const workspaces = { ...engineLaunchWorkspaces(prefs, engine) }
  const existing = workspaceKey(workspaces, cwd)
  if (existing !== undefined) delete workspaces[existing]
  if (options) workspaces[existing ?? cwd] = options
  const next =
    engine === 'pi'
      ? { ...prefs, workspaces }
      : { ...prefs, engineWorkspaces: { ...prefs.engineWorkspaces, [engine]: workspaces } }
  useApp.getState().updateFeaturePrefs('launch', next)
}
