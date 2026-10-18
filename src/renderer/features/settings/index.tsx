/**
 * Settings feature: every engine setting (pi settings.md), providers & accounts, custom models, packages,
 * resources, MCP, sessions, shortcuts, engine and raw JSON — plus Vengeance's own app preferences.
 * The shell mounts <SettingsSheet/> inside its full-window Sheet frame.
 *
 * For other features: `useEffectiveSetting(key, cwd?)` / `getEffectiveSetting(key, cwd?)` return the value
 * an engine started in that folder sees (trusted project over global over schema default) and update live,
 * e.g. `useEffectiveSetting('hideThinkingBlock')`, `'doubleEscapeAction'`, `'treeFilterMode'`, `'markdown.mermaid'`.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { FileWarning, FolderGit2, Globe, Search, ShieldAlert, X } from 'lucide-react'
import { ENGINE_LABELS } from '@shared/api/engine'
import { SETTINGS } from '@shared/api/settings-schema'
import { cn } from '../../lib/cn'
import { useHotkey } from '../../lib/keybindings'
import { basename } from '../../lib/format'
import { invoke } from './ipc'
import { spring } from '../../lib/motion'
import { selectWorkspaceEngine, useApp } from '../../store/app'
import { Button, IconButton, Kbd, SegmentedControl, Spinner, Tooltip, toast } from '../../ui'
import './actions'
import './motion'
import { Callout, SectionHeader, SheetHeader } from './layout'
import { EnginePicker } from '../engines/EnginePicker'
import { useEngineCapabilities } from '../engines/registry'
import { SearchView } from './search'
import { findSection, getSections } from './sections'
import { afterTrustChange } from './sections/sessions'
import { useSettings } from './store'
import { getAt, splitKey } from './values'

export { getEffectiveSetting, useEffectiveSetting } from './effective'

function ScopeSwitch() {
  const scope = useSettings((s) => s.scope)
  const setScope = useSettings((s) => s.setScope)
  const project = useSettings((s) => s.snapshot?.project)
  const control = (
    <SegmentedControl
      className={cn(!project && 'pointer-events-none opacity-50')}
      value={scope}
      onValueChange={setScope}
      segments={[
        { value: 'global', label: 'Global', icon: <Globe /> },
        {
          value: 'project',
          label: project ? basename(project.cwd) : 'Project',
          icon: <FolderGit2 />
        }
      ]}
    />
  )
  if (project) return control
  return (
    <Tooltip content="Open a project to edit its settings">
      <span>{control}</span>
    </Tooltip>
  )
}

function TrustNotice() {
  const engine = useSettings((state) => state.engine)
  const project = useSettings((s) => s.snapshot?.project)
  const scope = useSettings((s) => s.scope)
  const replaceSnapshot = useSettings((s) => s.replaceSnapshot)
  if (engine !== 'pi' || scope !== 'project' || !project || project.trust.effective) return null
  const trust = async () => {
    try {
      replaceSnapshot(await invoke('settings:set-trust', project.cwd, true), engine)
      afterTrustChange(project.cwd, engine)
    } catch (error) {
      toast({
        level: 'error',
        title: 'Could not trust folder',
        description: (error as Error).message
      })
    }
  }
  return (
    <Callout
      tone="warning"
      icon={<ShieldAlert />}
      title="This folder isn’t trusted"
      action={
        <Button size="sm" variant="secondary" onClick={() => void trust()}>
          Trust folder
        </Button>
      }
    >
      Project settings are saved but sessions ignore them until you trust {basename(project.cwd)}.
    </Callout>
  )
}

/**
 * A settings.json that no longer parses: every control falls back to defaults and writes are refused, so say so once
 * for the whole sheet and point to the one place that can fix it.
 */
function InvalidFileNotice() {
  const snapshot = useSettings((s) => s.snapshot)
  const setScope = useSettings((s) => s.setScope)
  const openSettings = useApp((s) => s.openSettings)
  const broken = snapshot?.global.error ? 'global' : snapshot?.project?.error ? 'project' : null
  if (!broken) return null
  const fix = () => {
    setScope(broken)
    openSettings('raw')
  }
  return (
    <Callout
      tone="warning"
      icon={<FileWarning />}
      title={`${broken === 'global' ? 'Global' : 'Project'} settings.json is not valid JSON`}
      action={
        <Button size="sm" variant="secondary" onClick={fix}>
          Fix in Raw JSON
        </Button>
      }
    >
      Settings here show their defaults and changes can’t be saved until the file is fixed.
    </Callout>
  )
}

