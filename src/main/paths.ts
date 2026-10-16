import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { stripWindowsPathPrefix } from '@shared/session-identity'

/**
 * Path comparisons for the main process. Windows paths compare case-insensitively; everything is
 * resolved first, so separators, `.`/`..` segments and trailing separators never matter.
 */

/** Canonical form of a path for comparisons (resolved; case-folded on Windows). */
export function comparablePath(path: string): string {
  const resolved = resolve(stripWindowsPathPrefix(path))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Two paths name the same file or folder. */
export function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b)
}

/** `target` is `root` itself or somewhere below it. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(comparablePath(root), comparablePath(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function directoryExists(path: string): Promise<boolean> {
  if (!path) return false
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}
