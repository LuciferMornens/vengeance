import { execFile, type ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
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
 * Environment for any pi process (RPC engine or CLI subcommand): the app's env plus `extra`, the managed
 * install root for custom managed installs and Electron-as-Node mode for the bundled runtime.
 */
export function engineEnv(
  location: EngineLocation,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
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
 * Kill a pi process and everything it spawned (tools, LSP servers). Never once it has exited: Windows reuses PIDs
 * quickly, and `taskkill /T` on a stale one would take down an unrelated process tree.
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
  } else {
    child.kill('SIGKILL')
  }
}
