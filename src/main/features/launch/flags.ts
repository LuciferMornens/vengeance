import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type { EngineToolInfo, ExtensionFlagInfo, ExtensionFlagsRequest, ExtensionFlagsResult } from '@shared/api/launch'
import { friendlyExtensionName } from '@shared/display-names'
import { locateEngine, type EngineLocation } from '../../engine/locate'
import { engineEnv } from '../../engine/runtime'
import { sdkHostCall } from '../../engine/sdk-host/client'
import { env } from '../../env'
import { samePath } from '../../paths'
import { packageDisplayName } from '../settings/package-source'
import { piConfig, type ResolvedResource } from '../settings/pi-modules'
import { trustPreflight } from './trust'

/**
 * Extension CLI flag discovery: extensions register flags with `pi.registerFlag`, and the engine's top-level
 * `--help` lists them under "Extension CLI Flags:" (pi 1.1.0 `dist/cli/args.js` printHelp:
 * `"  --name[ <value>]".padEnd(30) + description`). The probe runs in the workspace so project extensions
 * count, with `--approve` only when the workspace is trusted.
 */

const HELP_TIMEOUT_MS = 60_000
/** printHelp pads `  --name[ <value>]` to this column; longer names run straight into the description. */
const HELP_FLAG_COLUMN = 30

const ANSI = /\x1b\[[0-9;]*m/g

function section(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0) return []
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || !/^\s/.test(line)) break
    body.push(line)
  }
  return body
}

/** Split `name` from a description that was printed without padding (flag names are lowercase kebab-case). */
function splitGluedToken(token: string): [name: string, descriptionStart: string] {
  const minName = HELP_FLAG_COLUMN - 4
  for (let i = minName; i < token.length; i++) {
    if (/[A-Z]/.test(token[i]!) && /[a-z0-9]/.test(token[i - 1]!)) return [token.slice(0, i), token.slice(i)]
  }
  return [token, '']
}

function parseFlagLine(line: string): { name: string; takesValue: boolean; description: string } | null {
  if (!line.startsWith('  --')) return null
  const body = line.slice(4)
  const withValue = /^(\S+) <value>(.*)$/.exec(body)
  if (withValue) return { name: withValue[1]!, takesValue: true, description: withValue[2]!.trim() }
  const token = /^\S+/.exec(body)?.[0]
  if (!token) return null
  const rest = body.slice(token.length).trim()
  if (4 + token.length < HELP_FLAG_COLUMN) return { name: token, takesValue: false, description: rest }
  const [name, start] = splitGluedToken(token)
  return { name, takesValue: false, description: [start, rest].filter(Boolean).join(' ') }
}

/** Last segment of a package's technical name (`npm:@scope/name@1.2` → `name`): what flag help text mentions. */
function packageStem(source: string): string {
  return packageDisplayName(source).split('/').pop() ?? source
}

function flagMatchesPackage(flag: { name: string; description: string }, pkg: string): boolean {
  const name = pkg.toLowerCase()
  if (flag.description.toLowerCase().includes(name)) return true
  const stem = name.replace(/^pi-/, '')
  if (stem.length < 3) return false
  return stem.includes('-') ? flag.name.includes(stem) : flag.name.split('-').includes(stem)
}

