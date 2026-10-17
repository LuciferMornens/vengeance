import type { SessionLineage } from './api/sessions'

export function stripWindowsPathPrefix(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

/** Native session paths are absolute; Windows file identities accept both namespace forms. */
export function sessionIdentityPath(path: string): string {
  const ordinary = stripWindowsPathPrefix(path)
  const windows = /^[a-z]:[/\\]|^[\\/]{2}/i.test(ordinary)
  const unified = windows
    ? ordinary.replace(/[\\/]+/g, '/').toLowerCase()
    : ordinary.replace(/\/+/g, '/')
  return unified.replace(/\/$/, '')
}

export function sameSessionLineage(first?: SessionLineage, second?: SessionLineage): boolean {
  return (
    first?.parentSessionPath === second?.parentSessionPath &&
    first?.parentSessionId === second?.parentSessionId &&
    first?.parentNativeAgentId === second?.parentNativeAgentId &&
    first?.depth === second?.depth &&
    first?.childId === second?.childId &&
    first?.runtimeKind === second?.runtimeKind
  )
}
