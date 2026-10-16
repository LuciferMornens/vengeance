import { join } from 'node:path'
import type { KeybindingAction, KeybindingsState } from '@shared/api/settings'
import { sdkHostCall } from '../../engine/sdk-host/client'
import { agentDir } from './agent-dir'
import { readJsonFile, serializeJson, writeFileAtomic } from './json-file'

/** Terminal keybindings (`<agentDir>/keybindings.json`, pi docs/keybindings.md). */

function keybindingsPath(): string {
  return join(agentDir(), 'keybindings.json')
}

function groupOf(id: string): string {
  if (id.startsWith('tui.editor.')) return 'Editor'
  if (id.startsWith('tui.input.')) return 'Input'
  if (id.startsWith('tui.select.')) return 'Lists'
  if (id.startsWith('tui.altScreen.')) return 'Fullscreen'
  if (id.startsWith('app.session.')) return 'Sessions'
  if (id.startsWith('app.tree.')) return 'Tree navigation'
  if (id.startsWith('app.models.')) return 'Scoped models selector'
  if (id.startsWith('app.model.') || id.startsWith('app.thinking.')) return 'Models & thinking'
  if (id.startsWith('app.message.') || id.startsWith('app.tools.')) return 'Display & queue'
  return 'Application'
}

function keyList(value: unknown): string[] | null {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return null
}

export async function readKeybindings(override: string | null): Promise<KeybindingsState> {
  const path = keybindingsPath()
  const file = readJsonFile(path)
  const registry = await sdkHostCall(override, 'keybindings', { config: file.error ? null : file.data })
  const actions: KeybindingAction[] = registry.actions.map((action) => ({
    id: action.id,
    description: action.description,
    defaults: [...(keyList(action.defaultKeys) ?? [])],
    group: groupOf(action.id)
  }))
  const bindings: Record<string, string[]> = {}
  for (const [id, value] of Object.entries(registry.config ?? {})) {
    const keys = keyList(value)
    if (keys) bindings[id] = keys
  }
  return { path, exists: file.exists, error: file.error, actions, bindings }
}

const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'super'])
const NAMED_KEYS = new Set(
  ['escape', 'esc', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'clear', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right'].concat(
    Array.from({ length: 12 }, (_, i) => `f${i + 1}`)
  )
)
const SYMBOLS = new Set([...'`-=[]\\;\',./!@#$%^&*()_+|~{}:<>?'])

/** `modifier+…+key` per pi docs/keybindings.md "Key syntax". */
function isValidKey(combo: string): boolean {
  // `ctrl++` style: the last segment may itself be "+".
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  const key = parts.pop()
  if (!key) return false
  if (!parts.every((part) => MODIFIERS.has(part.toLowerCase()))) return false
  if (new Set(parts.map((p) => p.toLowerCase())).size !== parts.length) return false
  return /^[a-z0-9]$/i.test(key) || NAMED_KEYS.has(key.toLowerCase()) || SYMBOLS.has(key)
}

export async function writeKeybindings(override: string | null, bindings: Record<string, string[]>): Promise<KeybindingsState> {
  const current = await readKeybindings(override)
  if (current.error) throw new Error(`keybindings.json is not valid JSON (${current.error}). Fix it in a text editor first.`)
  const invalid = Object.values(bindings)
    .flat()
    .filter((combo) => !isValidKey(combo))
  if (invalid.length) throw new Error(`Not a valid key: ${invalid.join(', ')}`)
  // Same order pi writes: known actions first (registry order), then unknown ids alphabetically.
  const order = current.actions.map((a) => a.id)
  const ids = Object.keys(bindings).sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia === -1 && ib === -1) return a.localeCompare(b)
    if (ia === -1) return 1
    if (ib === -1) return -1
    return ia - ib
  })
  const data = Object.fromEntries(ids.map((id) => [id, bindings[id]!.length === 1 ? bindings[id]![0]! : bindings[id]!]))
  await writeFileAtomic(keybindingsPath(), serializeJson(data))
  return readKeybindings(override)
}
