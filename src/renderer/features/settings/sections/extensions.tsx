import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  ArrowUpRight,
  Check,
  Download,
  FileCode2,
  FolderOpen,
  PackagePlus,
  Plus,
  Search,
  SearchX,
  Terminal,
  WifiOff,
  X
} from 'lucide-react'
import { GALLERY_URL, type GalleryPackage, type GallerySearchResult } from '@shared/api/gallery'
import type { PackageInfo } from '@shared/api/settings'
import { friendlyExtensionName } from '@shared/display-names'
import { cn } from '../../../lib/cn'
import { basename } from '../../../lib/format'
import { useApp } from '../../../store/app'
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  EmptyState,
  Pill,
  SegmentedControl,
  Skeleton,
  toast
} from '../../../ui'
import { invoke, on } from '../ipc'
import { ProcessLog, useRuns } from '../process-log'
import { activeCwd, useSettings } from '../store'
import {
  ExtensionDetails,
  formatDownloads,
  formatUpdated,
  type InstallScope
} from './extension-details'

/**
 * Discover extensions: the community gallery (npm packages tagged for the Engine) with one-click installs, plus
 * adding your own extension file or package folder. Installed packages are managed in Packages.
 */

const SEARCH_DEBOUNCE_MS = 280
const TOPICS: Array<{ label: string; query: string }> = [
  { label: 'Popular', query: '' },
  { label: 'MCP', query: 'mcp' },
  { label: 'Subagents', query: 'subagent' },
  { label: 'Web', query: 'web' },
  { label: 'Memory', query: 'memory' },
  { label: 'Git', query: 'git' },
  { label: 'Review', query: 'review' },
  { label: 'Browser', query: 'browser' },
  { label: 'Themes', query: 'theme' }
]

type Results =
  | { status: 'loading'; query: string }
  | { status: 'error'; query: string; message: string }
  | { status: 'ready'; query: string; total: number; packages: GalleryPackage[]; more: boolean }

