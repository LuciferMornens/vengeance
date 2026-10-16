import type { EngineId } from '@shared/api/engine'
import type {
  JsonObject,
  JsonValue,
  SettingPath,
  SettingsScope,
  SettingsSnapshot
} from '@shared/api/settings'
import { SETTINGS, type SettingDef } from '@shared/api/settings-schema'
import { PRIME_SETTINGS_GROUPS } from '../engines/prime-schema'

type SettingChange = Pick<
  SettingDef,
  'key' | 'alsoKeys' | 'section' | 'live' | 'gui' | 'alsoInSessions' | 'writtenBySessions'
> & { effect?: 'restart' | 'none' }

// Native sessions save these defaults themselves; transport is read for each provider request.
const PRIME_NONSTARTUP_KEYS = new Set([
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'defaultServiceTier',
  'recentModels',
  'transport',
  'telemetry.noticeShown',
  'warnings.anthropicExtraUsage',
  'updateChannel'
])
const PRIME_SETTINGS: SettingChange[] = PRIME_SETTINGS_GROUPS.flatMap((group) =>
  group.fields.map((field) => ({
    key: field.key,
    section: group.section,
    effect: PRIME_NONSTARTUP_KEYS.has(field.key) ? 'none' : undefined
  }))
)

export function findEngineSetting(key: string, engine: EngineId): SettingChange | undefined {
  return (engine === 'prime' ? PRIME_SETTINGS : SETTINGS).find(
    (field) => field.key === key || field.alsoKeys?.includes(key)
  )
}

/** Pure helpers over settings.json data: key paths, lookups, and what a change means for open engines. */

export function splitKey(key: string | SettingPath): SettingPath {
  return Array.isArray(key) ? key : key.split('.')
}

export function getAt(root: JsonObject | undefined, path: SettingPath): JsonValue | undefined {
  let current: JsonValue | undefined = root
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = current[part]
  }
  return current
}

/** What changing a setting takes: terminal-only and GUI-honored settings need no engine restart. */
export function settingEffect(def: SettingChange): 'restart' | 'none' {
  if (def.effect) return def.effect
  if (def.gui) return 'none'
  return def.section === 'terminal' && !def.alsoInSessions ? 'none' : 'restart'
}

/**
 * Schema settings whose value differs between two snapshots, as engines read them: the global file, plus the active
 * project's file while that folder is trusted (compared only when both snapshots are of the same folder).
 */
export function changedSettings(
  previous: SettingsSnapshot,
  next: SettingsSnapshot,
  engine: EngineId = 'pi',
  scope?: SettingsScope
): SettingChange[] {
  const sameProject = previous.project?.cwd === next.project?.cwd
  const projectBefore =
    sameProject && previous.project?.trust.effective ? previous.project.data : undefined
  const projectAfter = sameProject && next.project?.trust.effective ? next.project.data : undefined
  const valueAt = (data: JsonObject | undefined, path: SettingPath) => {
    const value = getAt(data, path)
    // Prime saves its typed Option fields as null; both null and absent mean inherit/default.
    return engine === 'prime' && value === null ? undefined : value
  }
  const differs = (
    before: JsonObject | undefined,
    after: JsonObject | undefined,
    path: SettingPath
  ) => !equalSettingsValue(valueAt(before, path), valueAt(after, path))
  return (engine === 'prime' ? PRIME_SETTINGS : SETTINGS).filter((def) =>
    [def.key, ...(def.alsoKeys ?? [])].some((key) => {
      const path = splitKey(key)
      return (
        (scope !== 'project' && differs(previous.global.data, next.global.data, path)) ||
        (scope !== 'global' && differs(projectBefore, projectAfter, path))
      )
    })
  )
}

/**
 * Whether an edit made outside Vengeance needs open engines restarted. Live settings apply over RPC instead, and keys
 * that sessions save themselves would otherwise ask for a restart after every model switch.
 */
export function restartsAfterOutsideEdit(def: SettingChange): boolean {
  return !def.live && !def.writtenBySessions && settingEffect(def) === 'restart'
}

function equalSettingsValue(before: JsonValue | undefined, after: JsonValue | undefined): boolean {
  if (before === after) return true
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
  if (Array.isArray(before) || Array.isArray(after)) {
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((value, index) => equalSettingsValue(value, after[index]))
    )
  }
  const keys = Object.keys(before)
  return (
    keys.length === Object.keys(after).length &&
    keys.every((key) => Object.hasOwn(after, key) && equalSettingsValue(before[key], after[key]))
  )
}
