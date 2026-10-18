/**
 * Whether a path follows Windows rules (either separator, case-insensitive): it has a drive letter, a UNC root or a
 * backslash. Judged by its shape rather than the host so pure helpers stay testable anywhere; the paths a session's
 * tools touch follow the kind of its workspace folder.
 */
export function isWindowsPath(path: string): boolean {
  return /^[a-z]:|^[\\/]{2}|\\/i.test(path)
}