/**
 * The shown section or search results. New content slides in at once: an exit for the old content would hold the
 * new content back until it ends. Keyed by engine and workspace (and mounted after the loading spinner), it shows
 * its first content without the slide.
 */
function SectionTransition({ contentKey, children }: { contentKey: string; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => setShown(true), [])
  return (
    <motion.div
      key={contentKey}
      initial={shown ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** Sections whose project file overrides at least one of their keys. */
function useOverriddenSections(): Set<string> {
  const project = useSettings((s) => s.snapshot?.project?.data)
  return useMemo(() => {
    const result = new Set<string>()
    if (!project) return result
    for (const def of SETTINGS)
      if (getAt(project, splitKey(def.key)) !== undefined) result.add(def.section)
    return result
  }, [project])
}

export function SettingsSheet() {
  const cwd = useApp((state) => state.prefs.activeWorkspace)
  const defaultEngine = useApp((state) => selectWorkspaceEngine(state, state.prefs.activeWorkspace))
  const engine = useSettings((state) => state.engine)
  const selectDefaultEngine = useSettings((state) => state.selectDefaultEngine)
  const error = useSettings((state) => state.error)
  const capabilities = useEngineCapabilities(engine)
  const sectionId = useApp((s) => s.ui.settingsSection)
  const openSettings = useApp((s) => s.openSettings)
  const close = useApp((s) => s.closeSettings)
  const sections = getSections(engine, capabilities)
  const section = findSection(sectionId, engine, capabilities)
  const snapshot = useSettings((s) => s.snapshot)
  const scope = useSettings((s) => s.scope)
  const query = useSettings((s) => s.query)
  const setQuery = useSettings((s) => s.setQuery)
  const load = useSettings((s) => s.load)
  const overridden = useOverriddenSections()
  const searchRef = useRef<HTMLInputElement>(null)
  const navListRef = useRef<HTMLDivElement>(null)
  const activeNavRef = useRef<HTMLDivElement>(null)
  const activeGroupRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const searching = query.trim().length > 0
  const activeGroupId = sections
    .slice(0, sections.findIndex((s) => s.id === section.id) + 1)
    .findLast((s) => s.groupLabel)?.id
  const placeKey = JSON.stringify([engine, cwd])
  const contentKey = JSON.stringify([
    placeKey,
    searching ? 'search' : section.id,
    section.scoped ? scope : ''
  ])

  useEffect(() => {
    void load()
    return () => {
      setQuery('')
      void invoke('settings:release').catch(() => undefined)
    }
  }, [load, setQuery])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [engine, cwd, section.id, searching])
  // Keep the active nav item in view: a section opened from elsewhere (palette, search, a link) can sit outside the
  // visible part of a short window, the isolated-config footer shortens the list once the snapshot loads, and the
  // window can shrink while Settings is open. The item comes back under its group heading when both fit, otherwise
  // 8px clear of the edge it crossed (`top` and `bottom` are those two scroll offsets, relative to the list, which is
  // positioned).
  useEffect(() => {
    const list = navListRef.current
    if (!list) return
    const keepInView = () => {
      const item = activeNavRef.current
      if (!item) return
      const top = item.offsetTop - 8
      const bottom = item.offsetTop + item.offsetHeight + 8 - list.clientHeight
      const heading = activeGroupRef.current?.offsetTop ?? top
      if (list.scrollTop > heading && heading >= bottom) list.scrollTop = heading
      else if (list.scrollTop > top) list.scrollTop = top
      else if (list.scrollTop < bottom) list.scrollTop = bottom
    }
    keepInView()
    const observer = new ResizeObserver(keepInView)
    observer.observe(list)
    return () => observer.disconnect()
  }, [engine, section.id, snapshot?.isolated])
  // Toasts dock over the nav column while Settings is open (globals.css), clear of the centered content.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.sheetNav = ''
    return () => {
      delete root.dataset.sheetNav
    }
  }, [])
  useHotkey('mod+f', () => searchRef.current?.focus())
  // Escape in a non-empty search clears it instead of closing the sheet (runs before the dialog's handler).
  useHotkey('escape', () =>
    document.activeElement === searchRef.current && useSettings.getState().query
      ? setQuery('')
      : false
  )

  return (
    <div className="flex h-full min-h-0">
      <nav className="flex w-[244px] shrink-0 flex-col border-r border-hairline-soft bg-surface-1">
        <div className="px-3 pt-4 pb-3">
          <div className="mb-2 px-1 text-xs font-medium text-fg-2">Choose engine</div>
          <EnginePicker
            value={engine}
            onValueChange={(engine) => void selectDefaultEngine(engine)}
            label="Settings engine"
            className="w-full"
          />
          <div className="mt-2 mb-4">
            <p className="px-1 text-xs leading-relaxed text-fg-3">
              {cwd
                ? `New sessions in this workspace use ${ENGINE_LABELS[defaultEngine]}.`
                : `New workspaces default to ${ENGINE_LABELS[defaultEngine]}.`}
            </p>
            {engine !== defaultEngine && (
              <Button
                size="xs"
                variant="ghost"
                className="mt-1.5 h-auto min-h-7 w-full whitespace-normal"
                onClick={() => void selectDefaultEngine(engine)}
              >
                Use {ENGINE_LABELS[engine]} for new sessions
              </Button>
            )}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              spellCheck={false}
              aria-label="Search settings"
              className="h-8 w-full rounded-md bg-surface-2 pr-12 pl-8 text-ui text-fg shadow-[inset_0_0_0_1px_var(--hairline)] placeholder:text-fg-3 focus:bg-surface-3 focus:shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus-visible:outline-none"
            />
            {!query && (
              <Kbd
                combo="mod+f"
                size="xs"
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              />
            )}
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-xs text-fg-3 hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <div ref={navListRef} className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {sections.map((s, i) => (
            <div key={s.id} ref={s.id === section.id ? activeNavRef : undefined}>
              {s.groupLabel && (
                <div
                  ref={s.id === activeGroupId ? activeGroupRef : undefined}
                  className={cn(
                    'px-2.5 pb-1.5 text-xs font-medium text-fg-3',
                    i === 0 ? 'pt-1' : 'pt-4'
                  )}
                >
                  {s.groupLabel}
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  setQuery('')
                  openSettings(s.id)
                }}
                className={cn(
                  'relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-ui text-fg-2 transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg [&_svg]:size-4 [&_svg]:text-fg-3',
                  !searching && s.id === section.id && 'text-fg [&_svg]:text-fg-2'
                )}
              >
                {!searching && s.id === section.id && (
                  <motion.span
                    layoutId="settings-nav-active"
                    className="absolute inset-0 rounded-md bg-active shadow-[inset_0_0_0_1px_var(--hairline)]"
                    transition={spring.snappy}
                  />
                )}
                <span className="relative flex items-center">{s.icon}</span>
                <span className="relative flex-1 truncate">{s.label}</span>
                {engine === 'pi' && overridden.has(s.id) && (
                  <Tooltip content="Has project overrides">
                    <span className="relative size-1.5 rounded-full bg-info" />
                  </Tooltip>
                )}
              </button>
            </div>
          ))}
        </div>
        {snapshot?.isolated && (
          <div className="border-t border-hairline-soft px-4 py-3 text-xs leading-relaxed text-fg-3">
            <span className="font-medium text-fg-2">Isolated config.</span> Changes go to a separate
            engine folder.
          </div>
        )}
      </nav>

      <div
        ref={scrollRef}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        className="relative min-h-0 flex-1 scroll-pt-16 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-2)_40%,var(--surface-1))] [scrollbar-gutter:stable]"
      >
        <SheetHeader scrolled={scrolled}>
          {(searching || section.scoped) && <ScopeSwitch />}
          <IconButton label="Close settings" hotkey="escape" onClick={close}>
            <X />
          </IconButton>
        </SheetHeader>
        <div className="mx-auto w-full max-w-[calc(720px+2*clamp(24px,4vw,72px))] px-[clamp(24px,4vw,72px)] pt-2 pb-16">
          {!snapshot && !error && !['engine', 'general', 'shortcuts'].includes(section.id) ? (
            <div className="flex justify-center py-24">
              <Spinner className="text-fg-3" />
            </div>
          ) : (
            <SectionTransition key={placeKey} contentKey={contentKey}>
              {error && (
                <Callout
                  tone="warning"
                  icon={<FileWarning />}
                  title="Could not load engine settings"
                  action={
                    <Button size="sm" variant="secondary" onClick={() => void load()}>
                      Try again
                    </Button>
                  }
                >
                  {error}
                </Callout>
              )}
              {searching ? (
                <>
                  <InvalidFileNotice />
                  <TrustNotice />
                  <SearchView query={query} />
                </>
              ) : (
                <>
                  <SectionHeader
                    icon={section.icon}
                    title={section.label}
                    description={section.description}
                  />
                  {section.scoped && section.id !== 'raw' && <InvalidFileNotice />}
                  {section.scoped && <TrustNotice />}
                  {section.render()}
                </>
              )}
            </SectionTransition>
          )}
        </div>
      </div>
    </div>
  )
}
