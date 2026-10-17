// Fake paths for screenshot scenarios (the mock engine never touches them), in the host's own form
// so macOS and Linux shots show native paths. They mirror the mock engine's fixtures in src/main: the
// mock user's home (C:\Users\dev, /Users/dev, /home/dev) and a second drive outside it (D:\,
// /Volumes/Data, /mnt/data). Sessions only list under a workspace whose path matches exactly.
import { join } from 'node:path'

const HOME = { win32: 'C:\\Users\\dev', darwin: '/Users/dev' }[process.platform] ?? '/home/dev'
const VOLUME = { win32: 'D:\\', darwin: '/Volumes/Data' }[process.platform] ?? '/mnt/data'

/** A path under the mock user's home: `mockHomePath('projects', 'aurora')`. */
export const mockHomePath = (...parts) => join(HOME, ...parts)

/** A path on the mock second drive: `mockVolumePath('work', 'relay')` (Windows `D:\work\relay`). */
export const mockVolumePath = (...parts) => join(VOLUME, ...parts)

/** The workspace most scenarios open. */
export const MOCK_WORKSPACE = mockHomePath('projects', 'aurora')
