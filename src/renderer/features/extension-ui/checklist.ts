import { friendlyExtensionName } from '@shared/display-names'
import { stripAnsi } from '../../lib/ansi'

/**
 * Todo-style extension widgets (`setWidget` lines such as pi-todos / rpiv-todo overlays): an optional heading line
 * plus one glyph-led line per task. Recognized lists render as a native checklist instead of terminal text.
 */

export type ChecklistState = 'done' | 'active' | 'open' | 'cancelled'

export interface ChecklistItem {
  text: string
  state: ChecklistState
}

export interface Checklist {
  title: string | null
  done: number
  total: number
  items: ChecklistItem[]
}

// rpiv-todo: ○ pending · ◐ in progress · ● / ✓ completed · ✗ / ⊘ deleted; markdown boxes `[ ]` `[x]` `[~]`.
const GLYPH_STATE: Record<string, ChecklistState> = {
  '✓': 'done',
  '✔': 'done',
  '☑': 'done',
  '✅': 'done',
  '●': 'done',
  '[x]': 'done',
  '[X]': 'done',
  '◐': 'active',
  '◑': 'active',
  '◒': 'active',
  '◓': 'active',
  '◉': 'active',
  '▶': 'active',
  '►': 'active',
  '▸': 'active',
  '[~]': 'active',
  '[-]': 'active',
  '○': 'open',
  '◯': 'open',
  '☐': 'open',
  '□': 'open',
  '▢': 'open',
  '◻': 'open',
  '[ ]': 'open',
  '✗': 'cancelled',
  '✘': 'cancelled',
  '⊘': 'cancelled'
}

const ITEM = /^\s*(?:[-*]\s+)?(\[[ xX~-]\]|[✓✔☑✅●◐◑◒◓◉▶►▸○◯☐□▢◻✗✘⊘])\s+(.+?)\s*$/u
/** SGR 9 (strikethrough) anywhere on the raw line marks the task done. */
const STRIKE = /\u001b\[(?:\d+;)*9(?:;\d+)*m/
/** Trailing "1/3", "(1 of 3)", "1/3 done" of a heading. */
const COUNT = /\s*\(?(\d+)\s*(?:\/|of)\s*(\d+)\)?(?:\s+done)?\s*$/i

/** The checklist in a widget's lines, or null when they are not a plain todo list (those render as text). */
export function parseChecklist(lines: string[]): Checklist | null {
  const rows = lines.filter((line) => stripAnsi(line).trim() !== '')
  let title: string | null = null
  let headerCount: { done: number; total: number } | null = null
  const items: ChecklistItem[] = []
  for (const [index, raw] of rows.entries()) {
    const line = stripAnsi(raw)
    const match = ITEM.exec(line)
    const state = match ? GLYPH_STATE[match[1]!] : undefined
    if (match && state) {
      items.push({ text: match[2]!, state: STRIKE.test(raw) && state !== 'cancelled' ? 'done' : state })
    } else if (index === 0) {
      const count = COUNT.exec(line)
      if (count) headerCount = { done: Number(count[1]), total: Number(count[2]) }
      title = (count ? line.slice(0, count.index) : line).trim() || null
    } else {
      return null
    }
  }
  if (items.length === 0) return null
  const counted = items.filter((item) => item.state !== 'cancelled')
  const done = counted.filter((item) => item.state === 'done').length
  return { title, done: headerCount?.done ?? done, total: headerCount?.total ?? counted.length, items }
}

/** "pi-todos" / "rpiv-todos" / "todo" → "todo": matches a status key with the widget that shows the same data. */
export function extensionKeyName(key: string): string {
  return friendlyExtensionName(key).toLowerCase().replace(/s$/, '')
}
