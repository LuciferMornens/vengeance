import { execFile, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { childBaseEnv } from '../shell-env'
import type { EngineLocation } from './locate'

/**
 * Shared helpers for running and importing the selected Engine. Engine processes,
 * CLI subcommands and config-side SDK access all go through these.
 */

// Native dynamic import that survives the CommonJS main bundle (rollup must not rewrite it to require()).
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

const importCache = new Map<string, Promise<unknown>>()

/**
 * Import an ESM file of the installed engine (absolute path, e.g. `<packageDir>/dist/index.js`), cached
 * per file. `T` must mirror the matching `.d.ts` of the installed engine (protocol boundary).
 */
export function importPiFile<T>(path: string): Promise<T> {
  const url = pathToFileURL(path).href
  let pending = importCache.get(url)
  if (!pending) {
    pending = importEsm(url)
    pending.catch(() => importCache.delete(url))
    importCache.set(url, pending)
  }
  return pending as Promise<T>
}

/**
 * Environment for any pi process (RPC engine or CLI subcommand): the children's base env plus `extra`, the managed
 * install root for custom managed installs and Electron-as-Node mode for the bundled runtime.
 */
export function engineEnv(
  location: EngineLocation,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childBaseEnv(), ...extra }
  if (location.source === 'bundled') {
    delete env.PI_MANAGED_INSTALL_ROOT
    env.PI_PACKAGE_DIR = location.packageDir
    env.PI_SKIP_VERSION_CHECK = '1'
  }
  if (location.managedInstallRoot) env.PI_MANAGED_INSTALL_ROOT = location.managedInstallRoot
  if (location.node.isElectron) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * Spawn option (`detached`) for children stopped with killProcessTree. On macOS and Linux each leads its own process
 * group, so one signal reaches everything it started that stayed in the group; Windows walks the tree by PID.
 */
export const OWN_PROCESS_GROUP = process.platform !== 'win32'

/** How long a process group has to handle SIGTERM (pi stops its tool process groups) before SIGKILL. */
const TERMINATE_GRACE_MS = 1_500

/** Signal the child's process group, or the child alone when it does not lead one. */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal)
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

/**
 * Kill a pi process and everything it spawned (tools, LSP servers). Never once it has exited: Windows reuses PIDs
 * quickly, and `taskkill /T` on a stale one would take down an unrelated process tree. On macOS and Linux the group
 * (OWN_PROCESS_GROUP) gets SIGTERM, then SIGKILL after a grace period. A group ID stays reserved while any member
 * lives, so the late signal reaches only stragglers of this group.
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    execFile(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      () => undefined
    )
    return
  }
  signalProcessGroup(child, 'SIGTERM')
  setTimeout(() => signalProcessGroup(child, 'SIGKILL'), TERMINATE_GRACE_MS)
}
