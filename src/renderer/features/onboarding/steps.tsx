import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { motion } from 'motion/react'
import {
  ArrowRight,
  Check,
  FolderOpen,
  FolderSearch,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { ENGINE_LABELS, type EngineId, type EngineLocationInfo } from '@shared/api/engine'
import type { ProviderInfo } from '@shared/api/settings'
import { cn } from '../../lib/cn'
import { basename, formatRelativeTime } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import { useApp } from '../../store/app'
import { useShownWorkspaces } from '../../store/shown-workspaces'
import { Button, ListRow, Select, Spinner } from '../../ui'
import { LoginDialog, useLoginFlow } from '../settings/auth-flow'
import { providerName, signInPlan } from '../settings/provider-name'
import { providerUsable, SIGN_IN_EXPIRED, signInExpired } from '../settings/provider-status'
import { ProviderAvatar } from '../settings/sections/providers'
import { useSettings } from '../settings/store'
import { Callout } from '../settings/layout'

/** The three onboarding steps: engine → provider → project folder. */

export function StepTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h2 className="heading text-xl font-semibold text-fg">{title}</h2>
      <p className="mt-1 text-ui leading-relaxed text-fg-3">{subtitle}</p>
    </div>
  )
}

// ─── Step 1: engine ─────────────────────────────────────────────────────────

export function EngineStep({
  engine,
  engineId = 'pi',
  onRecheck,
  onNext
}: {
  engine: EngineLocationInfo | null
  engineId?: EngineId
  onRecheck: () => void
  onNext: () => void
}) {
  const label = ENGINE_LABELS[engineId]
  const update = useApp((s) => s.update)
  const locate = async () => {
    const path = await invoke('sys:pick-folder', { title: 'Locate the engine install folder' })
    if (!path) return
    if (engineId === 'pi') update({ engineOverridePath: path })
    else
      update({
        engineOverridePaths: { ...useApp.getState().prefs.engineOverridePaths, [engineId]: path }
      })
    setTimeout(onRecheck, 400)
  }

  if (!engine) {
    return (
      <div className="flex items-center gap-3 py-8 text-ui text-fg-3">
        <Spinner size={16} /> Looking for the engine…
      </div>
    )
  }

  if (engine.found) {
    return (
      <>
        <StepTitle
          title={`${label} detected`}
          subtitle="Both engines are included with Vengeance. Each engine keeps its own accounts and settings."
        />
        <div className="flex items-center gap-3.5 rounded-card bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ ...spring.snappy, delay: 0.1 }}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success shadow-[0_0_24px_color-mix(in_oklab,var(--success)_30%,transparent)]"
          >
            <Check className="size-4.5" strokeWidth={2.75} />
          </motion.span>
          <div className="min-w-0 flex-1">
            <div className="text-ui font-medium text-fg">
              {label} {engine.version}
              {engine.mock && (
                <span className="ml-2 text-xs font-normal text-warning">mock mode</span>
              )}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-fg-3">{engine.packageDir}</div>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <Button variant="primary" size="lg" trailing={<ArrowRight />} onClick={onNext}>
            Continue
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <StepTitle
        title={`${label} unavailable`}
        subtitle="Reinstall Vengeance to restore its included engines, or choose a custom engine location."
      />
      <div className="mb-4 flex items-start gap-3 rounded-card bg-warning-soft p-3.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <span className="min-w-0 text-fg-2">
          {engine.error ?? 'The bundled engine files could not be found.'}
        </span>
      </div>
      <div className="mt-6 flex items-center justify-between gap-2">
        <Button variant="ghost" leading={<FolderSearch />} onClick={() => void locate()}>
          Locate…
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="lg" leading={<RefreshCw />} onClick={onRecheck}>
            Check again
          </Button>
        </div>
      </div>
    </>
  )
}

// ─── Step 2: provider ───────────────────────────────────────────────────────

const FEATURED = ['anthropic', 'openai', 'github-copilot']
const FEATURED_COUNT = 4

/** The engine keeps superseded providers for existing users and marks them in the name ("OpenAI Codex (legacy)"). */
function isLegacy(p: ProviderInfo): boolean {
  return /\(legacy\)/i.test(p.name)
}

export function ProviderStep({ onNext }: { onNext: () => void }) {
  const catalog = useSettings((s) => s.catalog)
  const catalogError = useSettings((state) => state.catalogError)
  const loadCatalog = useSettings((s) => s.loadCatalog)
  const flow = useLoginFlow((ok) => ok && void loadCatalog(true))
  const [keyProvider, setKeyProvider] = useState<string | undefined>()
  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const providers = catalog?.providers ?? []
  const connected = providers.filter(providerUsable)
  const featured = useMemo(() => {
    // Connected providers already show as chips above, so the sign-in cards only offer the rest.
    const oauth = providers.filter((p) => p.oauth && !providerUsable(p) && !isLegacy(p))
    return [
      ...FEATURED.map((id) => oauth.find((p) => p.id === id)).filter((p): p is ProviderInfo => !!p),
      ...oauth.filter((p) => !FEATURED.includes(p.id))
    ].slice(0, FEATURED_COUNT)
  }, [providers])
  const keyOptions = providers
    .filter((p) => p.apiKey)
    .map((p) => ({ value: p.id, label: providerName(p) }))

  return (
    <>
      <StepTitle
        title={connected.length ? 'You’re connected' : 'Connect a provider'}
        subtitle={
          connected.length
            ? 'The engine already has working credentials. Add more any time in Settings.'
            : 'Sign in with a subscription you already have, or paste an API key.'
        }
      />
      {catalogError && (
        <Callout
          tone="warning"
          icon={<TriangleAlert />}
          title="Could not load providers"
          action={
            <Button size="sm" variant="secondary" onClick={() => void loadCatalog(true)}>
              Try again
            </Button>
          }
        >
          {catalogError}
        </Callout>
      )}
      {!catalog && !catalogError && (
        <div className="flex items-center gap-3 py-6 text-ui text-fg-3">
          <Spinner size={16} /> Loading providers…
        </div>
      )}
      {connected.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {connected.map((p) => (
            <span
              key={p.id}
              className="flex h-8 items-center gap-2 rounded-full bg-success-soft py-1 pr-3 pl-1 text-sm font-medium text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--success)_25%,transparent)]"
            >
              <ProviderAvatar provider={p} size={24} />
              {providerName(p)}
              <Check className="size-3.5 text-success" strokeWidth={2.75} />
            </span>
          ))}
        </div>
      )}
      {catalog && featured.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {featured.map((p) => {
            const plan = signInPlan(p)
            const expired = signInExpired(p)
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => void flow.start(p, 'oauth')}
                className={cn(
                  'group flex items-center gap-3 rounded-card bg-surface-1 p-3 text-left shadow-[inset_0_0_0_1px_var(--hairline)]',
                  'transition-[background-color,box-shadow] duration-[var(--dur-fast)] hover:bg-hover hover:shadow-[inset_0_0_0_1px_var(--hairline-strong)]'
                )}
              >
                <ProviderAvatar provider={p} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-fg">
                    {providerName(p)}
                  </span>
                  <span
                    className={cn('block truncate text-xs', expired ? 'text-warning' : 'text-fg-3')}
                  >
                    {expired
                      ? SIGN_IN_EXPIRED.label
                      : (plan ?? (p.oauth?.subscription ? 'Use your subscription' : 'Sign in'))}
                  </span>
                </span>
                <ShieldCheck className="size-4 shrink-0 text-fg-3 transition-colors group-hover:text-fg-2" />
              </button>
            )
          })}
        </div>
      )}
      {catalog && (
        <div className="mt-4 flex items-center gap-2 rounded-card bg-surface-1 p-2 pl-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
          <KeyRound className="size-4 shrink-0 text-fg-3" />
          <span className="shrink-0 text-sm text-fg-2">API key</span>
          <Select
            className="min-w-0 flex-1"
            placeholder="Choose a provider…"
            value={keyProvider}
            onValueChange={setKeyProvider}
            options={keyOptions}
          />
          <Button
            variant="secondary"
            disabled={!keyProvider}
            onClick={() => {
              const p = providers.find((x) => x.id === keyProvider)
              if (p) void flow.start(p, 'api_key')
            }}
          >
            Add key
          </Button>
        </div>
      )}
      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={onNext}>
          {connected.length ? 'Skip' : 'Skip for now'}
        </Button>
        <Button
          variant="primary"
          size="lg"
          trailing={<ArrowRight />}
          disabled={!connected.length}
          onClick={onNext}
        >
          Continue
        </Button>
      </div>
      <LoginDialog flow={flow} />
    </>
  )
}

