import { realpathSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
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

/**
 * A folder as a process that runs in it reports it. POSIX `getcwd` resolves symlinks (macOS `/tmp` → `/private/tmp`, a
 * linked projects folder), and pi records that `process.cwd()` as a session's workspace and names the session folder
 * after it, so workspace folders enter the app in this form. Windows keeps the folder as given (only resolved), and so
 * does a path that cannot be resolved.
 */
export function physicalPath(path: string): string {
  const resolved = resolve(path)
  if (process.platform === 'win32') return resolved
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/**
 * Maps paths a native component returned canonicalized (symlinks resolved, like macOS `/var` → `/private/var` or a
 * linked home folder) back below the `roots` they were found under, so they equal the app's own listings. Windows
 * paths are returned unchanged: comparablePath already ignores their `\\?\` prefix and case.
 */
export async function rootedPaths(roots: readonly string[]): Promise<(path: string) => string> {
  if (process.platform === 'win32') return (path) => path
  const links = (
    await Promise.all(
      roots.map(async (root) => {
        const given = resolve(root)
        const canonical = await realpath(given).catch(() => given)
        return { given, canonical }
      })
    )
  )
    .filter((link) => link.canonical !== link.given)
    .sort((a, b) => b.canonical.length - a.canonical.length)
  return (path) => {
    const link = links.find(
      ({ canonical }) => path === canonical || path.startsWith(`${canonical}${sep}`)
    )
    return link ? `${link.given}${path.slice(link.canonical.length)}` : path
  }
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
