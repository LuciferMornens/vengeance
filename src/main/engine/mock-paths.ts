import { join } from 'node:path'

/**
 * Fake paths of mock mode (VENGEANCE_MOCK=1), in the host system's own form so macOS and Linux screenshots show
 * native paths: the mock user's home (C:\Users\dev, /Users/dev, /home/dev) and a second drive outside it (D:\,
 * /Volumes/Data, /mnt/data). scripts/shots/lib/mock-paths.mjs mirrors them.
 */

const HOMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'C:\\Users\\dev', darwin: '/Users/dev' }
const VOLUMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'D:\\', darwin: '/Volumes/Data' }
const RESOURCES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'C:\\Program Files\\Vengeance\\resources',
  darwin: '/Applications/Vengeance.app/Contents/Resources'
}
const HOME = HOMES[process.platform] ?? '/home/dev'
const VOLUME = VOLUMES[process.platform] ?? '/mnt/data'

/** The mock user's home folder. */
export function mockHome(): string {
  return HOME
}

/** A path below the mock user's home: `mockHomePath('projects', 'aurora')`. */
export function mockHomePath(...segments: string[]): string {
  return join(HOME, ...segments)
}

/** A path on the mock second drive: `mockVolumePath('work', 'relay')` (Windows `D:\work\relay`). */
export function mockVolumePath(...segments: string[]): string {
  return join(VOLUME, ...segments)
}

/** A path in the installed app's resources folder. */
export function mockResourcesPath(...segments: string[]): string {
  return join(RESOURCES[process.platform] ?? '/opt/Vengeance/resources', ...segments)
}

/** A path in the mock user's temporary folder. */
export function mockTempPath(...segments: string[]): string {
  return process.platform === 'win32'
    ? mockHomePath('AppData', 'Local', 'Temp', ...segments)
    : join('/tmp', ...segments)
}

/** The same path with forward slashes, as tools that print POSIX-style paths show it on Windows too. */
export function forwardSlashes(path: string): string {
  return path.replaceAll('\\', '/')
}