function ExtensionCard({
  pkg,
  installed,
  installing,
  busy,
  onOpen,
  onInstall
}: {
  pkg: GalleryPackage
  installed: boolean
  installing: boolean
  busy: boolean
  onOpen: () => void
  onInstall: () => void
}) {
  const downloads = formatDownloads(pkg.weeklyDownloads)
  const updated = formatUpdated(pkg.updated)
  return (
    <div className="group relative flex flex-col rounded-card bg-surface-2 p-4 shadow-elev-1 transition-[background-color,box-shadow] duration-[var(--dur-instant)] hover:bg-surface-3">
      {/* The whole card opens the details; the install button sits above this layer. */}
      <button
        type="button"
        aria-label={`About ${pkg.displayName}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-card"
      />
      <div className="pointer-events-none flex items-start gap-3">
        <Avatar name={pkg.displayName} size={36} className="rounded-card" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="heading truncate text-title text-fg">{pkg.displayName}</span>
            {installed && (
              <Badge tone="success">
                <Check className="size-3" />
                Installed
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-xs text-fg-3">
            {pkg.name}
            {pkg.publisher && <span className="font-sans"> · {pkg.publisher}</span>}
          </div>
        </div>
      </div>
      <p className="pointer-events-none mt-2.5 mb-3 line-clamp-2 min-h-[3.1em] text-sm leading-relaxed text-fg-2">
        {pkg.description ?? 'No description.'}
      </p>
      {/* Pinned to the bottom at button height, so installed and installable cards line up. */}
      <div className="mt-auto flex h-7 items-center gap-3 text-xs text-fg-3">
        {downloads && (
          <span className="tabular pointer-events-none inline-flex items-center gap-1">
            <Download className="size-3" />
            {downloads}
          </span>
        )}
        {updated && <span className="pointer-events-none truncate">Updated {updated}</span>}
        {!installed && (
          <Button
            size="sm"
            variant="secondary"
            leading={installing ? undefined : <Plus />}
            loading={installing}
            disabled={busy}
            onClick={onInstall}
            className="relative z-10 ml-auto"
          >
            {installing ? 'Installing…' : 'Install'}
          </Button>
        )}
      </div>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="rounded-card bg-surface-2 p-4 shadow-elev-1">
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-card" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <Skeleton className="mt-3.5 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-3/4" />
      <Skeleton className="mt-4 h-3 w-32" />
    </div>
  )
}

export function ExtensionsSection() {
  const settingsScope = useSettings((s) => s.scope)
  const hasProject = useSettings((s) => !!s.snapshot?.project)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results>({ status: 'loading', query: '' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [installed, setInstalled] = useState<PackageInfo[]>([])
  const [scope, setScope] = useState<InstallScope>(settingsScope === 'project' ? 'project' : 'user')
  const [details, setDetails] = useState<GalleryPackage | null>(null)
  const [activeRun, setActiveRun] = useState<{ runId: string; name?: string } | null>(null)
  const run = useRuns((s) => (activeRun ? s.runs[activeRun.runId] : undefined))
  const dismiss = useRuns((s) => s.dismiss)
  const request = useRef(0)
  const busy = run?.status === 'running'
  const installingName = busy ? activeRun?.name : undefined

  useEffect(() => setScope(settingsScope === 'project' ? 'project' : 'user'), [settingsScope])

  const loadInstalled = useCallback(
    async () => setInstalled(await invoke('settings:packages', activeCwd()).catch(() => [])),
    []
  )
  useEffect(() => {
    void loadInstalled()
    return on('settings:changed', ({ area }) => {
      if (area === 'packages' || area === 'settings' || area === 'trust') void loadInstalled()
    })
  }, [loadInstalled])
  const installedNames = useMemo(
    () => new Set(installed.filter((p) => p.kind === 'npm').map((p) => p.name)),
    [installed]
  )

  // Search as you type, debounced; an older answer never replaces a newer one.
  useEffect(() => {
    const next = input.trim()
    if (next === query) return
    const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [input, query])

  const search = useCallback(async (terms: string) => {
    const id = ++request.current
    setResults({ status: 'loading', query: terms })
    try {
      const page = await invoke('gallery:search', { query: terms })
      if (id === request.current) setResults(ready(page))
    } catch (error) {
      if (id === request.current)
        setResults({ status: 'error', query: terms, message: (error as Error).message })
    }
  }, [])
  useEffect(() => void search(query), [query, search])

  const loadMore = async () => {
    if (results.status !== 'ready') return
    const id = request.current
    setLoadingMore(true)
    try {
      const page = await invoke('gallery:search', {
        query: results.query,
        from: results.packages.length
      })
      if (id !== request.current) return
      setResults((current) => {
        if (current.status !== 'ready') return current
        const known = new Set(current.packages.map((p) => p.name))
        const packages = [...current.packages, ...page.packages.filter((p) => !known.has(p.name))]
        return { ...current, packages, more: page.packages.length > 0 && packages.length < page.total }
      })
    } catch (error) {
      toast({ level: 'error', title: 'Could not load more', description: (error as Error).message })
    } finally {
      setLoadingMore(false)
    }
  }

  const install = async (source: string, label: string, name?: string) => {
    if (activeRun) dismiss(activeRun.runId)
    try {
      const runId = await invoke('settings:package-run', {
        action: 'install',
        source,
        local: hasProject && scope === 'project',
        cwd: activeCwd()
      })
      useRuns.getState().label(runId, `Installing ${label}`, useSettings.getState().engine)
      setActiveRun({ runId, name })
    } catch (error) {
      toast({ level: 'error', title: `Could not install ${label}`, description: (error as Error).message })
    }
  }
  const installPackage = (pkg: GalleryPackage) => void install(`npm:${pkg.name}`, pkg.displayName, pkg.name)

  const addFile = async () => {
    const [file] = await invoke('sys:pick-files', {
      title: 'Choose an extension file',
      filters: [{ name: 'Extensions', extensions: ['ts', 'js', 'mts', 'mjs'] }]
    })
    if (file) void install(file, friendlyExtensionName(basename(file).replace(/\.[^.]+$/, '')))
  }
  const addFolder = async () => {
    const folder = await invoke('sys:pick-folder', { title: 'Choose an extension or package folder' })
    if (folder) void install(folder, friendlyExtensionName(basename(folder)))
  }
  const openPackages = () => useApp.getState().openSettings('packages')

  const topic = TOPICS.find((t) => t.query === input.trim().toLowerCase())

  return (
    <div className="@container">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-10 flex-1 items-center gap-2.5 rounded-card bg-surface-2 px-3 shadow-elev-1 focus-within:shadow-focus">
          <Search className="size-4 shrink-0 text-fg-3" />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setQuery(input.trim())
              if (e.key === 'Escape' && input) {
                e.stopPropagation()
                setInput('')
              }
            }}
            placeholder="Search community extensions"
            aria-label="Search community extensions"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden"
          />
          {input && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setInput('')}
              className="flex size-5 items-center justify-center rounded-xs text-fg-3 transition-colors duration-[var(--dur-instant)] hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <DropdownMenu
          align="end"
          trigger={
            <Button variant="secondary" leading={<PackagePlus />} className="h-10">
              Add your own
            </Button>
          }
          items={[
            { label: 'Extension file…', icon: <FileCode2 />, onSelect: () => void addFile() },
            { label: 'Package folder…', icon: <FolderOpen />, onSelect: () => void addFolder() },
            { kind: 'separator' as const },
            { label: 'From npm or git…', icon: <Terminal />, onSelect: openPackages }
          ]}
        />
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {TOPICS.map((t) => (
          <Pill
            key={t.label}
            aria-pressed={topic === t}
            onClick={() => {
              setInput(t.query)
              setQuery(t.query)
            }}
            className={cn(topic === t && 'bg-active text-fg shadow-[inset_0_0_0_1px_var(--hairline-strong)]')}
          >
            {t.label}
          </Pill>
        ))}
      </div>

      <AnimatePresence>
        {run && (
          <ProcessLog
            key={run.runId}
            run={run}
            cancellable
            className="mb-5"
            onDismiss={() => setActiveRun(null)}
          />
        )}
      </AnimatePresence>

      <div className="mb-2.5 flex items-end gap-3 px-1">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-fg-3">
          {results.status === 'ready' && results.query
            ? `${results.total.toLocaleString()} ${results.total === 1 ? 'result' : 'results'} for “${results.query}”`
            : 'Most popular'}
        </h3>
        {hasProject && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg-3">Install for</span>
            <SegmentedControl
              size="sm"
              aria-label="Install for"
              value={scope}
              onValueChange={setScope}
              segments={[
                { value: 'user', label: 'Every project' },
                { value: 'project', label: 'This project' }
              ]}
            />
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          trailing={<ArrowUpRight />}
          onClick={() => void invoke('sys:open-external', GALLERY_URL)}
        >
          Browse on the web
        </Button>
      </div>

      {results.status === 'error' ? (
        <EmptyState
          icon={<WifiOff />}
          title="Can’t reach the extension gallery"
          description={results.message}
          action={
            <Button variant="secondary" onClick={() => void search(results.query)}>
              Try again
            </Button>
          }
        />
      ) : results.status === 'ready' && results.packages.length === 0 ? (
        <EmptyState
          icon={<SearchX />}
          title={`Nothing matches “${results.query}”`}
          description="Try a broader word, or install a package by name from npm or git."
          action={
            <Button variant="secondary" onClick={openPackages}>
              Install by name
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 @[600px]:grid-cols-2">
            {results.status === 'loading'
              ? Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} />)
              : results.packages.map((pkg) => (
                  <ExtensionCard
                    key={pkg.name}
                    pkg={pkg}
                    installed={installedNames.has(pkg.name)}
                    installing={installingName === pkg.name}
                    busy={busy}
                    onOpen={() => setDetails(pkg)}
                    onInstall={() => installPackage(pkg)}
                  />
                ))}
          </div>
          {results.status === 'ready' && results.more && (
            <div className="mt-4 flex justify-center">
              <Button variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}

      <ExtensionDetails
        pkg={details}
        installed={!!details && installedNames.has(details.name)}
        installing={!!details && installingName === details.name}
        hasProject={hasProject}
        scope={scope}
        onScopeChange={setScope}
        onInstall={installPackage}
        onManage={() => {
          setDetails(null)
          openPackages()
        }}
        onOpenChange={(open) => !open && setDetails(null)}
      />
    </div>
  )
}

function ready(page: GallerySearchResult): Results {
  return {
    status: 'ready',
    query: page.query,
    total: page.total,
    packages: page.packages,
    more: page.packages.length < page.total
  }
}
