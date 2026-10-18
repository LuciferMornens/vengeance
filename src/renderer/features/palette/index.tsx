/**
 * Command palette (Ctrl+K): fuzzy everything — recents and suggestions, actions, engine commands (with
 * arguments), open sessions, models and thinking level (nested pages), settings sections and individual
 * settings, workspaces — plus the keyboard shortcut sheet.
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { AnimatePresence, motion } from 'motion/react'
import { Dialog as RDialog } from 'radix-ui'
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  ChevronRight,
  Cpu,
  Keyboard,
  Play,
  SearchX
} from 'lucide-react'
import type { RpcSlashCommand } from '@shared/engine-types'
import { runAction, useActions, type AppAction } from '../../lib/actions'
import { cn } from '../../lib/cn'
import { useHotkey } from '../../lib/keybindings'
import { lazyWithPreload } from '../../lib/lazy-with-preload'
import { spring } from '../../lib/motion'
import { selectActiveAgent, useAgents } from '../../store/agents'
import { selectWorkspaceEngine, useApp } from '../../store/app'
import { Kbd, ListRowContent, Mark } from '../../ui'
import { COMPOSER_ACTIONS, CYCLE_MODEL_BACKWARD_HOTKEY, focusComposer } from '../composer'
import { openModelPicker } from '../composer/model-pill'
import { activeAgentId, supportsAgentCommand } from '../composer/operations'
import { useFallbackActions } from './fallback-actions'
import { runCommand, settingsEntries, useRootEntries, type PaletteEntry } from './entries'
import { groupClass, ModelsPage, paletteRowClass, ThinkingPage } from './model-pages'
import {
  openCommandArgs,
  openPalette,
  openShortcutsSheet,
  paletteRecents,
  rememberPaletteItem,
  usePalette,
  type PalettePage
} from './store'

export { openPalette, openShortcutsSheet } from './store'
export { revealSetting } from './settings-sections'

const shortcutsSheet = lazyWithPreload(() => import('./ShortcutsSheet').then((m) => m.ShortcutsSheet))
const ShortcutsSheet = shortcutsSheet.Component

/** Ctrl+L: the active session's footer picker (SPEC §9.1); the palette's Models page when no composer is mounted. */
function openModelPick(): void {
  const id = activeAgentId()
  if (id && !supportsAgentCommand(id, 'set_model')) return
  if (!id || !openModelPicker(id)) openPalette('models')
}

/** Palette-owned actions; fallbacks so lanes that own an id (settings, chat…) take precedence. */
const PALETTE_ACTIONS: AppAction[] = [
  // Listed through the palette's own nested-page entries; registered so other features can runAction() them.
  {
    id: 'model.pick',
    title: 'Change model',
    group: 'Model',
    hotkey: 'mod+l',
    icon: Cpu,
    when: () => false,
    run: openModelPick
  },
  {
    id: 'thinking.pick',
    title: 'Thinking level',
    group: 'Model',
    icon: Brain,
    when: () => false,
    run: () => openPalette('thinking')
  },
  {
    id: 'help.shortcuts',
    title: 'Show keyboard shortcuts',
    group: 'Help',
    hotkey: 'mod+/',
    keywords: ['hotkeys', 'keys', 'cheat sheet', '/hotkeys'],
    icon: Keyboard,
    run: openShortcutsSheet
  }
]

/** Shown under "Suggested" on the empty root page (when available and not already a recent). */
const SUGGESTED = [
  'action:session.new',
  'page:models',
  'action:session.compact',
  'action:session.newWithOptions',
  'action:workspace.open',
  'action:settings.open'
]

/** Root group order; unknown groups follow in registration order. */
const GROUP_ORDER = [
  'Open sessions',
  'Session',
  'Commands',
  'Model',
  'General',
  'View',
  'Workspaces',
  'Settings',
  'Help'
]

const PAGE_TITLE: Record<PalettePage, string> = {
  root: '',
  models: 'Models',
  thinking: 'Thinking level',
  args: 'Arguments'
}
const PAGE_PLACEHOLDER: Record<Exclude<PalettePage, 'args'>, string> = {
  root: 'Search or run a command…',
  models: 'Search models…',
  thinking: 'Choose a thinking level…'
}

