import { basename } from 'node:path'
import type { JsonObject, JsonValue, PackageInfo } from '@shared/api/settings'
import { friendlyExtensionName } from '@shared/display-names'
import { isTarballSource } from '@shared/package-sources'

/**
 * Package sources as written in settings (`npm:…`, `git:…`, local paths). Technical names identify a
 * package (npm registry lookups, changelog links, flag ownership); `packageLabel` is the UI label.
 */

export function packageKind(source: string): PackageInfo['kind'] {
  if (source.startsWith('npm:')) return 'npm'
  if (/^(git:|https?:\/\/|ssh:\/\/|git@)/.test(source)) return 'git'
  return 'local'
}

/** Technical name: npm package name (with scope), git `host/owner/repo`, or the local folder name. */
export function packageDisplayName(source: string): string {
  const kind = packageKind(source)
  if (kind === 'npm') {
    const spec = source.slice(4)
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
    return at > 0 ? spec.slice(0, at) : spec
  }
  if (kind === 'git') {
    const path = source.replace(/^git:/, '').replace(/^(https?|ssh):\/\//, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '')
    return path.replace(/@[^/]*$/, '')
  }
  const folder = basename(source.replace(/[\\/]+$/, '')) || source
  // `npm pack` names a tarball `<name>-<version>.tgz`.
  return isTarballSource(source) ? folder.replace(/(-\d+\.\d+\.\d+[^\\/]*)?\.(tgz|tar\.gz)$/i, '') : folder
}

/** Human label for the UI: `npm:@scope/pi-web-access@1.2` → "Web access". */
export function packageLabel(source: string): string {
  return friendlyExtensionName(packageDisplayName(source))
}

const RESOURCE_FILTER_TYPES = ['extensions', 'skills', 'prompts', 'themes'] as const

/**
 * Vengeance-owned key of a disabled package entry: the resource filters it had before. The Engine ignores
 * unknown keys and keeps them when it rewrites settings.
 */
const SAVED_FILTERS_KEY = 'vengeanceSavedFilters'

export function packageEntrySource(entry: JsonValue | undefined): string | undefined {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  return typeof entry.source === 'string' ? entry.source : undefined
}

function packageEntryObject(entry: JsonValue): JsonObject {
  return typeof entry === 'string' ? { source: entry } : { ...(entry as JsonObject) }
}

/** The object form when it carries anything besides `source`, the bare source string otherwise. */
export function compactPackageEntry(entry: JsonObject): JsonValue {
  return Object.keys(entry).every((key) => key === 'source') ? (entry.source as string) : entry
}

/** Every resource type filtered to `[]`. */
export function isDisabledPackageEntry(entry: JsonValue | undefined): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  return RESOURCE_FILTER_TYPES.every((type) => Array.isArray(entry[type]) && (entry[type] as JsonValue[]).length === 0)
}

/**
 * Disable = filter every resource type to `[]` and keep the earlier filters under SAVED_FILTERS_KEY;
 * enable = put those filters back. The user's per-resource choices survive the round trip.
 */
export function setPackageEntryEnabled(entry: JsonValue, enabled: boolean): JsonValue {
  const object = packageEntryObject(entry)
  if (enabled) {
    const saved = object[SAVED_FILTERS_KEY]
    const filters: JsonObject = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    delete object[SAVED_FILTERS_KEY]
    for (const type of RESOURCE_FILTER_TYPES) {
      if (filters[type] === undefined) delete object[type]
      else object[type] = filters[type]
    }
    return compactPackageEntry(object)
  }
  // An entry that is already disabled keeps the filters saved when it was disabled first.
  if (!isDisabledPackageEntry(object)) {
    const present = RESOURCE_FILTER_TYPES.filter((type) => object[type] !== undefined)
    object[SAVED_FILTERS_KEY] = Object.fromEntries(present.map((type) => [type, object[type]!]))
  }
  for (const type of RESOURCE_FILTER_TYPES) object[type] = []
  return object
}
