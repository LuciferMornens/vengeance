import type { AppPersistedState } from '@shared/api/app'
import {
  normalizeEngineId,
  type AgentInfo,
  type CreateAgentArgs,
  type EngineId
} from '@shared/api/engine'
import { engineLaunchWorkspaces, type LaunchOptions, type LaunchPrefs } from '@shared/api/launch'
import { samePath } from '../../paths'
import { isMasked, maskSecret } from '../settings/secrets'

/**
 * N17: engine environment values (`LaunchOptions.env`) never sit in clear text on disk and never reach the
 * renderer unless the user reveals one.
 * - At rest: `app-state.json` stores every workspace-default env value sealed with Electron safeStorage
 *   (DPAPI on Windows; the cipher lives in app-state.ts) as `vengeance-sealed:v1:<base64>`. Plain values from older versions are sealed on
 *   the next write. When the OS offers no encryption, values stay plain (nothing better is available).
 * - In memory (main only): plain values. A sealed value that cannot be opened (another Windows account or
 *   machine) stays sealed, is kept on the next write, and is left out of engine environments.
 * - To the renderer: every non-empty value is masked (`••••` + last 4 characters for long values). Masks
 *   that come back unchanged (`app:set-state`, `engine:create`, `engine:restart`) resolve to the stored
 *   value of the same variable; `launch:reveal-env` returns one value on explicit request.
 */

type EnvMap = Record<string, string>

export interface EnvCipher {
  /** Encrypted text, or null when the platform cannot encrypt. */
  encrypt(plain: string): string | null
  /** Throws when the value cannot be decrypted. */
  decrypt(sealed: string): string
}

const SEALED_PREFIX = 'vengeance-sealed:v1:'

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

function mapValues(env: EnvMap, map: (value: string) => string): EnvMap {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, map(value)]))
}

/** Apply `map` to the env of every saved workspace default (same object back when there are none). */
function mapWorkspaceEnvs(
  prefs: AppPersistedState,
  map: (env: EnvMap) => EnvMap
): AppPersistedState {
  const launch = prefs.features.launch
  if (!launch) return prefs
  const mapWorkspaces = (
    workspaces: Record<string, LaunchOptions>
  ): Record<string, LaunchOptions> =>
    Object.fromEntries(
      Object.entries(workspaces).map(([path, options]) => [
        path,
        options.env ? { ...options, env: map(options.env) } : options
      ])
    )
  const engineWorkspaces = Object.fromEntries(
    Object.entries(launch.engineWorkspaces ?? {}).map(([engine, workspaces]) => [
      engine,
      mapWorkspaces(workspaces)
    ])
  )
  return {
    ...prefs,
    features: {
      ...prefs.features,
      launch: {
        ...launch,
        workspaces: launch.workspaces ? mapWorkspaces(launch.workspaces) : undefined,
        engineWorkspaces
      }
    }
  }
}

function* workspaceEnvs(launch: LaunchPrefs | undefined, engine: EngineId): Generator<EnvMap> {
  for (const options of Object.values(engineLaunchWorkspaces(launch, engine))) {
    if (options.env) yield options.env
  }
}

/** Persisted form: every plain value sealed (already sealed values are kept as they are). */
export function sealPrefs(prefs: AppPersistedState, cipher: EnvCipher): AppPersistedState {
  return mapWorkspaceEnvs(prefs, (env) =>
    mapValues(env, (value) => {
      if (isSealed(value)) return value
      const sealed = cipher.encrypt(value)
      return sealed === null ? value : `${SEALED_PREFIX}${sealed}`
    })
  )
}

/** In-memory form from disk; `migrate` is true when plain values were found (seal them by writing soon). */
export function openPrefs(
  prefs: AppPersistedState,
  cipher: EnvCipher
): { prefs: AppPersistedState; migrate: boolean } {
  let migrate = false
  const opened = mapWorkspaceEnvs(prefs, (env) =>
    mapValues(env, (value) => {
      if (!isSealed(value)) {
        migrate = true
        return value
      }
      try {
        return cipher.decrypt(value.slice(SEALED_PREFIX.length))
      } catch {
        return value
      }
    })
  )
  return { prefs: opened, migrate }
}

function maskValue(value: string): string {
  return value === '' ? '' : maskSecret(value)
}

