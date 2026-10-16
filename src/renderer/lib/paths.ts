import { platform } from './ipc'

/**
 * Canonical form of a filesystem path for comparisons: one separator, no trailing separator, and
 * case-folded on Windows (where `d:\proj` and `D:\Proj` are the same folder).
 */
export function normalizePath(path: string): string {
  const unified = path.replace(/[\\/]+/g, platform.os === 'win32' ? '\\' : '/').replace(/[\\/]$/, '')
  return platform.os === 'win32' ? unified.toLowerCase() : unified
}

/** Two paths name the same file or folder (both must be set). */
export function samePath(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && normalizePath(a) === normalizePath(b)
}
