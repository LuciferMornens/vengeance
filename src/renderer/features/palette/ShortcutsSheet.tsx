import { useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Search, X } from 'lucide-react'
import { shortcutMatches } from '../../lib/keybindings'
import { fadeUp, stagger } from '../../lib/motion'
import { IconButton, Input, Kbd, Sheet } from '../../ui'
import { useShortcutGroups, type ShortcutGroup } from './shortcuts'
import { usePalette } from './store'

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

function Group({ group }: { group: ShortcutGroup }) {
  return (
    <motion.section variants={fadeUp} className="mb-7 break-inside-avoid">
      <h3 className="mb-1.5 text-xs font-medium text-fg-3">{group.title}</h3>
      <div className="overflow-hidden rounded-card bg-surface-2 px-3.5 shadow-elev-1">
        {group.items.map((item) => (
          <div key={`${item.label}-${item.keys.join()}`} className="flex h-9 items-center justify-between gap-4 border-b border-hairline-soft last:border-b-0">
            <span className="truncate text-ui text-fg-2">{item.label}</span>
            <Keys keys={item.keys} />
          </div>
        ))}
      </div>
    </motion.section>
  )
}

/** Every app shortcut on one page (registered action hotkeys + surface keys), searchable. Lazy-loaded. */
export function ShortcutsSheet() {
  const open = usePalette((s) => s.shortcutsOpen)
  const setOpen = usePalette((s) => s.setShortcutsOpen)
  const all = useShortcutGroups()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all
      .map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q) || g.title.toLowerCase().includes(q) || i.keys.some((k) => shortcutMatches(k, q))) }))
      .filter((g) => g.items.length > 0)
  }, [all, query])

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      title="Keyboard shortcuts"
      side="full"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-[clamp(32px,6vw,72px)] pt-10 pb-36">
          <div className="mb-8 flex items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="heading text-xl text-fg">Keyboard shortcuts</h1>
              <p className="mt-1 text-ui text-fg-3">Everything in Vengeance is a keystroke away. Every action is also in the command palette.</p>
            </div>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a shortcut" leading={<Search />} className="w-60" aria-label="Find a shortcut" />
            <IconButton label="Close" hotkey="escape" size="md" onClick={() => setOpen(false)}>
              <X />
            </IconButton>
          </div>
          {groups.length === 0 && <div className="py-16 text-center text-ui text-fg-3">No shortcut matches “{query}”</div>}
          <motion.div key={query ? 'search' : 'all'} variants={stagger(0.03)} initial="hidden" animate="show" className="columns-2 gap-8">
            {groups.map((group) => (
              <Group key={group.title} group={group} />
            ))}
          </motion.div>
        </div>
      </div>
    </Sheet>
  )
}
