// REAL mode guard: snapshots the user's real engine config before a run against the real engine
// and proves afterwards that the run left it alone.
//
// Guarded files (sha256 + mtime): settings.json, models.json, keybindings.json, mcp.json.
// auth.json is only stat()ed (size + mtime), never read or copied: the user's providers are OAuth
// and the engine may rotate refresh tokens in it. A change there is reported, not failed.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REAL_AGENT_DIR } from './agent-dir.mjs'

const GUARDED_FILES = ['settings.json', 'models.json', 'keybindings.json', 'mcp.json']
const AUTH_FILE = 'auth.json'

/** Longest prompt REAL mode accepts: tiny prompts only ("Reply with exactly: ok"). */
export const REAL_PROMPT_MAX_CHARS = 80

async function fingerprint(path) {
  try {
    const [info, content] = await Promise.all([stat(path), readFile(path)])
    return { sha256: createHash('sha256').update(content).digest('hex'), mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function authStat(path) {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function describe(state) {
  return state ? JSON.stringify(state) : 'missing'
}

/**
 * Snapshot the real config. `verify()` throws when a guarded file changed (content, mtime, created
 * or deleted) and returns `{ authChanged }` for the report.
 */
export async function snapshotRealConfig(agentDir = REAL_AGENT_DIR) {
  const before = new Map()
  for (const name of GUARDED_FILES) before.set(name, await fingerprint(join(agentDir, name)))
  const authBefore = await authStat(join(agentDir, AUTH_FILE))

  return {
    async verify() {
      const changed = []
      for (const [name, state] of before) {
        const now = await fingerprint(join(agentDir, name))
        const same = now?.sha256 === state?.sha256 && now?.mtimeMs === state?.mtimeMs
        if (!same) changed.push(`${name}: ${describe(state)} → ${describe(now)}`)
      }
      if (changed.length) {
        throw new Error(`REAL mode changed the user's engine config:\n  ${changed.join('\n  ')}`)
      }
      const authAfter = await authStat(join(agentDir, AUTH_FILE))
      const authChanged =
        authAfter?.mtimeMs !== authBefore?.mtimeMs || authAfter?.size !== authBefore?.size
      return { authChanged }
    }
  }
}
