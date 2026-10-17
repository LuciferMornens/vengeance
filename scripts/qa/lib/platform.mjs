// Host-platform facts for the QA, shots and e2e harnesses: Chromium switches for every launch,
// executable and process names, the unpacked electron-builder layout and document editing keys.
// The Windows values are the ones the harnesses always used.
import { dirname, join } from 'node:path'

const WINDOWS = process.platform === 'win32'
const MAC = process.platform === 'darwin'

/**
 * Chromium switches every harness launch adds. Linux: the basic password store, so safeStorage
 * never waits on a desktop keyring over D-Bus; when CI runs as root (a container, where Chromium
 * refuses to start sandboxed and Docker's /dev/shm holds only 64 MB), no sandbox and shared memory
 * in /tmp. macOS: the mock Keychain, so safeStorage never prompts.
 */
export const ELECTRON_SWITCHES = MAC
  ? ['--use-mock-keychain']
  : process.platform === 'linux'
    ? [
        '--password-store=basic',
        ...(process.env.CI && process.getuid?.() === 0
          ? ['--no-sandbox', '--disable-dev-shm-usage']
          : [])
      ]
    : []

/** `name` with the host's executable suffix (`prime-agent` → `prime-agent.exe` on Windows). */
export function executableName(name) {
  return WINDOWS ? `${name}.exe` : name
}

/** Process name of a running Vengeance main process (Linux: electron-builder's `executableName`). */
export const APP_PROCESS_NAME = WINDOWS ? 'Vengeance.exe' : MAC ? 'Vengeance' : 'vengeance'

/** electron-builder's unpacked output folder for the host platform and architecture. */
function unpackedFolder() {
  const arm64 = process.arch === 'arm64'
  if (WINDOWS) return arm64 ? 'win-arm64-unpacked' : 'win-unpacked'
  if (MAC) return arm64 ? 'mac-arm64' : 'mac'
  return arm64 ? 'linux-arm64-unpacked' : 'linux-unpacked'
}

/**
 * The host's unpacked app executable under an electron-builder output folder: Windows
 * `win-unpacked/Vengeance.exe`, macOS `mac-arm64|mac/Vengeance.app/Contents/MacOS/Vengeance`, Linux
 * `linux-unpacked|linux-arm64-unpacked/vengeance`.
 */
export function unpackedExecutable(outputDir) {
  const folder = join(outputDir, unpackedFolder())
  if (WINDOWS) return join(folder, 'Vengeance.exe')
  if (MAC) return join(folder, 'Vengeance.app', 'Contents', 'MacOS', 'Vengeance')
  return join(folder, 'vengeance')
}

/** `process.resourcesPath` of a packaged app from its executable (macOS: `Contents/Resources`). */
export function resourcesDirOf(executable) {
  return MAC
    ? join(dirname(dirname(executable)), 'Resources')
    : join(dirname(executable), 'resources')
}

/** The app's name for where deleted files go (src/renderer/lib/platform-copy.ts TRASH_NAME). */
export const TRASH_NAME = WINDOWS ? 'Recycle Bin' : 'Trash'

/** Keys that move a textarea's caret to the start / end of the whole text (macOS: ⌘↑ / ⌘↓). */
export const DOCUMENT_START_KEY = MAC ? 'Meta+ArrowUp' : 'Control+Home'
export const DOCUMENT_END_KEY = MAC ? 'Meta+ArrowDown' : 'Control+End'
