import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { JsonObject, JsonValue, PackageInfo, PackageRunArgs, ProcessDoneEvent, ProcessLogEvent, ResourceGroup, ResourceItem, ResourceType, ToggleResourceArgs } from '@shared/api/settings'
import { isTarballSource, TARBALL_HINT } from '@shared/package-sources'
import { sdkHostCall } from '../../engine/sdk-host/client'
import type { SdkHostResult } from '../../engine/sdk-host/protocol'
import { env } from '../../env'
import { trustPreflight } from '../launch/trust'
import { agentDir, projectRoot, writeSeedFile } from './agent-dir'
import { readJsonFile } from './json-file'
import { compactPackageEntry, isDisabledPackageEntry, packageDisplayName, packageEntrySource, packageKind, packageLabel, setPackageEntryEnabled } from './package-source'
import { simulatePiCli, streamPiCli, type StreamedRun } from './pi-cli'
import type { ResolvedPaths, ResolvedResource } from './pi-modules'
import { resourceDisplayName, resourceGroupLabel } from './resource-labels'
import { readScopeSettings, updateSettingsObject } from './settings-store'

/** Packages (`pi install|remove|update|list`) and resources (`pi config`) through the engine's PackageManager. */

const RESOURCE_TYPES: ResourceType[] = ['extensions', 'skills', 'prompts', 'themes']

/** N15: like `pi list` / `pi config`, project packages and resources load only when the project is trusted. */
async function projectTrustedFor(override: string | null, cwd: string | null): Promise<boolean> {
  return cwd !== null && (await trustPreflight(override, cwd)).engineDefault
}

type ListedPackages = SdkHostResult<'packages'>

/** The engine's configured packages and resolved resources for `cwd`, nothing installed (the SDK host). */
function configuredPackages(override: string | null, cwd: string | null, projectTrusted: boolean): Promise<ListedPackages> {
  return sdkHostCall(override, 'packages', { cwd: cwd ? projectRoot(cwd) : agentDir(), agentDir: agentDir(), projectTrusted })
}

/** Resolve resources without installing anything that is missing. */
async function resolvePaths(override: string | null, cwd: string | null): Promise<ResolvedPaths> {
  return (await configuredPackages(override, cwd, await projectTrustedFor(override, cwd))).resolved
}

function packageJson(dir: string | undefined): { version?: string; description?: string; homepage?: string } {
  if (!dir) return {}
  const data = readJsonFile(join(dir, 'package.json')).data
  const repo = data.repository
  const repoUrl = typeof repo === 'string' ? repo : repo && typeof repo === 'object' && !Array.isArray(repo) && typeof repo.url === 'string' ? repo.url : undefined
  const homepage = typeof data.homepage === 'string' ? data.homepage : repoUrl?.replace(/^git\+/, '').replace(/\.git$/, '')
  return {
    version: typeof data.version === 'string' ? data.version : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    homepage
  }
}

function rawEntry(data: JsonObject, source: string): JsonValue | undefined {
  const list = Array.isArray(data.packages) ? data.packages : []
  return list.find((p) => packageEntrySource(p) === source)
}

/**
 * Every configured package, loaded or not: project packages of an untrusted folder are listed too (read
 * from the project's settings as if trusted) and marked `awaitingTrust`, so an install never disappears.
 */
export async function listPackages(override: string | null, cwd: string | null): Promise<PackageInfo[]> {
  const projectTrusted = await projectTrustedFor(override, cwd)
  const [loaded, pending] = await Promise.all([
    configuredPackages(override, cwd, projectTrusted),
    cwd !== null && !projectTrusted ? configuredPackages(override, cwd, true) : null
  ])
  const listed = [
    ...loaded.configured.map((pkg) => ({ pkg, resolved: loaded.resolved, awaitingTrust: false })),
    ...(pending?.configured.filter((pkg) => pkg.scope === 'project').map((pkg) => ({ pkg, resolved: pending.resolved, awaitingTrust: true })) ?? [])
  ]
  const global = readScopeSettings('global', null)
  const project = cwd ? readScopeSettings('project', cwd) : {}
  return listed.map(({ pkg, resolved, awaitingTrust }) => {
    const meta = packageJson(pkg.installedPath)
    const counts = { extensions: 0, skills: 0, prompts: 0, themes: 0 }
    for (const type of RESOURCE_TYPES) {
      counts[type] = resolved[type].filter((r) => r.enabled && r.metadata.origin === 'package' && r.metadata.source === pkg.source && r.metadata.scope === pkg.scope).length
    }
    return {
      source: pkg.source,
      scope: pkg.scope,
      kind: packageKind(pkg.source),
      name: packageDisplayName(pkg.source),
      displayName: packageLabel(pkg.source),
      installedPath: pkg.installedPath,
      installed: !!pkg.installedPath && existsSync(pkg.installedPath),
      version: meta.version,
      description: meta.description,
      homepage: meta.homepage,
      filtered: pkg.filtered,
      disabled: isDisabledPackageEntry(rawEntry(pkg.scope === 'project' ? project : global, pkg.source)),
      awaitingTrust,
      resources: counts
    }
  })
}