const itemClass = paletteRowClass({ density: 'list' })

/** "compaction.enabled", "steeringMode": the user is searching by setting key, so show keys on setting rows. */
function looksLikeKey(search: string): boolean {
  const q = search.trim()
  return q.length > 0 && !/\s/.test(q) && (/[._]/.test(q) || /[a-z][A-Z]/.test(q))
}

function Item({
  entry,
  value,
  onSelect,
  showTechnical
}: {
  entry: PaletteEntry
  value?: string
  onSelect(entry: PaletteEntry): void
  showTechnical?: boolean
}) {
  return (
    <Command.Item
      value={value ?? entry.id}
      keywords={[entry.title, entry.subtitle ?? '', ...(entry.keywords ?? [])]}
      onSelect={() => onSelect(entry)}
      className={itemClass}
    >
      <ListRowContent
        icon={entry.icon}
        iconTile
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            {/* The subtitle grows from a zero basis, so it truncates first; the title shrinks once the subtitle is down to 48px. */}
            <span className="min-w-0 truncate text-fg">{entry.title}</span>
            {entry.subtitle && (
              <span className="min-w-12 flex-1 truncate text-sm font-normal text-fg-3">
                {entry.subtitle}
              </span>
            )}
          </span>
        }
        trailing={
          entry.trailing || entry.hotkey || entry.page || (showTechnical && entry.technical) ? (
            <>
              {showTechnical && entry.technical && (
                <span className="max-w-40 truncate font-mono text-2xs text-fg-3">
                  {entry.technical}
                </span>
              )}
              {entry.trailing}
              {entry.hotkey && <Kbd combo={entry.hotkey} size="xs" />}
              {entry.page && <ChevronRight className="size-4 text-fg-3" />}
            </>
          ) : undefined
        }
      />
    </Command.Item>
  )
}

/**
 * Predictable palette ranking: every query word must appear in the title (prefix > word start > anywhere)
 * or, weaker, in the subtitle/keywords. `keywords[0]` is the item title.
 */
function paletteFilter(_value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) return 1
  const [titleRaw = '', ...rest] = keywords ?? []
  const title = titleRaw.toLowerCase()
  if (title.startsWith(query)) return 1
  const other = rest.join(' ').toLowerCase()
  const words = query.split(/\s+/)
  let total = 0
  for (const word of words) {
    const at = title.indexOf(word)
    if (at === 0) total += 0.9
    else if (at > 0 && /[\s/:._-]/.test(title[at - 1]!)) total += 0.75
    else if (at > 0) total += 0.5
    else if (other.includes(word)) total += 0.2
    else return 0
  }
  return total / words.length
}

function groupEntries(entries: PaletteEntry[]): Array<[string, PaletteEntry[]]> {
  const groups = new Map<string, PaletteEntry[]>()
  for (const entry of entries) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry])
  const rank = (group: string) =>
    GROUP_ORDER.includes(group) ? GROUP_ORDER.indexOf(group) : GROUP_ORDER.length
  return [...groups].sort((a, b) => rank(a[0]) - rank(b[0]))
}

/** Collects arguments for an extension command; Enter runs `/name <args>`. */
function ArgsPage({ args, onRun }: { args: string; onRun(): void }) {
  const command = usePalette((s) => s.argsCommand)
  if (!command) return null
  return (
    <Command.Group heading="Run with arguments" className={groupClass}>
      <Command.Item value="run-with-args" onSelect={onRun} className={itemClass}>
        <ListRowContent
          icon={<Play />}
          iconTile
          title={
            <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-sm">
              <span className="shrink-0 text-fg">/{command.name}</span>
              <span className={cn('truncate', args.trim() ? 'text-fg' : 'text-fg-3')}>
                {args.trim() || 'no arguments'}
              </span>
            </span>
          }
          subtitle={command.description}
          trailing={<Kbd combo="enter" size="xs" />}
        />
      </Command.Item>
    </Command.Group>
  )
}

function EmptyResults({ search }: { search: string }) {
  return (
    <Command.Empty>
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <div className="mb-4 flex size-11 items-center justify-center rounded-card bg-surface-3 text-fg-3 shadow-elev-1">
          <SearchX className="size-5" />
        </div>
        <div className="heading text-title text-fg">No results for “{search}”</div>
        <div className="mt-1.5 max-w-xs text-sm leading-relaxed text-fg-3">
          Try another word, or type / in the composer to browse every command, prompt and skill.
        </div>
      </div>
    </Command.Empty>
  )
}

