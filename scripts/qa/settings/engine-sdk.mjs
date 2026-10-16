// The installed Engine's own modules, so suites can ask the Engine how it reads a config file the app
// wrote (keybindings.json, settings.json) without going through Vengeance. Read-only use: callers must
// pass a temp agent dir, never the user's real ~/.pi/agent.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BUNDLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.engine-staging/bundled'
)

/** The exact SDK shipped with the application under test. */
export function enginePackageDir() {
  const manifest = JSON.parse(readFileSync(join(BUNDLE_DIR, 'manifest.json'), 'utf8'))
  return join(BUNDLE_DIR, manifest.engines.pi.packageDir)
}

/** Import `dist/<relative>` of the installed Engine, e.g. `core/keybindings.js`. */
export function importEngine(relative) {
  return import(pathToFileURL(join(enginePackageDir(), 'dist', ...relative.split('/'))).href)
}