/** A loaded extension file and the flag group it belongs to: its package, or the file itself. */
export interface ExtensionFile {
  group: string
  path: string
  /** Source text, searched for the `registerFlag('<name>'` call. */
  text: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function registersFlag(file: ExtensionFile, flag: string): boolean {
  return new RegExp(`registerFlag\\(\\s*['"\`]${escapeRegExp(flag)}['"\`]`).test(file.text)
}

/**
 * Infer the owning extension per flag: the file whose source registers it, else a package named in the flag.
 * pi prints flags in extension load order, so flags of one extension are contiguous: unmatched flags
 * inherit the previous match (leading ones the first match).
 */
function inferGroups(flags: Array<{ name: string; description: string }>, packages: string[], files: ExtensionFile[]): Array<string | null> {
  const names = [...new Set(packages.map(packageStem).filter(Boolean))]
  const direct = flags.map((flag) => {
    const registeredBy = /^Registered by (.+)$/.exec(flag.description)?.[1]
    if (registeredBy) {
      const file = files.find((f) => samePath(f.path, registeredBy))
      return file?.group ?? names.find((pkg) => registeredBy.includes(pkg)) ?? packageStem(registeredBy)
    }
    return files.find((file) => registersFlag(file, flag.name))?.group ?? names.find((pkg) => flagMatchesPackage(flag, pkg)) ?? null
  })
  const first = direct.find((group) => group !== null) ?? null
  let previous = first
  return direct.map((group) => (previous = group ?? previous))
}

/** Parse the engine's top-level `--help` into extension flags and built-in tool names. */
export function parseEngineHelp(text: string, packages: string[], files: ExtensionFile[] = []): { flags: ExtensionFlagInfo[]; builtinTools: EngineToolInfo[] } {
  const lines = text.replace(ANSI, '').split(/\r?\n/)
  const parsed: Array<{ name: string; takesValue: boolean; description: string }> = []
  for (const line of section(lines, 'Extension CLI Flags:')) {
    const flag = parseFlagLine(line)
    if (flag) parsed.push(flag)
    else if (parsed.length > 0) parsed[parsed.length - 1]!.description += ` ${line.trim()}`
  }
  const groups = inferGroups(parsed, packages, files)
  const flags = parsed.map((flag, i) => {
    const group = groups[i] ?? null
    return { ...flag, group, groupLabel: group ? friendlyExtensionName(group) : null }
  })
  const builtinTools = section(lines, 'Built-in Tool Names:').flatMap((line) => {
    const match = /^\s+(\S+)\s+-\s+(.*)$/.exec(line)
    return match ? [{ name: match[1]!, description: match[2]!.trim() }] : []
  })
  return { flags, builtinTools }
}

/** The sources a settings.json lists under `key` (strings or `{ source }` objects); [] when unreadable. */
export function readSettingsList(file: string, key: 'packages' | 'extensions'): string[] {
  try {
    // Windows editors may save a BOM; the engine's own reader strips it too.
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const value = (JSON.parse(text) as Record<string, unknown>)[key]
    if (!Array.isArray(value)) return []
    return value.flatMap((item: unknown) => {
      if (typeof item === 'string') return [item]
      const source = (item as { source?: unknown } | null)?.source
      return typeof source === 'string' ? [source] : []
    })
  } catch {
    return []
  }
}

/** A package's flags group under the package; a loose extension file under its own name (`index.ts`: its folder). */
function extensionFileGroup(resource: ResolvedResource): string {
  if (resource.metadata.origin === 'package') return packageStem(resource.metadata.source)
  const stem = basename(resource.path, extname(resource.path))
  return stem === 'index' ? basename(dirname(resource.path)) : stem
}

/** The extension files the engine loads in `cwd` (resolved like the engine does, nothing installed). */
async function loadedExtensionFiles(override: string | null, cwd: string, agentDir: string, trusted: boolean): Promise<ExtensionFile[]> {
  const { resolved } = await sdkHostCall(override, 'packages', { cwd, agentDir, projectTrusted: trusted })
  return resolved.extensions
    .filter((resource) => resource.enabled && resource.metadata.source !== 'builtin')
    .flatMap((resource) => {
      try {
        return [{ group: extensionFileGroup(resource), path: resource.path, text: readFileSync(resource.path, 'utf8') }]
      } catch {
        return []
      }
    })
}

function runHelp(location: EngineLocation, cwd: string, trusted: boolean): Promise<string> {
  const childEnv = engineEnv(location, { NO_COLOR: '1', PI_OFFLINE: '1' })
  const args = [location.cliPath, '--help', trusted ? '--approve' : '--no-approve']
  return new Promise((resolvePromise, reject) => {
    execFile(location.node.path, args, { cwd, env: childEnv, windowsHide: true, timeout: HELP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) reject(new Error(`The engine help could not be read: ${(stderr || error.message).trim().slice(0, 400)}`))
      else resolvePromise(stdout)
    })
  })
}

