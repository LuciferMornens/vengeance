// Relaunch on the same Vengeance profile. The harness gives every launchApp() a fresh temp userData and
// deletes it on close(), so a restart test would always boot a first-run profile. This keeps the profile's
// `app-state.json` (prefs: workspaces, active workspace, pins…) across launches: just before close() deletes
// a run folder the file is saved, and when the next launch creates its `user-data` folder the file is put
// back, before Electron starts. Implemented by wrapping node:fs/promises `mkdir`/`rm` (live ESM bindings
// updated with syncBuiltinESMExports), only for the harness' own `vengeance-qa-run-*` temp folders.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const RUN_FOLDER = /^vengeance-qa-run-/
const STATE_FILE = 'app-state.json'

/** Start keeping the profile; returns `{ savedState(), release() }`. */
export function keepProfileAcrossLaunches() {
  const store = mkdtempSync(join(tmpdir(), 'vengeance-qa-profile-'))
  const saved = join(store, STATE_FILE)
  const originalMkdir = fsPromises.mkdir
  const originalRm = fsPromises.rm

  fsPromises.mkdir = async (path, ...rest) => {
    const result = await originalMkdir(path, ...rest)
    const target = String(path)
    if (
      basename(target) === 'user-data' &&
      RUN_FOLDER.test(basename(dirname(target))) &&
      existsSync(saved)
    ) {
      copyFileSync(saved, join(target, STATE_FILE))
    }
    return result
  }
  fsPromises.rm = async (path, ...rest) => {
    const target = String(path)
    const state = join(target, 'user-data', STATE_FILE)
    if (RUN_FOLDER.test(basename(target)) && existsSync(state)) copyFileSync(state, saved)
    return originalRm(path, ...rest)
  }
  syncBuiltinESMExports()

  return {
    /** Path of the saved app-state.json (exists after the first close()). */
    savedState: () => saved,
    release() {
      fsPromises.mkdir = originalMkdir
      fsPromises.rm = originalRm
      syncBuiltinESMExports()
      rmSync(store, { recursive: true, force: true })
    }
  }
}
