import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

/**
 * Where Engine 2 daemons listen. Windows uses named pipes. macOS and Linux use Unix sockets in a folder only the
 * user can enter, so no other account can reach a resident session or plant a socket in its place, at a path short
 * enough for `sun_path` (104 bytes on macOS, 108 on Linux, each including the terminating NUL).
 */

const PREFIX = 'vengeance-engine2-'
const IDENTITY = /^[a-f0-9]{20}$/
const SUN_PATH_BYTES = process.platform === 'darwin' ? 104 : 108

/**
 * Socket folders in order of preference: the login session's runtime folder on Linux, then the user's temporary
 * folder, then `/tmp` (macOS temporary folders can be too long for a socket path).
 */
function socketDirectories(): string[] {
  const user = `vengeance-${process.getuid!()}`
  const runtime = process.platform === 'linux' ? process.env.XDG_RUNTIME_DIR : undefined
  return [
    ...new Set([
      ...(runtime && isAbsolute(runtime) ? [join(runtime, 'vengeance')] : []),
      join(tmpdir(), user),
      join('/tmp', user)
    ])
  ]
}

/** Create `directory` if needed and confirm it is a real folder of this user that only the user can open. */
function privateDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const stats = lstatSync(directory)
    if (!stats.isDirectory() || stats.uid !== process.getuid!()) return false
    if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700)
    return true
  } catch {
    return false
  }
}

/** The endpoint of the daemon with this `identity` (20 hex digits). */
export function primeDaemonEndpoint(identity: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${PREFIX}${identity}`
  const name = `${PREFIX}${identity}.sock`
  for (const directory of socketDirectories()) {
    const path = join(directory, name)
    if (Buffer.byteLength(path) < SUN_PATH_BYTES && privateDirectory(directory)) return path
  }
  throw new Error(
    'Engine 2 found no private folder for its connection. Check the permissions of the temporary folder.'
  )
}

/** `path` is an endpoint this app gives its daemons (registry entries naming anything else are ignored). */
export function ownedDaemonEndpoint(path: string): boolean {
  if (process.platform === 'win32') {
    const prefix = `\\\\.\\pipe\\${PREFIX}`
    return path.startsWith(prefix) && IDENTITY.test(path.slice(prefix.length))
  }
  const name = basename(path)
  return (
    name.startsWith(PREFIX) &&
    name.endsWith('.sock') &&
    IDENTITY.test(name.slice(PREFIX.length, -'.sock'.length)) &&
    socketDirectories().includes(dirname(path))
  )
}