// ─── Step 3: project ────────────────────────────────────────────────────────

export function ProjectStep({ onOpen }: { onOpen: (path: string) => void }) {
  const recent = useShownWorkspaces().slice(0, 4)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const choose = async () => {
    const path = await invoke('sys:pick-folder', { title: 'Choose a project folder' })
    if (path) onOpen(path)
  }
  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const folder = await invoke('sys:dropped-folder', window.vengeance.pathForFile(file))
    if (!folder) {
      setError('Drop a folder, not a file.')
      return
    }
    setError(null)
    onOpen(folder)
  }

  return (
    <>
      <StepTitle
        title="Choose a project"
        subtitle="Pick the folder your agents will work in. You can run several sessions in parallel."
      />
      <motion.button
        type="button"
        onClick={() => void choose()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
        animate={{ scale: over ? 1.015 : 1 }}
        transition={spring.snappy}
        className={cn(
          'relative flex w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg px-6 py-9 text-center',
          'border border-dashed transition-[background-color,border-color,box-shadow] duration-[var(--dur-base)]',
          over
            ? 'border-[var(--accent-border)] bg-accent-softer shadow-[0_0_0_4px_var(--accent-softer)]'
            : 'border-hairline-strong bg-surface-1 hover:border-[color-mix(in_oklab,var(--fg)_28%,transparent)] hover:bg-hover'
        )}
      >
        <span
          className={cn(
            'flex size-12 items-center justify-center rounded-lg shadow-[var(--highlight),0_0_0_1px_var(--hairline)] transition-colors',
            over ? 'bg-accent-soft text-accent-text' : 'bg-surface-3 text-fg-2'
          )}
        >
          <FolderOpen className="size-5" />
        </span>
        <span>
          <span className="block text-md font-medium text-fg">
            {over ? 'Drop to open' : 'Drop a folder here'}
          </span>
          <span className="mt-0.5 block text-sm text-fg-3">
            or <span className="text-accent-text">browse…</span>
          </span>
        </span>
      </motion.button>
      {error && <div className="mt-2 text-sm text-danger">{error}</div>}
      {recent.length > 0 && (
        <div className="mt-6">
          <div className="mb-1.5 px-1 text-xs font-medium text-fg-3">Recent</div>
          {recent.map((w) => (
            <ListRow
              key={w.path}
              title={w.name || basename(w.path)}
              icon={<FolderOpen />}
              meta={
                <>
                  <span className="hidden max-w-[260px] truncate font-mono group-hover/row:block">
                    {w.path}
                  </span>
                  <span className="group-hover/row:hidden">
                    {formatRelativeTime(w.lastOpenedAt)}
                  </span>
                </>
              }
              onClick={() => onOpen(w.path)}
            />
          ))}
        </div>
      )}
    </>
  )
}
