import { stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type {
  JsonObject,
  PackageInfo,
  PackageRunArgs,
  ResourceGroup,
  ResourceItem,
  ToggleResourceArgs
} from '@shared/api/settings'
import type { PrimeSettingsContext } from './configuration'
import { ENGINE_UPDATE_MESSAGE } from '../bundled'
import { capturePrimeResourceCommand, startPrimeCommand } from './configuration-cli'
import {
  jsonObject,
  primeSettingsPath,
  readPrimeJson,
  updatePrimeJson
} from './configuration-store'
import { getPrimeAgentDir, locatePrimeEngine } from './locate'

const RESOURCE_TYPES = ['skills', 'prompts', 'themes'] as const

function sourceOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const source = jsonObject(value)?.source
  return typeof source === 'string' ? source : undefined
}

function packageKind(source: string): PackageInfo['kind'] {
  if (source.startsWith('npm:')) return 'npm'
  if (/^(git:|https?:|git@)/.test(source)) return 'git'
  return 'local'
}

function packageName(source: string): string {
  if (source.startsWith('npm:')) return source.slice(4).replace(/@[^/]*$/, '')
  return basename(source.replace(/\.git(?:@.*)?$/, '')) || source
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function resourceGroups(value: unknown): ResourceGroup[] {
  if (!Array.isArray(value)) throw new Error('The engine did not return a resource list.')
  return value.map((raw) => {
    const group = jsonObject(raw)
    if (
      !group ||
      typeof group.key !== 'string' ||
      typeof group.label !== 'string' ||
      typeof group.source !== 'string' ||
      !['user', 'project', 'temporary'].includes(String(group.scope)) ||
      !['package', 'top-level'].includes(String(group.origin)) ||
      !Array.isArray(group.items)
    ) {
      throw new Error('The engine returned an invalid resource group.')
    }
    const items = group.items.map((rawItem): ResourceItem => {
      const item = jsonObject(rawItem)
      if (
        !item ||
        typeof item.path !== 'string' ||
        typeof item.displayName !== 'string' ||
        typeof item.enabled !== 'boolean' ||
        !RESOURCE_TYPES.includes(item.type as (typeof RESOURCE_TYPES)[number])
      ) {
        throw new Error('The engine returned an invalid resource.')
      }
      return {
        path: item.path,
        displayName: item.displayName,
        description: typeof item.description === 'string' ? item.description : undefined,
        enabled: item.enabled,
        type: item.type as ResourceItem['type'],
        scope: group.scope as ResourceItem['scope'],
        origin: group.origin as ResourceItem['origin'],
        source: group.source as string,
        baseDir: typeof item.baseDir === 'string' ? item.baseDir : undefined
      }
    })
    return {
      key: group.key,
      label: group.label,
      source: group.source,
      scope: group.scope as ResourceGroup['scope'],
      origin: group.origin as ResourceGroup['origin'],
      items
    }
  })
}

async function nativeResources(
  cwd: string | null,
  context: PrimeSettingsContext,
  toggle?: ToggleResourceArgs
): Promise<{ groups: ResourceGroup[]; packages: JsonObject[] }> {
  const mock = process.env.VENGEANCE_MOCK === '1' || process.env.VENGEANCE_MOCK === 'true'
  const location = mock ? null : await locatePrimeEngine(context.overridePath)
  const directory = resolve(cwd ?? getPrimeAgentDir())
  const response = await capturePrimeResourceCommand(
    {
      operation: toggle ? 'toggle' : 'list',
      cwd: directory,
      agentDir: getPrimeAgentDir(),
      bundledSkillsDir: location ? join(location.packageDir, 'skills') : undefined,
      item: toggle?.item,
      enabled: toggle?.enabled
    },
    cwd
  )
  const packages = (Array.isArray(response.packages) ? response.packages : [])
    .map(jsonObject)
    .filter((entry): entry is JsonObject => !!entry)
  return { groups: resourceGroups(response.groups), packages }
}

export async function listPrimePackages(
  cwd: string | null,
  context: PrimeSettingsContext
): Promise<PackageInfo[]> {
  const [global, project] = await Promise.all([
    readPrimeJson(primeSettingsPath('global', cwd)),
    cwd ? readPrimeJson(primeSettingsPath('project', cwd)) : null
  ])
  if (global.error || project?.error) throw new Error(global.error || project?.error)
  const hasPackages = [global, project].some(
    (state) => Array.isArray(state?.data.packages) && state.data.packages.length > 0
  )
  if (!hasPackages) return []
  const snapshot = await nativeResources(cwd, context)
  const packages: PackageInfo[] = []
  for (const entry of snapshot.packages) {
    if (typeof entry.source !== 'string') continue
    const source = entry.source
    const scope = entry.scope === 'project' ? 'project' : 'user'
    const settings = scope === 'project' ? project?.data : global.data
    const configured = Array.isArray(settings?.packages) ? settings.packages : []
    const filter = jsonObject(configured.find((candidate) => sourceOf(candidate) === source))
    const installedPath = typeof entry.installedPath === 'string' ? entry.installedPath : undefined
    const metadata = installedPath ? await readPrimeJson(join(installedPath, 'package.json')) : null
    const name = typeof metadata?.data.name === 'string' ? metadata.data.name : packageName(source)
    const resources = { extensions: 0, skills: 0, prompts: 0, themes: 0 }
    for (const group of snapshot.groups) {
      if (group.origin !== 'package' || group.source !== source || group.scope !== scope) continue
      for (const item of group.items) if (item.enabled) resources[item.type] += 1
    }
    packages.push({
      source,
      scope,
      kind: packageKind(source),
      name,
      displayName: name,
      installedPath,
      installed: installedPath ? await exists(installedPath) : false,
      version: typeof metadata?.data.version === 'string' ? metadata.data.version : undefined,
      description:
        typeof metadata?.data.description === 'string' ? metadata.data.description : undefined,
      homepage: typeof metadata?.data.homepage === 'string' ? metadata.data.homepage : undefined,
      filtered: entry.filtered === true,
      disabled:
        !!filter &&
        RESOURCE_TYPES.every((type) => Array.isArray(filter[type]) && !filter[type].length),
      awaitingTrust: false,
      resources
    })
  }
  return packages
}

export async function runPrimePackageAction(
  args: PackageRunArgs,
  context: PrimeSettingsContext
): Promise<string> {
  const source = args.source?.trim()
  if (source?.startsWith('-'))
    throw new Error('A package source cannot start with a command option.')
  if (args.action !== 'update-all' && !source) throw new Error('Choose a package source.')
  if (args.local && !args.cwd) throw new Error('Choose a workspace for a project package.')
  if (args.action === 'update' && ['self', 'pi', 'prime-agent'].includes(source ?? '')) {
    throw new Error(ENGINE_UPDATE_MESSAGE)
  }
  const command = ['package', args.action === 'update-all' ? 'update' : args.action]
  if (source) command.push(source)
  if (args.local && ['install', 'remove'].includes(args.action)) command.push('--local')
  return startPrimeCommand(
    command,
    args.cwd,
    context,
    'packages',
    args.local === true && ['install', 'remove'].includes(args.action)
  )
}

export async function setPrimePackageEnabled(
  cwd: string | null,
  packageRef: { source: string; scope: 'user' | 'project' },
  enabled: boolean,
  context: PrimeSettingsContext
): Promise<PackageInfo[]> {
  const scope = packageRef.scope === 'project' ? 'project' : 'global'
  await updatePrimeJson(primeSettingsPath(scope, cwd), (current) => {
    const packages = Array.isArray(current.packages) ? [...current.packages] : []
    const index = packages.findIndex((entry) => sourceOf(entry) === packageRef.source)
    if (index < 0) throw new Error('This package is no longer configured.')
    const entry = { ...(jsonObject(packages[index]) ?? { source: packageRef.source }) }
    for (const type of RESOURCE_TYPES) {
      if (enabled) delete entry[type]
      else entry[type] = []
    }
    packages[index] = Object.keys(entry).length === 1 ? packageRef.source : entry
    return { ...current, packages }
  })
  return listPrimePackages(cwd, context)
}

export async function listPrimeResources(
  cwd: string | null,
  context: PrimeSettingsContext
): Promise<ResourceGroup[]> {
  return (await nativeResources(cwd, context)).groups
}

export async function togglePrimeResource(
  args: ToggleResourceArgs,
  context: PrimeSettingsContext
): Promise<ResourceGroup[]> {
  if (args.item.type === 'extensions')
    throw new Error('Engine 2 does not load JavaScript extensions.')
  if (args.item.scope === 'temporary') throw new Error('Temporary resources cannot be saved here.')
  return (await nativeResources(args.cwd, context, args)).groups
}