/** Disable or enable a whole package; its per-resource filters survive (`setPackageEntryEnabled`). */
export async function setPackageEnabled(override: string | null, cwd: string | null, pkg: { source: string; scope: 'user' | 'project' }, enabled: boolean): Promise<PackageInfo[]> {
  await updateSettingsObject(override, pkg.scope === 'project' ? 'project' : 'global', cwd, (current) => {
    const list = Array.isArray(current.packages) ? [...current.packages] : []
    const index = list.findIndex((p) => packageEntrySource(p) === pkg.source)
    if (index === -1) throw new Error(`${pkg.source} is not configured in ${pkg.scope === 'project' ? 'project' : 'global'} settings.`)
    list[index] = setPackageEntryEnabled(list[index]!, enabled)
    return { ...current, packages: list }
  })
  return listPackages(override, cwd)
}

/**
 * `pi remove` matches local packages by absolute path, resolved against the CLI's working folder. A project
 * entry is relative to `.pi/` (where its settings file lives) and the CLI runs in the project root, so the
 * stored source has to be resolved first.
 */
function removeSource(args: PackageRunArgs): string {
  const source = args.source!
  if (!args.local || !args.cwd || packageKind(source) !== 'local') return source
  return resolve(projectRoot(args.cwd), '.pi', source)
}

function cliArgs(args: PackageRunArgs): string[] {
  const local = args.local ? ['-l', '--approve'] : []
  switch (args.action) {
    case 'install':
      return ['install', args.source!, ...local]
    case 'remove':
      return ['remove', removeSource(args), ...local]
    case 'update':
      return ['update', args.source!, ...(args.local ? ['--approve'] : [])]
    case 'update-all':
      return ['update', '--extensions']
  }
}

function mockSteps(args: PackageRunArgs): Array<[number, string]> {
  const name = args.source ? packageDisplayName(args.source) : 'packages'
  if (args.action === 'remove') return [[240, `Removing ${args.source}...\n`], [380, `\nremoved 3 packages, and audited 41 packages in 1s\n`], [160, `\x1b[32mRemoved ${args.source}\x1b[39m\n`]]
  if (args.action === 'update' || args.action === 'update-all') {
    return [[260, `Checking ${name} for updates...\n`], [520, `\x1b[2mnpm view ${name} version\x1b[22m\n`], [420, `Updating ${name}...\n`], [700, `\nchanged 4 packages, and audited 52 packages in 2s\n`], [180, `\x1b[32mUpdated ${name}\x1b[39m\n`]]
  }
  return [
    [220, `Installing ${args.source}...\n`],
    [380, `\x1b[2mnpm install ${name} --prefix ${join(agentDir(), 'npm')} --legacy-peer-deps\x1b[22m\n`],
    [640, `npm \x1b[33mWARN\x1b[39m deprecated inflight@1.0.6: This module is not supported, and leaks memory.\n`],
    [520, `\nadded 18 packages, and audited 59 packages in 3s\n`],
    [220, `\n9 packages are looking for funding\n  run \`npm fund\` for details\n`],
    [260, `\nfound \x1b[32m\x1b[1m0\x1b[22m\x1b[39m vulnerabilities\n`],
    [200, `\x1b[32mInstalled ${args.source}\x1b[39m\n`]
  ]
}

