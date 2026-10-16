import { join } from 'node:path'
import type { TrustEntry } from '@shared/api/settings'
import { setTrustEntry } from '../launch/trust'
import { agentDir } from './agent-dir'
import { readJsonFile } from './json-file'

/**
 * Saved project trust decisions (`<agentDir>/trust.json`). pi's ProjectTrustStore has no list API, so the
 * file is read directly; every change goes through the store (launch/trust.ts: its lock and path normalization).
 */

export function listTrust(): TrustEntry[] {
  const file = readJsonFile(join(agentDir(), 'trust.json'))
  if (file.error) throw new Error(`trust.json could not be read: ${file.error}`)
  return Object.entries(file.data)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
    .map(([path, decision]) => ({ path, decision }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export async function updateTrustEntry(override: string | null, path: string, decision: boolean | null): Promise<TrustEntry[]> {
  if (decision !== null && !listTrust().some((entry) => entry.path === path)) throw new Error('Only saved decisions can be changed here.')
  await setTrustEntry(override, path, decision)
  return listTrust()
}
