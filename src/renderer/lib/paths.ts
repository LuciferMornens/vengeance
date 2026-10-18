import { platform } from './ipc'
import { stripWindowsPathPrefix } from '@shared/session-identity'

/**
 * Canonical form of a filesystem path for comparisons: one separator, no trailing separator, and
 * case-folded on Windows (where `d:\proj` and `D:\Proj` are the same folder). On macOS and Linux only `/`
 * separates (a backslash is part of a name) and the root `/` stays itself.
 */
export function normalizePath(path: string): string {
  if (platform.os !== 'win32') return path.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  return stripWindowsPathPrefix(path)
    .replace(/[\\/]+/g, '\\')
    .replace(/\\$/, '')
    .toLowerCase()
}

/** Two paths name the same file or folder (both must be set). */
export function samePath(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && normalizePath(a) === normalizePath(b)
}