/** Mock mode: reflect a finished run in the seeded settings so the list updates like a real install. */
async function applyMockRun(override: string | null, args: PackageRunArgs): Promise<void> {
  if (!args.source || (args.action !== 'install' && args.action !== 'remove')) return
  const source = args.source
  await updateSettingsObject(override, args.local ? 'project' : 'global', args.cwd, (current) => {
    const list = (Array.isArray(current.packages) ? current.packages : []).filter((p) => (typeof p === 'string' ? p : (p as JsonObject).source) !== source)
    return { ...current, packages: args.action === 'install' ? [...list, source] : list }
  })
  if (args.action === 'install' && packageKind(source) === 'npm') {
    const name = packageDisplayName(source)
    const dir = join(args.local && args.cwd ? join(projectRoot(args.cwd), '.pi') : agentDir(), 'npm', 'node_modules', ...name.split('/'))
    writeSeedFile(join(dir, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', description: 'Freshly installed package', keywords: ['pi-package'] }, null, 2)}\n`)
    writeSeedFile(join(dir, 'extensions', 'index.ts'), 'export default function (pi) {}\n')
  }
}

export async function runPackageAction(
  override: string | null,
  args: PackageRunArgs,
  onLog: (event: ProcessLogEvent) => void,
  onDone: (event: ProcessDoneEvent) => void
): Promise<StreamedRun> {
  if (args.action !== 'update-all' && !args.source?.trim()) throw new Error('Enter a package source.')
  if (args.action === 'install' && isTarballSource(args.source!)) throw new Error(TARBALL_HINT)
  const cliCwd = args.local && args.cwd ? projectRoot(args.cwd) : agentDir()
  if (env.mock) return simulatePiCli(cliArgs(args), mockSteps(args), { onLog, onDone, onComplete: () => applyMockRun(override, args) })
  return streamPiCli(override, cliArgs(args), { cwd: cliCwd, onLog, onDone })
}

// ─── Resources (pi config) ───────────────────────────────────────────────

function readHead(path: string): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(2048)
      const bytes = readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytes).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function frontmatterDescription(path: string): string | undefined {
  const head = readHead(path)
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)
  const line = match?.[1]?.split(/\r?\n/).find((l) => l.startsWith('description:'))
  return line?.slice('description:'.length).trim().replace(/^["']|["']$/g, '') || undefined
}

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  mcp: 'Model Context Protocol servers, /mcp and MCP tools',
  'llama.cpp': 'Local GGUF models through the llama.cpp router',
  codemode: 'The codemode tool: scripts that call other tools',
  'tool-search': 'The tool_search tool for deferred tools'
}

function describe(resource: ResolvedResource, type: ResourceType): string | undefined {
  if (resource.metadata.source === 'builtin') return BUILTIN_DESCRIPTIONS[resource.path.replace(/^builtin:/, '')]
  if (type === 'skills' || type === 'prompts') return frontmatterDescription(resource.path)
  return undefined
}

export async function listResources(override: string | null, cwd: string | null): Promise<ResourceGroup[]> {
  const resolved = await resolvePaths(override, cwd)
  const groups = new Map<string, ResourceGroup>()
  for (const type of RESOURCE_TYPES) {
    for (const resource of resolved[type]) {
      const { metadata } = resource
      const key = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.origin === 'package' ? '' : (metadata.baseDir ?? '')}`
      let group = groups.get(key)
      if (!group) {
        group = { key, label: resourceGroupLabel(resource), scope: metadata.scope, origin: metadata.origin, source: metadata.source, items: [] }
        groups.set(key, group)
      }
      const item: ResourceItem = {
        path: resource.path,
        type,
        displayName: resourceDisplayName(resource, type),
        description: describe(resource, type),
        enabled: resource.enabled,
        scope: metadata.scope,
        origin: metadata.origin,
        source: metadata.source,
        baseDir: metadata.baseDir
      }
      group.items.push(item)
    }
  }
  const order = (g: ResourceGroup) => (g.origin === 'package' ? 0 : g.source === 'builtin' ? 2 : 1) * 10 + (g.scope === 'user' ? 0 : 1)
  return [...groups.values()].sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label))
}

function topLevelBaseDir(scope: ResourceItem['scope'], cwd: string | null): string {
  return scope === 'project' && cwd ? join(projectRoot(cwd), '.pi') : agentDir()
}

function stripPrefix(entry: string): string {
  return /^[!+-]/.test(entry) ? entry.slice(1) : entry
}

/** Mirrors pi's ConfigSelector toggle: write `+pattern` / `-pattern` into the owning scope's settings. */
export async function toggleResource(override: string | null, args: ToggleResourceArgs): Promise<ResourceGroup[]> {
  const { item, enabled, cwd } = args
  if (item.scope === 'temporary') throw new Error('Temporary resources cannot be configured.')
  const scope = item.scope === 'project' ? 'project' : 'global'
  if (item.origin === 'top-level') {
    const pattern = item.source === 'builtin' ? item.path : relative(item.baseDir ?? topLevelBaseDir(item.scope, cwd), item.path)
    await updateSettingsObject(override, scope, cwd, (current) => {
      const list = (Array.isArray(current[item.type]) ? (current[item.type] as JsonValue[]) : []).filter((p): p is string => typeof p === 'string')
      const updated = list.filter((p) => stripPrefix(p) !== pattern)
      updated.push(`${enabled ? '+' : '-'}${pattern}`)
      return { ...current, [item.type]: updated }
    })
  } else {
    const pattern = relative(item.baseDir ?? dirname(item.path), item.path)
    await updateSettingsObject(override, scope, cwd, (current) => {
      const packages = Array.isArray(current.packages) ? [...current.packages] : []
      const index = packages.findIndex((p) => packageEntrySource(p) === item.source)
      if (index === -1) throw new Error(`${item.source} is not configured in ${scope} settings.`)
      const entry = packages[index]!
      const object: JsonObject = typeof entry === 'string' ? { source: entry } : { ...(entry as JsonObject) }
      const list = (Array.isArray(object[item.type]) ? (object[item.type] as JsonValue[]) : []).filter((p): p is string => typeof p === 'string')
      const updated = list.filter((p) => stripPrefix(p) !== pattern)
      updated.push(`${enabled ? '+' : '-'}${pattern}`)
      object[item.type] = updated
      packages[index] = compactPackageEntry(object)
      return { ...current, packages }
    })
  }
  return listResources(override, cwd)
}