/** Horizontal center of the titlebar search pill; the window's center on a first run, which has none. */
function pillCenterX(): number {
  const pill = document.querySelector('[data-titlebar-search]')?.getBoundingClientRect()
  return pill ? pill.left + pill.width / 2 : window.innerWidth / 2
}

const PALETTE_W = 640

function paletteLeft(): number {
  return Math.min(Math.max(16, pillCenterX() - PALETTE_W / 2), window.innerWidth - PALETTE_W - 16)
}

/** The open palette's content. Mounted only while open, so nothing is rebuilt while it is closed (B5). */
function PaletteContent({ onClose }: { onClose(): void }) {
  const page = usePalette((s) => s.page)
  const setPage = usePalette((s) => s.setPage)
  const argsCommand = usePalette((s) => s.argsCommand)
  const actions = useActions()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [recentIds] = useState(paletteRecents)
  const settingsEngine = useApp((state) =>
    selectWorkspaceEngine(state, state.prefs.activeWorkspace)
  )

  const entries = useRootEntries(actions)
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const trimmedLen = search.trim().length
  const searching = trimmedLen > 0
  const includeSettings = trimmedLen >= 2
  const { recents, suggested, groupedRest } = useMemo(() => {
    const rec =
      page === 'root' && !searching ? recentIds.flatMap((id) => byId.get(id) ?? []).slice(0, 5) : []
    const sug =
      page === 'root' && !searching
        ? SUGGESTED.filter((id) => !recentIds.includes(id)).flatMap((id) => byId.get(id) ?? [])
        : []
    const pinned = new Set([...rec, ...sug].map((e) => e.id))
    const rest = searching
      ? [...entries, ...(includeSettings ? settingsEntries(settingsEngine) : [])]
      : entries.filter((e) => !pinned.has(e.id))
    return { recents: rec, suggested: sug, groupedRest: groupEntries(rest) }
  }, [page, searching, includeSettings, recentIds, byId, entries, settingsEngine])
  const selectedEntry = byId.get(selected.replace(/^(recent|suggested):/, ''))

  // Every page starts empty, except the one opened with a query (`/model son`): that query is used once.
  useEffect(() => {
    const { initialQuery } = usePalette.getState()
    setSearch(initialQuery)
    if (initialQuery) usePalette.setState({ initialQuery: '' })
    inputRef.current?.focus()
  }, [page])

  /** Highlight an item once it is mounted (cmdk selects the first item when a list renders). */
  const highlight = useCallback((value: string) => {
    requestAnimationFrame(() => setSelected(value))
  }, [])

  const select = (entry: PaletteEntry) => {
    rememberPaletteItem(entry.id)
    if (entry.page) {
      setPage(entry.page)
      return
    }
    onClose()
    entry.run?.()
  }

  const withArgs = (command: RpcSlashCommand) => {
    rememberPaletteItem(`command:${command.source}:${command.name}`)
    openCommandArgs(command)
  }

  const runWithArgs = () => {
    if (!argsCommand) return
    onClose()
    runCommand(argsCommand, search)
  }

  const showTechnical = looksLikeKey(search)
  const renderList = (list: PaletteEntry[], prefix?: string) =>
    list.map((entry) => (
      <Item
        key={prefix ? `${prefix}:${entry.id}` : entry.id}
        value={prefix ? `${prefix}:${entry.id}` : undefined}
        entry={entry}
        onSelect={select}
        showTechnical={showTechnical}
      />
    ))

  return (
    <>
      <RDialog.Title className="sr-only">Command palette</RDialog.Title>
      <RDialog.Description className="sr-only">Search or run a command</RDialog.Description>
      <Command
        loop
        label="Command palette"
        filter={paletteFilter}
        shouldFilter={page !== 'args'}
        value={selected}
        onValueChange={setSelected}
      >
        <div className="flex h-[52px] items-center gap-2.5 border-b border-hairline px-4">
          <AnimatePresence mode="popLayout" initial={false}>
            {page !== 'root' ? (
              <motion.button
                key="crumb"
                type="button"
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -6 }}
                transition={spring.snappy}
                onClick={() => setPage('root')}
                className="pressable inline-flex h-6 shrink-0 items-center gap-1 rounded-sm bg-hover pr-2 pl-1.5 text-xs font-medium text-fg-2 shadow-[inset_0_0_0_1px_var(--hairline)] hover:text-fg"
              >
                <ArrowLeft className="size-3" />
                {page === 'args' && argsCommand ? `/${argsCommand.name}` : PAGE_TITLE[page]}
              </motion.button>
            ) : (
              <motion.span
                key="mark"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex shrink-0"
              >
                <Mark size={16} />
              </motion.span>
            )}
          </AnimatePresence>
          <Command.Input
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !search && page !== 'root') {
                event.preventDefault()
                setPage('root')
              } else if (event.key === 'Tab' && page === 'root' && selectedEntry?.command) {
                event.preventDefault()
                withArgs(selectedEntry.command)
              }
            }}
            placeholder={
              page === 'args'
                ? argsCommand
                  ? `Arguments for /${argsCommand.name}…`
                  : ''
                : PAGE_PLACEHOLDER[page]
            }
            className={cn(
              'h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-3 focus-visible:outline-none',
              page === 'args' && 'font-mono text-md'
            )}
          />
          <Kbd combo="escape" size="xs" />
        </div>
        <Command.List className="max-h-[min(56vh,460px)] overflow-y-auto scroll-py-2 p-1.5 [&_[cmdk-list-sizer]]:transition-[height] [&_[cmdk-list-sizer]]:duration-[var(--dur-fast)]">
          {page === 'root' && (
            <>
              <EmptyResults search={search} />
              {recents.length > 0 && (
                <Command.Group heading="Recent" className={groupClass}>
                  {renderList(recents, 'recent')}
                </Command.Group>
              )}
              {suggested.length > 0 && (
                <Command.Group heading="Suggested" className={groupClass}>
                  {renderList(suggested, 'suggested')}
                </Command.Group>
              )}
              {groupedRest.map(([group, list]) => (
                <Command.Group key={group} heading={group} className={groupClass}>
                  {renderList(list)}
                </Command.Group>
              ))}
            </>
          )}
          {page === 'models' && (
            <>
              <EmptyResults search={search} />
              <ModelsPage onDone={onClose} highlight={highlight} filtered={searching} />
            </>
          )}
          {page === 'thinking' && <ThinkingPage onDone={onClose} highlight={highlight} />}
          {page === 'args' && <ArgsPage args={search} onRun={runWithArgs} />}
        </Command.List>
        <div className="flex h-9 items-center gap-4 border-t border-hairline-soft px-4 text-2xs text-fg-3">
          <span className="inline-flex items-center gap-1.5">
            <Kbd combo="↑+↓" size="xs" /> navigate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd combo="enter" size="xs" />{' '}
            {page === 'args'
              ? 'run'
              : page === 'root'
                ? selectedEntry?.command
                  ? 'run'
                  : 'open'
                : 'choose'}
          </span>
          {page === 'root' && selectedEntry?.command && (
            <button
              type="button"
              onClick={() => withArgs(selectedEntry.command!)}
              className="inline-flex items-center gap-1.5 rounded-xs px-1 py-0.5 hover:bg-hover hover:text-fg-2"
            >
              <Kbd combo="tab" size="xs" /> run with arguments
              <ArrowRight className="size-3" />
            </button>
          )}
          {page !== 'root' && (
            <span className="inline-flex items-center gap-1.5">
              <Kbd combo="backspace" size="xs" /> back
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={openShortcutsSheet}
            className="inline-flex items-center gap-1.5 rounded-xs px-1 py-0.5 hover:bg-hover hover:text-fg-2"
          >
            <Keyboard className="size-3" /> Shortcuts <Kbd combo="mod+/" size="xs" />
          </button>
        </div>
      </Command>
    </>
  )
}

