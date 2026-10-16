import { INTERNAL_SETTING_KEYS, SETTING_CONTAINERS, SETTINGS, THINKING_LEVEL_OPTIONS, type SettingDef } from '@shared/api/settings-schema'

type SettingCustomEditor = Extract<SettingDef['control'], { kind: 'custom' }>['editor']
import type { JsonObject, JsonValue, SettingsScope, ValidationIssue } from '@shared/api/settings'

/** Structural validation of settings.json against the schema. Unknown keys are preserved (info only). */

function getPath(root: JsonObject, key: string): JsonValue | undefined {
  let current: JsonValue | undefined = root
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = current[part]
  }
  return current
}

const THINKING = new Set(THINKING_LEVEL_OPTIONS.map((o) => o.value))

function isStringArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function checkValue(def: SettingDef, value: JsonValue): string | null {
  const control = def.control
  switch (control.kind) {
    case 'switch':
      return typeof value === 'boolean' ? null : 'must be true or false'
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      if (control.integer && !Number.isInteger(value)) return 'must be a whole number'
      if (control.min !== undefined && value < control.min) return `must be at least ${control.min}`
      if (control.max !== undefined && value > control.max) return `must be at most ${control.max}`
      return null
    }
    case 'auto-number':
      if (value === 'auto') return null
      if (typeof value !== 'number' || !Number.isInteger(value) || value < control.min || value > control.max) return `must be "auto" or a whole number from ${control.min} to ${control.max}`
      return null
    case 'text':
      return typeof value === 'string' ? null : 'must be a string'
    case 'list':
      return isStringArray(value) ? null : 'must be a list of strings'
    case 'choice':
      if (control.freeText && typeof value === 'string') return null
      return control.options.some((o) => o.value === value) ? null : `must be one of ${control.options.map((o) => JSON.stringify(o.value)).join(', ')}`
    case 'custom':
      return checkCustom(control.editor, value)
  }
}

function checkCustom(editor: SettingCustomEditor, value: JsonValue): string | null {
  switch (editor) {
    case 'default-model':
      return typeof value === 'string' ? null : 'must be a string'
    case 'enabled-models':
    case 'default-tools':
      return isStringArray(value) ? null : 'must be a list of strings'
    case 'model-thinking-levels':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must map "provider/model" to a thinking level'
      for (const [model, level] of Object.entries(value)) {
        if (typeof level !== 'string' || !THINKING.has(level)) return `"${model}" has an invalid thinking level`
      }
      return null
    case 'compaction-overrides':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must map "provider/model" to token settings'
      for (const [model, override] of Object.entries(value)) {
        if (!override || typeof override !== 'object' || Array.isArray(override)) return `"${model}" must be an object`
        for (const [field, tokens] of Object.entries(override)) {
          if (field !== 'reserveTokens' && field !== 'keepRecentTokens') return `"${model}" has unknown field "${field}"`
          if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) return `"${model}.${field}" must be a non-negative whole number`
        }
      }
      return null
    case 'packages':
      if (!Array.isArray(value)) return 'must be a list'
      for (const entry of value) {
        if (typeof entry === 'string') continue
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.source !== 'string') return 'entries must be a source string or an object with "source"'
      }
      return null
  }
}

const TOP_LEVEL = new Set([
  ...SETTINGS.flatMap((s) => [s.key, ...(s.alsoKeys ?? [])]).map((k) => k.split('.')[0]!),
  ...INTERNAL_SETTING_KEYS
])

export function validateSettings(data: JsonObject, scope: SettingsScope): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const def of SETTINGS) {
    for (const key of [def.key, ...(def.alsoKeys ?? [])]) {
      const value = getPath(data, key)
      if (value === undefined) continue
      const problem = key === def.key ? checkValue(def, value) : typeof value === 'string' ? null : 'must be a string'
      if (problem) issues.push({ severity: 'error', key, message: `${key} ${problem}.` })
      if (def.globalOnly && scope === 'project') issues.push({ severity: 'warning', key, message: `${key} is only read from global settings; the project value is ignored.` })
    }
  }
  for (const container of SETTING_CONTAINERS) {
    const value = getPath(data, container)
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      issues.push({ severity: 'error', key: container, message: `${container} must be an object.` })
    }
  }
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL.has(key)) issues.push({ severity: 'info', key, message: `${key} is not a known engine setting; it will be preserved.` })
  }
  return issues
}

export function parseSettingsText(text: string): { data?: JsonObject; issue?: ValidationIssue } {
  if (!text.trim()) return { data: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { issue: { severity: 'error', key: '', message: 'Settings must be a JSON object.' } }
    // SAFETY: JSON.parse output checked to be a plain object above.
    return { data: parsed as JsonObject }
  } catch (error) {
    return { issue: { severity: 'error', key: '', message: `Invalid JSON: ${(error as Error).message}` } }
  }
}
