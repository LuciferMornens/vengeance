import { useMemo } from 'react'
import { useActions } from '../../lib/actions'

/**
 * The one list of app shortcuts: every registered action with a hotkey (grouped by its palette group) plus
 * the keys that belong to no action (composer editing, the agent queue, dialogs). Feeds the shortcuts sheet.
 */

export interface Shortcut {
  label: string
  /** Alternatives, each a combo like `mod+k` or a sequence like `escape escape`. */
  keys: string[]
}

export interface ShortcutGroup {
  title: string
  items: Shortcut[]
}

/** Keys handled inside a surface rather than by an action. */
const SURFACE_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Composer',
    items: [
      { label: 'Send', keys: ['enter'] },
      { label: 'New line', keys: ['shift+enter'] },
      { label: 'Previous / next prompt', keys: ['↑', '↓'] },
      { label: 'Commands, prompts and skills', keys: ['/'] },
      { label: 'Add command arguments', keys: ['tab'] },
      { label: 'Mention a file', keys: ['@'] },
      { label: 'Shell command (in context)', keys: ['!'] },
      { label: 'Shell command (out of context)', keys: ['!!'] },
      { label: 'Paste image', keys: ['mod+v'] },
      { label: 'Session tree or fork (empty editor)', keys: ['escape escape'] }
    ]
  },
  {
    title: 'While the agent works',
    items: [
      { label: 'Steer', keys: ['enter'] },
      { label: 'Queue a follow-up', keys: ['alt+enter'] },
      { label: 'Edit queued messages', keys: ['alt+↑'] },
      { label: 'Stop', keys: ['escape escape'] }
    ]
  },
  {
    title: 'Palette and dialogs',
    items: [
      { label: 'Command palette', keys: ['mod+k'] },
      { label: 'Navigate', keys: ['↑', '↓'] },
      { label: 'Choose', keys: ['enter'] },
      { label: 'Run a command with arguments', keys: ['tab'] },
      { label: 'Back to the previous page', keys: ['backspace'] },
      { label: 'Quick pick an option', keys: ['1'] },
      { label: 'Save in editor dialogs', keys: ['mod+enter'] },
      { label: 'Close', keys: ['escape'] }
    ]
  }
]

/** Action groups first (in this order), then the surface groups. */
const GROUP_ORDER = ['General', 'View', 'Session', 'Model', 'Help']

export function useShortcutGroups(): ShortcutGroup[] {
  const actions = useActions()
  return useMemo(() => {
    const byGroup = new Map<string, Shortcut[]>()
    const seen = new Set<string>()
    for (const action of actions) {
      if (!action.hotkey) continue
      const key = `${action.hotkey}\u0000${action.title}`
      if (seen.has(key)) continue
      seen.add(key)
      byGroup.set(action.group, [...(byGroup.get(action.group) ?? []), { label: action.title, keys: [action.hotkey] }])
    }
    const rank = (title: string) => (GROUP_ORDER.includes(title) ? GROUP_ORDER.indexOf(title) : GROUP_ORDER.length)
    const actionGroups = [...byGroup].map(([title, items]) => ({ title, items })).sort((a, b) => rank(a.title) - rank(b.title))
    return [...actionGroups, ...SURFACE_SHORTCUTS]
  }, [actions])
}