const MOCK_HELP = `Extension CLI Flags:
  --no-lens                   Start pi-lens disabled for this session. Re-enable with /lens-toggle.
  --no-autoformat             Disable automatic formatting entirely (deferred format runs at agent_end by default).
  --immediate-format          Run automatic formatting immediately after each write/edit instead of deferring to agent_end.
  --lens-guard                Experimental: block git commit/push when unresolved pi-lens blockers exist.
  --no-tool <value>           Disable a lens tool for this session (repeatable).
  --subagent-max <value>      Maximum number of pi-subagents running in parallel (default 4).
  --subagent-worktrees        Run pi-subagents in isolated git worktrees.
  --todo-strict               Require rpiv-todo items to be closed before the agent settles.

Built-in Tool Names:
  read       - Read file contents
  bash       - Execute bash commands
  powershell - Execute PowerShell commands on Windows
  edit       - Edit files with find/replace
  write      - Write files (creates/overwrites)
  grep       - Search file contents (read-only, off by default)
  find       - Find files by glob pattern (read-only, off by default)
  ls         - List directory contents (read-only, off by default)
`
const MOCK_PACKAGES = ['npm:pi-lens', 'npm:pi-subagents', 'npm:@juicesharp/rpiv-todo']

const cache = new Map<string, ExtensionFlagsResult>()
const inFlight = new Map<string, Promise<ExtensionFlagsResult>>()
/** Bumped by clearExtensionFlagCache so probes started before an invalidation are not cached. */
let generation = 0

/**
 * Forget every discovered flag set. The cache key only covers the engine version and configured sources,
 * so installs/updates of the same sources and resource edits must invalidate it explicitly.
 */
export function clearExtensionFlagCache(): void {
  generation++
  cache.clear()
  inFlight.clear()
}

export async function discoverExtensionFlags(override: string | null, request: ExtensionFlagsRequest): Promise<ExtensionFlagsResult> {
  if (env.mock) {
    return { ...parseEngineHelp(MOCK_HELP, MOCK_PACKAGES), engineVersion: 'mock', trusted: request.approve ?? true, fetchedAt: Date.now() }
  }
  const cwd = resolve(request.cwd)
  const trusted = request.approve ?? (await trustPreflight(override, cwd)).engineDefault
  const location = await locateEngine(override)
  const agentDir = (await piConfig(override)).getAgentDir()
  const projectSettings = join(cwd, '.pi', 'settings.json')
  const packages = [...readSettingsList(join(agentDir, 'settings.json'), 'packages'), ...(trusted ? readSettingsList(projectSettings, 'packages') : [])]
  const extensions = [...readSettingsList(join(agentDir, 'settings.json'), 'extensions'), ...(trusted ? readSettingsList(projectSettings, 'extensions') : [])]
  const key = JSON.stringify([location.version, packages, extensions, cwd.toLowerCase(), trusted])

  const cached = cache.get(key)
  if (cached && !request.refresh) return cached
  let pending = inFlight.get(key)
  if (!pending) {
    const started = generation
    // The files only name the groups; without them the flags still list, grouped by package names.
    const files = loadedExtensionFiles(override, cwd, agentDir, trusted).catch((): ExtensionFile[] => [])
    pending = Promise.all([runHelp(location, cwd, trusted), files])
      .then(([text, files]) => {
        const result: ExtensionFlagsResult = { ...parseEngineHelp(text, packages, files), engineVersion: location.version, trusted, fetchedAt: Date.now() }
        if (started === generation) cache.set(key, result)
        return result
      })
      .finally(() => {
        if (started === generation) inFlight.delete(key)
      })
    inFlight.set(key, pending)
  }
  return pending
}
