import { useMemo, useState } from 'react'
import { Keyboard, Search } from 'lucide-react'
import { Input, Kbd } from '../../../ui'
import { useShortcutGroups } from '../../palette/shortcuts'
import { Group, Note, Row } from '../layout'

/** App keyboard shortcuts — the same list as the shortcuts sheet, searchable. */

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {keys.map((combo, i) => (
        <span key={combo} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-2xs text-fg-3">or</span>}
          <span className="flex items-center gap-1">
            {combo.split(' ').map((step, j) => (
              <Kbd key={j} combo={step} />
            ))}
          </span>
        </span>
      ))}
    </span>
  )
}

export function ShortcutsSection() {
  const shortcutGroups = useShortcutGroups()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return shortcutGroups
    return shortcutGroups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            i.label.toLowerCase().includes(needle) ||
            g.title.toLowerCase().includes(needle) ||
            i.keys.some((k) => k.includes(needle))
        )
      }))
      .filter((g) => g.items.length > 0)
  }, [shortcutGroups, query])

  return (
    <>
      <div className="relative mb-5 w-72">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter shortcuts"
          className="h-8 bg-surface-2 pl-8 text-sm"
        />
      </div>
      {groups.length === 0 && (
        <Group>
          <Note icon={<Keyboard />}>No shortcuts match “{query}”.</Note>
        </Group>
      )}
      {groups.map((group) => (
        <Group key={group.title} title={group.title}>
          {group.items.map((item) => (
            <Row
              key={`${item.label}-${item.keys.join()}`}
              settingKey={`shortcut.${group.title}.${item.label}`}
              label={item.label}
            >
              <Keys keys={item.keys} />
            </Row>
          ))}
        </Group>
      ))}
      <p className="mt-2 px-1 text-sm text-fg-3">
        Every action is also available from the command palette.
      </p>
    </>
  )
}