function maskEnv(env: EnvMap): EnvMap {
  return mapValues(env, maskValue)
}

/** Renderer form of the prefs: workspace env values masked. */
export function maskPrefs(prefs: AppPersistedState): AppPersistedState {
  return mapWorkspaceEnvs(prefs, maskEnv)
}

/**
 * Swap masks that came back unchanged for the stored value of the same variable, looked up in
 * `candidates` in order. Unresolvable masks stay literal (the user typed over a mask).
 */
export function resolveMaskedEnv(env: EnvMap, candidates: Iterable<EnvMap>): EnvMap {
  const sources = [...candidates]
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      if (!isMasked(value)) return [key, value]
      const original = sources
        .map((source) => source[key])
        .find((stored) => stored !== undefined && !isSealed(stored) && maskValue(stored) === value)
      return [key, original ?? value]
    })
  )
}

/** Saved workspace defaults for `cwd` (paths compare like the file system does). */
function workspaceEnv(
  launch: LaunchPrefs | undefined,
  cwd: string,
  engine: EngineId
): EnvMap | undefined {
  const match = Object.entries(engineLaunchWorkspaces(launch, engine)).find(([path]) =>
    samePath(path, cwd)
  )
  return match?.[1].env
}

/** `app:set-state`: resolve masked env values in a `features.launch` patch against the stored prefs. */
export function resolvePrefsPatch(
  patch: Partial<AppPersistedState>,
  current: AppPersistedState
): Partial<AppPersistedState> {
  const launch = patch.features?.launch
  if (!launch) return patch
  const stored = current.features.launch
  const resolveWorkspaces = (
    workspaces: Record<string, LaunchOptions>,
    engine: EngineId
  ): Record<string, LaunchOptions> => {
    const resolved: Record<string, LaunchOptions> = {}
    for (const [path, options] of Object.entries(workspaces)) {
      const own = workspaceEnv(stored, path, engine)
      resolved[path] = options.env
        ? {
            ...options,
            env: resolveMaskedEnv(options.env, [
              ...(own ? [own] : []),
              ...workspaceEnvs(stored, engine)
            ])
          }
        : options
    }
    return resolved
  }
  const engineWorkspaces = Object.fromEntries(
    Object.entries(launch.engineWorkspaces ?? {}).map(([engine, workspaces]) => [
      engine,
      resolveWorkspaces(workspaces, normalizeEngineId(engine))
    ])
  )
  return {
    ...patch,
    features: {
      ...patch.features,
      launch: {
        ...launch,
        workspaces: launch.workspaces ? resolveWorkspaces(launch.workspaces, 'pi') : undefined,
        engineWorkspaces
      }
    }
  }
}

/**
 * Real env for an engine spawn: masks resolve against `known` (e.g. the agent being restarted), then the
 * workspace defaults for `cwd`, then any saved default. Values that are still sealed are left out.
 */
export function resolveLaunchEnv(
  args: CreateAgentArgs,
  prefs: AppPersistedState,
  known: EnvMap[] = []
): CreateAgentArgs {
  const env = args.launch?.env
  if (!env) return args
  const launch = prefs.features.launch
  const engine = normalizeEngineId(args.engine)
  const own = workspaceEnv(launch, args.cwd, engine)
  const resolved = resolveMaskedEnv(env, [
    ...known,
    ...(own ? [own] : []),
    ...workspaceEnvs(launch, engine)
  ])
  const usable = Object.fromEntries(
    Object.entries(resolved).filter(([, value]) => !isSealed(value))
  )
  return { ...args, launch: { ...args.launch, env: usable } }
}

/** Renderer form of an agent: launch env values masked. */
export function maskAgentInfo(info: AgentInfo): AgentInfo {
  const env = info.args.launch?.env
  return env
    ? { ...info, args: { ...info.args, launch: { ...info.args.launch, env: maskEnv(env) } } }
    : info
}

/** `launch:reveal-env`: one saved workspace-default value in clear, on explicit user request. */
export function revealWorkspaceEnv(
  prefs: AppPersistedState,
  cwd: string,
  key: string,
  engine: EngineId = 'pi'
): string | null {
  const value = workspaceEnv(prefs.features.launch, cwd, engine)?.[key]
  return value === undefined || isSealed(value) ? null : value
}
