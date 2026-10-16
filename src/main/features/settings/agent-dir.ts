import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { env } from '../../env'
import { seedMockAgentDir } from './mock-agent-dir'

/**
 * Where the engine keeps its user-level config. pi honors `PI_CODING_AGENT_DIR`; Vengeance reads it
 * from its own environment, so setting it before launch isolates the whole app (config-side SDK calls
 * and every spawned pi process inherit it). Mock mode without an explicit override seeds a temp dir so
 * development and screenshots never touch the real ~/.pi/agent.
 */

let mockRoot: string | null = null
const explicitOverride = !!process.env.PI_CODING_AGENT_DIR

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Call once at startup (before any SDK access). */
export function prepareAgentDir(): void {
  if (!env.mock || explicitOverride) return
  mockRoot = mkdtempSync(join(tmpdir(), 'vengeance-mock-engine-'))
  const agentDir = join(mockRoot, 'agent')
  seedMockAgentDir(agentDir, join(mockRoot, 'workspaces'))
  process.env.PI_CODING_AGENT_DIR = agentDir
  app.on('will-quit', () => {
    if (!mockRoot) return
    try {
      rmSync(mockRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows can still hold handles from exiting engines; a leftover temp dir is harmless.
    }
  })
}

export function agentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR
  return resolve(fromEnv ? expandHome(fromEnv) : join(homedir(), '.pi', 'agent'))
}

/** pi's env override for session storage (docs/sessions.md); it wins over the `sessionDir` setting. */
export const SESSION_DIR_ENV = 'PI_CODING_AGENT_SESSION_DIR'

/** True when config lives somewhere other than the user's real agent dir. */
export function isIsolatedAgentDir(): boolean {
  return explicitOverride || mockRoot !== null
}

/**
 * The folder whose `.pi/` holds project config. Mock workspaces are fake paths, so they map to a seeded
 * stand-in folder inside the temp root instead of creating directories at the fake location.
 */
export function projectRoot(cwd: string): string {
  if (mockRoot && !existsSync(cwd)) {
    const stand = join(mockRoot, 'workspaces', basename(cwd) || 'workspace')
    mkdirSync(stand, { recursive: true })
    return stand
  }
  return cwd
}

export function projectSettingsPath(cwd: string): string {
  return join(projectRoot(cwd), '.pi', 'settings.json')
}

export function globalSettingsPath(): string {
  return join(agentDir(), 'settings.json')
}

/** Write a small text file, creating parent folders (mock seeding helper). */
export function writeSeedFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}
