import { join } from 'node:path'
import { app } from 'electron'

/**
 * The native Engine 2 helper (`resources/prime-auth`): packaged outside ASAR in `<resources>/prime-auth`, staged in
 * `resources/prime-auth/bin` for development. Used for sign-in, saved-session, resource, trace and restart modes.
 */
export function primeHelperPath(): string {
  const name = process.platform === 'win32' ? 'vengeance-prime-auth.exe' : 'vengeance-prime-auth'
  return app.isPackaged
    ? join(process.resourcesPath, 'prime-auth', name)
    : join(app.getAppPath(), 'resources', 'prime-auth', 'bin', name)
}
