import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { ProjectTrustDefault, TrustPreflight, TrustResource, TrustResourceKind } from '@shared/api/launch'
import { env } from '../../env'
import { readJsonFile } from '../settings/json-file'
import { piConfig, piTrust, type TrustModule } from '../settings/pi-modules'

/**
 * Project-trust preflight through the installed engine's own trust APIs (pi 1.1.0
 * `dist/core/trust-manager.d.ts`, exported from `dist/index.d.ts`).
 * RPC mode cannot show pi's trust prompt, so Vengeance asks before spawning and passes
 * `--approve` / `--no-approve`, saving "remember" answers in the same `trust.json`.
 */

/** The engine's trust store of `trust.json` in its agent dir. */
async function trustStore(override: string | null): Promise<InstanceType<TrustModule['ProjectTrustStore']>> {
  const [config, trust] = await Promise.all([piConfig(override), piTrust(override)])
  return new trust.ProjectTrustStore(config.getAgentDir())
}

/**
 * pi `SettingsManager.getDefaultProjectTrust()`: the agent dir's `defaultProjectTrust`, "ask" unless it is
 * "always" or "never". Read from the file, so the main process does not load the settings manager (pi-ai).
 */
function defaultProjectTrust(agentDir: string): ProjectTrustDefault {
  const value = readJsonFile(join(agentDir, 'settings.json')).data.defaultProjectTrust
  return value === 'always' || value === 'never' ? value : 'ask'
}

/** Mirrors TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES in pi's trust-manager (`.pi/<entry>`). */
const PROJECT_CONFIG_RESOURCES: ReadonlyArray<{ entry: string; kind: TrustResourceKind }> = [
  { entry: 'settings.json', kind: 'settings' },
  { entry: 'mcp.json', kind: 'mcp' },
  { entry: 'extensions', kind: 'extensions' },
  { entry: 'skills', kind: 'skills' },
  { entry: 'prompts', kind: 'prompts' },
  { entry: 'themes', kind: 'themes' },
  { entry: 'SYSTEM.md', kind: 'system-prompt' },
  { entry: 'APPEND_SYSTEM.md', kind: 'append-system-prompt' }
]

function entryCount(path: string): number | undefined {
  try {
    return statSync(path).isDirectory() ? readdirSync(path).length : undefined
  } catch {
    return undefined
  }
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  return (rel || '.').split('\\').join('/')
}

/** The protected resources present for `cwd` (same rules as `hasTrustRequiringProjectResources`). */
function findTrustResources(cwd: string): TrustResource[] {
  const root = resolve(cwd)
  const found: TrustResource[] = []
  for (const { entry, kind } of PROJECT_CONFIG_RESOURCES) {
    const path = join(root, '.pi', entry)
    if (existsSync(path)) found.push({ kind, path, label: displayPath(root, path), entries: entryCount(path) })
  }
  // Project `.agents/skills` in cwd or an ancestor; the user-level ~/.agents/skills is always trusted.
  const userSkills = join(resolve(process.env.HOME || homedir()), '.agents', 'skills')
  for (let dir = root; ; dir = dirname(dir)) {
    const skills = join(dir, '.agents', 'skills')
    if (skills.toLowerCase() !== userSkills.toLowerCase() && existsSync(skills)) {
      found.push({ kind: 'agents-skills', path: skills, label: displayPath(root, skills), entries: entryCount(skills) })
    }
    if (dirname(dir) === dir) break
  }
  return found
}

/** Mock workspaces are fake paths: present a plausible protected project instead of touching disk. */
function mockTrustResources(cwd: string): TrustResource[] {
  const at = (kind: TrustResourceKind, label: string, entries?: number): TrustResource => ({ kind, path: join(cwd, ...label.split('/')), label, entries })
  return [at('settings', '.pi/settings.json'), at('extensions', '.pi/extensions', 2), at('mcp', '.pi/mcp.json'), at('skills', '.pi/skills', 3), at('append-system-prompt', '.pi/APPEND_SYSTEM.md')]
}

/**
 * Project trust of `cwd` as decided from the agent dir `agentDir`: Vengeance's own unless given, such as a
 * spawn's whose launch env names another (`spawnAgentDir`). `engineDefault` is what an Engine with that
 * agent dir does without `--approve`/`--no-approve`.
 */
export async function trustPreflight(override: string | null, cwd: string, agentDir?: string): Promise<TrustPreflight> {
  const [dir, trust] = await Promise.all([
    agentDir ?? piConfig(override).then((config) => config.getAgentDir()),
    piTrust(override)
  ])
  const mockProject = env.mock && !existsSync(cwd)
  const resources = mockProject ? mockTrustResources(cwd) : findTrustResources(cwd)
  const requiresTrust = mockProject || trust.hasTrustRequiringProjectResources(cwd)
  const entry = new trust.ProjectTrustStore(dir).getEntry(cwd)
  // defaultProjectTrust can only be set in agent-dir settings; never read it from an untrusted project.
  const defaultTrust = defaultProjectTrust(dir)
  const saved = entry?.decision ?? null
  return {
    cwd,
    requiresTrust,
    resources,
    saved,
    savedPath: entry?.path ?? null,
    defaultTrust,
    engineDefault: !requiresTrust || (saved ?? defaultTrust === 'always'),
    needsDecision: requiresTrust && saved === null && defaultTrust === 'ask'
  }
}

/**
 * N9: the single write path for project trust (Trust dialog, `/trust`, Settings → Sessions & context).
 * `true`/`false` saves the decision for `cwd` itself (the workspace path as opened, never a mock stand-in);
 * `null` forgets the saved decision that applies to `cwd` — its own or the parent's it inherits — so the
 * folder really falls back to `defaultProjectTrust` afterwards.
 */
export async function setProjectTrust(override: string | null, cwd: string, decision: boolean | null): Promise<TrustPreflight> {
  const store = await trustStore(override)
  store.set(decision === null ? (store.getEntry(cwd)?.path ?? cwd) : cwd, decision)
  return trustPreflight(override, cwd)
}

/** Change or remove one saved `trust.json` entry by its exact folder (the saved-decisions list). */
export async function setTrustEntry(override: string | null, path: string, decision: boolean | null): Promise<void> {
  const store = await trustStore(override)
  store.set(path, decision)
}
