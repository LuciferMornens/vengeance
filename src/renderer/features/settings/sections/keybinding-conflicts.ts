import type { KeybindingAction } from '@shared/api/settings'

/** The engine's modifier order (docs/keybindings.md: `ctrl+shift+alt+x`); any order means the same key. */
const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'super']

/** Key names the engine accepts under two spellings. */
const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter' }

/** One spelling per key: `alt+shift+n` and `Shift+Alt+N` are both `shift+alt+n`. */
export function normalizeKey(combo: string): string {
  const lower = combo.trim().toLowerCase()
  // `+` is itself a valid key (`ctrl++`).
  const plusKey = lower === '+' || lower.endsWith('++')
  const parts = (plusKey ? lower.slice(0, -1) : lower).split('+').filter(Boolean)
  const key = plusKey ? '+' : (parts.pop() ?? '')
  const modifiers = [
    ...MODIFIER_ORDER.filter((modifier) => parts.includes(modifier)),
    ...parts.filter((part) => !MODIFIER_ORDER.includes(part)).sort()
  ]
  return [...modifiers, KEY_ALIASES[key] ?? key].join('+')
}

/**
 * For each action, the other actions that answer to one of its keys because of a user assignment (keybindings.json).
 * Keys that the engine's own defaults already share between two actions are intentional (they act in different
 * contexts) and are not conflicts.
 */
export function keyConflicts(
  actions: KeybindingAction[],
  bindings: Record<string, string[]>
): Map<string, string[]> {
  const defaults = new Map(
    actions.map((action) => [action.id, new Set(action.defaults.map(normalizeKey))])
  )
  const users = new Map<string, string[]>()
  for (const action of actions) {
    for (const key of new Set((bindings[action.id] ?? action.defaults).map(normalizeKey)))
      users.set(key, [...(users.get(key) ?? []), action.id])
  }
  const conflicts = new Map<string, string[]>()
  for (const [key, ids] of users) {
    for (const id of ids) {
      const others = ids.filter(
        (other) => other !== id && !(defaults.get(id)?.has(key) && defaults.get(other)?.has(key))
      )
      if (others.length > 0)
        conflicts.set(id, [...new Set([...(conflicts.get(id) ?? []), ...others])])
    }
  }
  return conflicts
}
