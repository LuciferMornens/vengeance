import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeCatalog } from '../../engine/sdk-host/protocol'
import { replaceFile } from './json-file'

/**
 * The SDK host's runtime catalog kept in userData between runs, so a launch answers the model picker without
 * starting the host. One entry: `key` stands for the inputs it was built from (models.ts `catalogKey`), `levels` are
 * the thinking levels of the extra models it was asked about. Holds what the catalog shows, no credential values.
 */
export interface StoredCatalog {
  key: string
  catalog: RuntimeCatalog
  levels: Record<string, string[]>
}

function cachePath(): string {
  return join(app.getPath('userData'), 'engine-catalog.json')
}

/** The stored catalog when it was built from the inputs `key` stands for; null otherwise or when unreadable. */
export function readStoredCatalog(key: string): StoredCatalog | null {
  try {
    const value = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<StoredCatalog>
    if (value.key !== key || !value.levels || !Array.isArray(value.catalog?.models)) return null
    // SAFETY: written by storeCatalog from a host answer; the key ties it to the same engine and config.
    return value as StoredCatalog
  } catch {
    return null
  }
}

/** Replace the stored catalog (temp file + rename); a failed write only costs the next launch a host start. */
export function storeCatalog(entry: StoredCatalog): void {
  void replaceFile(cachePath(), JSON.stringify(entry)).catch(() => undefined)
}