/** Where focus was when the palette opened (captured synchronously, before the palette's input takes it). */
let focusBeforeOpen: HTMLElement | null = null
useApp.subscribe((state, previous) => {
  if (!state.ui.paletteOpen || previous.ui.paletteOpen) return
  const active = document.activeElement
  focusBeforeOpen = active instanceof HTMLElement && active !== document.body ? active : null
})

/**
 * Closing the palette returns focus where it was, else to the composer, unless the chosen entry moved it
 * (a dialog it opened, a new session's composer). Radix would restore the palette's own input, which is gone.
 */
function restoreFocus(palette: HTMLElement | null): void {
  const active = document.activeElement
  const target = focusBeforeOpen
  focusBeforeOpen = null
  if (active && active !== document.body && !palette?.contains(active)) return
  if (target?.isConnected && !target.closest('[inert]')) target.focus()
  else focusComposer()
}

/** True when the user has text selected (window selection or inside a focused field): Ctrl+X then cuts. */
function hasTextSelection(): boolean {
  const el = document.activeElement
  if (
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
    el.selectionStart !== el.selectionEnd
  )
    return true
  return (window.getSelection()?.toString() ?? '') !== ''
}

export function CommandPalette() {
  const open = useApp((s) => s.ui.paletteOpen)
  const setOpen = useApp((s) => s.setPaletteOpen)
  const page = usePalette((s) => s.page)
  const setPage = usePalette((s) => s.setPage)
  const [left, setLeft] = useState(paletteLeft)
  // Mounted from the first open on; it reads its open state from the palette store.
  const shortcutsLoaded = shortcutsSheet.useLoaded(usePalette((s) => s.shortcutsOpen))

  useLayoutEffect(() => {
    if (!open) return
    const update = () => setLeft(paletteLeft())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])

  useFallbackActions(COMPOSER_ACTIONS)
  useFallbackActions(PALETTE_ACTIONS)
  useHotkey('mod+l', () => runAction('model.pick'))
  useHotkey('mod+p', () => runAction('model.cycle'))
  useHotkey(CYCLE_MODEL_BACKWARD_HOTKEY, () => runAction('model.cycleBackward'))
  useHotkey('mod+x', () => {
    const agent = selectActiveAgent(useAgents.getState())
    if (hasTextSelection() || agent?.status !== 'ready' || open) return false
    runAction('session.copyLast')
  })
  useHotkey('mod+/', () => {
    const { shortcutsOpen: isOpen, setShortcutsOpen } = usePalette.getState()
    if (isOpen) setShortcutsOpen(false)
    else openShortcutsSheet()
  })

  // Reset to the root page once the close animation has played.
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => {
      if (!useApp.getState().ui.paletteOpen) setPage('root')
    }, 220)
    return () => clearTimeout(timer)
  }, [open, setPage])

  return (
    <>
      <RDialog.Root open={open} onOpenChange={setOpen}>
        <AnimatePresence>
          {open && (
            <RDialog.Portal forceMount>
              {/* A plain backdrop, not RDialog.Overlay: see ModalBackdrop in ui/Dialog.tsx. */}
              <motion.div
                data-modal-backdrop
                aria-hidden
                className="fixed inset-0 z-[var(--z-modal)] bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
              />
              <RDialog.Content
                asChild
                forceMount
                onOpenAutoFocus={(event) => event.preventDefault()}
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  restoreFocus(
                    event.currentTarget instanceof HTMLElement ? event.currentTarget : null
                  )
                }}
                onEscapeKeyDown={(event) => {
                  if (page !== 'root') {
                    event.preventDefault()
                    setPage('root')
                  }
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    y: -4,
                    scale: 0.98,
                    transition: { duration: 0.12, ease: 'easeInOut' }
                  }}
                  transition={spring.snappy}
                  style={{
                    left,
                    width: PALETTE_W
                  }}
                  className="fixed top-[calc(var(--titlebar-h)+8px)] z-[var(--z-modal)] max-w-[calc(100vw-32px)] origin-top overflow-hidden rounded-lg bg-[var(--glass-strong)] shadow-elev-3 backdrop-blur-2xl backdrop-saturate-150"
                >
                  <PaletteContent onClose={() => setOpen(false)} />
                </motion.div>
              </RDialog.Content>
            </RDialog.Portal>
          )}
        </AnimatePresence>
      </RDialog.Root>
      {shortcutsLoaded && (
        <Suspense fallback={null}>
          <ShortcutsSheet />
        </Suspense>
      )}
    </>
  )
}
