import type { SettingsChangeArea } from '@shared/api/settings'

/**
 * Classification of engine config files for the ConfigWatcher (pure; no Electron). Paths are split into
 * segments relative to the agent dir or a project's `.pi` dir.
 *
 * N1: running engines write credentials on their own (OAuth refreshes in `auth.json`, MCP tokens in
 * `mcp-auth.json`, extension token caches). Those writes are never config changes: credential files have
 * no area, and `auth.json` only counts when its set of providers changes (`authSignature`).
 */

const RESOURCE_DIRS = new Set(['extensions', 'skills', 'prompts', 'themes'])
export const INSTRUCTION_FILE = /^(agents(\.override)?|claude)\.md$/i
const SYSTEM_FILE = /^(append_)?system\.md$/i

/** Token/credential stores (`mcp-auth.json`, `oauth-tokens.json`, `token.json`, `credentials.json`…). */
const CREDENTIAL_FILE = /(^|[-_.])(auth|oauth|tokens?|credentials?|secrets?)\.json([-_.~].*)?$/i

/** True for files engines and extensions rewrite on their own to persist credentials. */
export function isCredentialFile(name: string): boolean {
  return CREDENTIAL_FILE.test(name)
}

/** Config area of a path relative to the agent dir or a project's `.pi` dir. */
export function areaOf(segments: string[]): SettingsChangeArea | null {
  const [first, second] = segments
  if (!first) return null
  if (isCredentialFile(segments[segments.length - 1]!)) return null
  const name = first.toLowerCase()
  if (segments.length === 1) {
    if (name === 'settings.json') return 'settings'
    if (name === 'mcp.json') return 'mcp'
    return SYSTEM_FILE.test(first) ? 'instructions' : null
  }
  if (RESOURCE_DIRS.has(name)) return 'resources'
  if (name === 'npm') return second === 'package.json' || second === 'package-lock.json' ? 'packages' : null
  if (name === 'git') return 'packages'
  return null
}

/** Folder levels of a resource folder that Linux watches (`extensions/<name>/src`). */
const RESOURCE_WATCH_DEPTH = 3
/** Folders inside resources that hold no config: installed dependencies and dot-folders such as `.git`. */
const UNWATCHED_FOLDER = /^(node_modules|\..*)$/

/**
 * Whether Linux watches this subfolder of the agent dir or a project's `.pi` dir (segments relative to it), which it
 * has to do folder by folder (watch-tree.ts): resource folders a few levels deep, `npm/` itself for its package files
 * and the top of `git/`. Sessions, installed packages and caches are left out.
 */
export function watchedConfigFolder(segments: string[]): boolean {
  const name = segments[0]!.toLowerCase()
  if (RESOURCE_DIRS.has(name)) return isResourceFolder(segments)
  if (name === 'npm') return segments.length === 1
  return name === 'git' && segments.length <= 2
}

/** A folder below a resource folder that may hold resources (`skills/<name>`), not dependencies or VCS data. */
export function isResourceFolder(segments: string[]): boolean {
  return (
    segments.length <= RESOURCE_WATCH_DEPTH &&
    !segments.slice(1).some((segment) => UNWATCHED_FOLDER.test(segment))
  )
}

/** Config area of a path relative to the agent dir (`auth.json` still needs its provider-set check). */
export function agentDirArea(segments: string[]): SettingsChangeArea | null {
  if (segments.length === 1) {
    const name = segments[0]!.toLowerCase()
    if (name === 'auth.json') return 'auth'
    if (name === 'models.json') return 'models'
    if (name === 'keybindings.json') return 'keybindings'
    if (name === 'trust.json') return 'trust'
    if (INSTRUCTION_FILE.test(segments[0]!)) return 'instructions'
  }
  return areaOf(segments)
}

/**
 * Which providers have credentials, and of which kind: a sign-in or sign-out changes it, a token refresh
 * (new access token / expiry for the same provider) does not. Null when the file is missing or unreadable.
 */
export function authSignature(text: string | null): string | null {
  if (text === null) return null
  try {
    const data = JSON.parse(text) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return Object.entries(data as Record<string, unknown>)
      .map(([provider, credential]) => `${provider}:${String((credential as { type?: unknown } | null)?.type ?? '')}`)
      .sort()
      .join('|')
  } catch {
    return null
  }
}
