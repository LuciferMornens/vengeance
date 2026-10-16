import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_APP_STATE, type AppPersistedState } from '@shared/api/app'
import { normalizeEngineId, type EngineId } from '@shared/api/engine'
import { openPrefs, sealPrefs, type EnvCipher } from './features/launch/env-vault'
import { restorableOpenSessions } from './features/sessions/open-sessions'

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

type PrefsListener = (prefs: AppPersistedState, previous: AppPersistedState) => void

const RENAME_ATTEMPTS = 5
const RENAME_RETRY_MS = 40

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Write temp + rename. On Windows the rename fails with EPERM/EBUSY while antivirus or the indexer
 * briefly holds the target, so it is retried; the temp file never outlives the call.
 */
function writeFileAtomicSync(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temp, content, 'utf8')
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, target)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') ||
          attempt >= RENAME_ATTEMPTS
        )
          throw error
        sleepSync(RENAME_RETRY_MS * attempt)
      }
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Electron safeStorage (DPAPI on Windows) for engine env values at rest; usable once the app is ready. */
const safeStorageCipher: EnvCipher = {
  encrypt: (plain) =>
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(plain).toString('base64')
      : null,
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
}

interface AppStateFile {
  prefs: AppPersistedState
  window?: WindowBounds
}

function normalizeEnginePrefs(prefs: AppPersistedState): AppPersistedState {
  return {
    ...prefs,
    defaultEngine: normalizeEngineId(prefs.defaultEngine),
    workspaces: prefs.workspaces.map((workspace) => ({
      ...workspace,
      engine: normalizeEngineId(workspace.engine)
    })),
    openSessions: prefs.openSessions.map((session) => ({
      ...session,
      engine: normalizeEngineId(session.engine)
    }))
  }
}

/**
 * Persisted app state in `<userData>/app-state.json`; writes are debounced and atomic. Engine env values
 * are sealed on disk and plain only in memory (features/launch/env-vault.ts); load after app `ready`.
 */
class AppStateStore {
  private data: AppStateFile | null = null
  private writeTimer: NodeJS.Timeout | null = null
  private readonly prefsListeners = new Set<PrefsListener>()

  private get file(): string {
    return join(app.getPath('userData'), 'app-state.json')
  }

  private load(): AppStateFile {
    if (this.data) return this.data
    let parsed: Partial<AppStateFile> = {}
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppStateFile>
    } catch {
      // Missing or corrupt file: start from defaults.
    }
    const stored: Partial<AppPersistedState> = parsed.prefs ?? {}
    const { prefs, migrate } = openPrefs(
      { ...DEFAULT_APP_STATE, ...stored, ...restorableOpenSessions(stored), version: 1 },
      safeStorageCipher
    )
    this.data = { prefs: normalizeEnginePrefs(prefs), window: parsed.window }
    // Plain env values from an older version: seal them on disk right away.
    if (migrate) this.scheduleWrite()
    return this.data
  }

  getPrefs(): AppPersistedState {
    return this.load().prefs
  }

  setPrefs(patch: Partial<AppPersistedState>): AppPersistedState {
    const current = this.load()
    const features = patch.features
      ? { ...current.prefs.features, ...patch.features }
      : current.prefs.features
    const previous = current.prefs
    current.prefs = normalizeEnginePrefs({ ...current.prefs, ...patch, features, version: 1 })
    this.scheduleWrite()
    for (const listener of this.prefsListeners) listener(current.prefs, previous)
    return current.prefs
  }

  /** Calls `listener` after each `setPrefs`; returns the unsubscribe. */
  onPrefsChange(listener: PrefsListener): () => void {
    this.prefsListeners.add(listener)
    return () => this.prefsListeners.delete(listener)
  }

  getWindowBounds(): WindowBounds | undefined {
    return this.load().window
  }

  setWindowBounds(bounds: WindowBounds): void {
    this.load().window = bounds
    this.scheduleWrite()
  }

  /** Flush pending writes synchronously (call on quit). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (!this.data) return
    writeFileAtomicSync(
      this.file,
      JSON.stringify(
        { ...this.data, prefs: sealPrefs(this.data.prefs, safeStorageCipher) },
        null,
        2
      )
    )
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      try {
        this.flush()
      } catch (error) {
        // Keep the in-memory state; the next change or quit retries the write.
        console.error('[vengeance] could not persist app state:', error)
      }
    }, 250)
  }
}

export const appState = new AppStateStore()

export function engineOverridePath(engine: EngineId = 'pi'): string | null {
  const prefs = appState.getPrefs()
  return engine === 'pi' ? prefs.engineOverridePath : (prefs.engineOverridePaths?.[engine] ?? null)
}
