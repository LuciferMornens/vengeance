/**
 * Updates feature: titlebar pill + Updates sheet for the engine, installed packages and Vengeance itself.
 * Checks run in main (launch + interval, offline-aware); this renders state and starts streamed updates.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  FolderGit2,
  Package,
  RefreshCw,
  RotateCw,
  ScrollText,
  WifiOff,
  X
} from 'lucide-react'
import type {
  AutoUpdateMode,
  OfflineReason,
  PackageUpdateInfo,
  UpdatesState
} from '@shared/api/updates'
import type { EngineId } from '@shared/api/engine'
import { cn } from '../../lib/cn'
import { formatRelativeTime } from '../../lib/format'
import { invoke } from '../../lib/ipc'
import { spring } from '../../lib/motion'
import { useApp } from '../../store/app'
import { Button, IconButton, Mark, Pill, SegmentedControl, Sheet, Spinner, Switch } from '../../ui'
import { SheetHeader } from '../settings/layout'
import { ProcessLog, useRuns } from '../settings/process-log'
import { ChangelogDialog, openChangelog } from './changelog'
import { useUpdates } from './store'

export { openChangelog } from './changelog'

/** Release notes use markdown backticks; render those spans as code instead of literal ticks. */
function withInlineCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="rounded-[4px] bg-active px-1 font-mono text-[11px] text-fg-2">
        {part}
      </code>
    ) : (
      part
    )
  )
}

const OFFLINE_TEXT: Record<OfflineReason, string> = {
  setting: 'Working offline. Update checks and downloads are paused until you turn this off.',
  environment: 'Offline mode is set by an environment variable. Checks are paused.',
  network: 'No network connection. Checks resume when you’re back online.'
}

function useUpdatesState(): UpdatesState | null {
  const state = useUpdates((s) => s.state)
  const load = useUpdates((s) => s.load)
  useEffect(() => {
    if (!state) void load()
  }, [state, load])
  return state
}

export function UpdatesPill() {
  const state = useUpdatesState()
  const mode = useApp((s) => s.prefs.features.updates?.mode ?? 'notify')
  const open = useUpdates((s) => s.sheetOpen)
  const setOpen = useUpdates((s) => s.setSheetOpen)
  const running = useUpdates((store) => Object.values(store.states).some((state) => state.running))
  const count = useUpdates((store) => {
    const states = Object.values(store.states)
    const engines = states.reduce(
      (total, state) => total + Number(state.engine?.available ?? false) + state.packages.length,
      0
    )
    const app = states.some((state) =>
      ['available', 'ready', 'downloading'].includes(state.app.status)
    )
    return engines + Number(app)
  })
  const visible = running || (mode !== 'off' && count > 0)
  const showUpdates = () => {
    const store = useUpdates.getState()
    if (!state?.running && !state?.count) {
      const pending = Object.values(store.states).find((state) => state.running || state.count)
      if (pending) void store.setEngine(pending.engineId ?? 'pi')
    }
    setOpen(true)
  }

  return (
    <>
      <AnimatePresence>
        {visible && state && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, x: 6 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={spring.snappy}
            className="mr-1"
          >
            <Pill indicator={running ? 'spinner' : 'dot'} onClick={showUpdates}>
              {running ? 'Updating…' : `${count} ${count === 1 ? 'update' : 'updates'}`}
            </Pill>
          </motion.div>
        )}
      </AnimatePresence>
      <Sheet open={open} onOpenChange={setOpen} title="Updates" side="full">
        <UpdatesSheet />
      </Sheet>
      <ChangelogDialog />
    </>
  )
}

function UpdateRow({
  icon,
  title,
  technical,
  from,
  to,
  note,
  link,
  action
}: {
  icon: ReactNode
  title: string
  technical?: string
  from?: string
  to?: string
  note?: string
  link?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-card bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)] [&_svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui font-medium text-fg" title={technical}>
          {title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-fg-3">
          {technical && <span className="mr-1 min-w-0 truncate">{technical}</span>}
          {from && <span className="tabular">{from}</span>}
          {to && <ArrowRight className="size-3 text-fg-4" />}
          {to && <span className="tabular text-fg-2">{to}</span>}
          {link && (
            <button
              type="button"
              onClick={() => void invoke('sys:open-external', link)}
              className="ml-1 flex items-center gap-1 font-sans text-fg-3 hover:text-fg-2"
            >
              Changelog <ExternalLink className="size-3" />
            </button>
          )}
        </div>
        {note && <div className="mt-1 line-clamp-2 text-xs text-fg-3">{withInlineCode(note)}</div>}
      </div>
      {action}
    </div>
  )
}

function packageIcon(pkg: PackageUpdateInfo) {
  return pkg.kind === 'git' ? <FolderGit2 /> : <Package />
}

/** The update's target: the npm version when the registry named one, otherwise what the Engine detected. */
function packageTarget(pkg: PackageUpdateInfo): string {
  if (pkg.latest) return pkg.latest
  return pkg.kind === 'git' ? 'new commits' : 'newer version'
}

/** Only a successful check may say "up to date"; before one, the sheet says why it doesn't know. */
type CheckOutcome = 'checked' | 'offline' | 'failed' | 'unchecked'

function checkOutcome(state: UpdatesState): CheckOutcome {
  if (state.lastChecked !== null && !state.error) return 'checked'
  if (state.offline) return 'offline'
  if (state.error) return 'failed'
  return 'unchecked'
}

const UNKNOWN_TITLE: Record<Exclude<CheckOutcome, 'checked'>, string> = {
  offline: 'Couldn’t check · offline',
  failed: 'Couldn’t check for updates',
  unchecked: 'Not checked yet'
}

function NoUpdates({ state, onCheck }: { state: UpdatesState; onCheck: () => void }) {
  const outcome = checkOutcome(state)
  if (outcome === 'checked') {
    const versions = [
      state.engine?.current && `Engine ${state.engine.current}`,
      state.app.current && `Vengeance ${state.app.current}`
    ].filter(Boolean)
    return (
      <div className="flex flex-col items-center py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-6" />
        </span>
        <div className="mt-3 text-md font-medium text-fg">You’re up to date</div>
        {versions.length > 0 && (
          <div className="mt-1 text-sm text-fg-3">{versions.join(' · ')}</div>
        )}
        <Button
          size="sm"
          variant="ghost"
          leading={<ScrollText />}
          className="mt-4"
          onClick={() => openChangelog(state.engineId)}
        >
          What’s new in the engine
        </Button>
      </div>
    )
  }
  const pausedBySetting = outcome === 'offline' && state.offlineReason === 'setting'
  return (
    <div className="flex flex-col items-center py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-hover text-fg-3">
        {outcome === 'offline' ? <WifiOff className="size-6" /> : <RefreshCw className="size-6" />}
      </span>
      <div className="mt-3 text-md font-medium text-fg">{UNKNOWN_TITLE[outcome]}</div>
      <div className="mt-1 text-sm text-fg-3">
        {state.lastChecked
          ? `Last attempt ${formatRelativeTime(state.lastChecked)}`
          : 'Updates for the engine, packages and Vengeance show here after a check.'}
      </div>
      {!pausedBySetting && (
        <Button
          size="sm"
          variant="secondary"
          leading={<RefreshCw />}
          className="mt-4"
          onClick={onCheck}
        >
          {outcome === 'unchecked' ? 'Check now' : 'Retry'}
        </Button>
      )}
    </div>
  )
}

function Card({
  title,
  children,
  actions
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center px-1">
        <h3 className="flex-1 text-xs font-medium text-fg-3">{title}</h3>
        {actions}
      </div>
      <div className="overflow-hidden rounded-card bg-surface-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline),var(--shadow-sm)]">
        {children}
      </div>
    </section>
  )
}

export function UpdatesSheet() {
  const state = useUpdatesState()
  const selectedEngine = useUpdates((store) => store.engine)
  const check = useUpdates((s) => s.check)
  const run = useUpdates((s) => s.run)
  const close = () => useUpdates.getState().setSheetOpen(false)
  const logRunId = useUpdates((s) => s.logRunId ?? s.state?.running?.runId ?? null)
  const log = useRuns((s) => (logRunId ? s.runs[logRunId] : undefined))
  const updatesPrefs = useApp((s) => s.prefs.features.updates) ?? {}
  const updateFeature = useApp((s) => s.updateFeaturePrefs)
  const setOffline = useUpdates((s) => s.setOffline)
  const [scrolled, setScrolled] = useState(false)

  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="text-fg-3" />
      </div>
    )
  }
  const busy = !!state.running
  const engine = state.engine
  const app = state.app
  const nothing =
    !engine?.available &&
    state.packages.length === 0 &&
    app.status !== 'available' &&
    app.status !== 'ready' &&
    app.status !== 'downloading'

  return (
    <div
      onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      className="relative min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-2)_40%,var(--surface-1))] [scrollbar-gutter:stable]"
    >
      <SheetHeader scrolled={scrolled}>
        <Button
          size="sm"
          variant="ghost"
          leading={<ScrollText />}
          onClick={() => openChangelog(selectedEngine)}
        >
          What’s new
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leading={<RefreshCw className={cn(state.checking && 'animate-spin')} />}
          disabled={state.checking || busy || state.offlineReason === 'setting'}
          onClick={() => void check()}
        >
          Check now
        </Button>
        <IconButton label="Close updates" hotkey="escape" onClick={close}>
          <X />
        </IconButton>
      </SheetHeader>
      {/* pb-36: no nav column here, so the last control must scroll clear of a bottom-right toast with an action. */}
      <div className="mx-auto w-full max-w-[calc(720px+2*clamp(24px,4vw,72px))] px-[clamp(24px,4vw,72px)] pt-2 pb-36">
        <header className="mb-8 flex items-center gap-3.5">
          <span className="flex size-10 items-center justify-center rounded-card bg-surface-3 text-fg-2 shadow-[var(--highlight),0_0_0_1px_var(--hairline)] [&_svg]:size-5">
            <ArrowUpCircle />
          </span>
          <div className="min-w-0">
            <h2 className="heading text-xl font-semibold text-fg">Updates</h2>
            <div className="mt-0.5 text-sm text-fg-3">
              {state.checking
                ? 'Checking…'
                : state.lastChecked !== null && checkOutcome(state) === 'checked'
                  ? `Checked ${formatRelativeTime(state.lastChecked)}`
                  : 'Not checked yet'}
            </div>
          </div>
        </header>
        <div className="mb-5">
          <SegmentedControl<EngineId>
            value={selectedEngine}
            onValueChange={(engine) => void useUpdates.getState().setEngine(engine)}
            segments={[
              { value: 'pi', label: 'Engine 1' },
              { value: 'prime', label: 'Engine 2' }
            ]}
          />
        </div>
        {engine && (
          <Card title={selectedEngine === 'pi' ? 'Engine' : 'Engine 2'}>
            <div className="px-4 py-3">
              <p className="text-sm text-fg-2">{engine.current}</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-3">{engine.note}</p>
            </div>
          </Card>
        )}
        {state.offline && (
          <div
            className={cn(
              'mb-5 flex items-center gap-2.5 rounded-card px-3.5 py-2.5 text-sm',
              state.offlineReason === 'setting'
                ? 'bg-hover text-fg-2'
                : 'bg-warning-soft text-warning'
            )}
          >
            <WifiOff className="size-4 shrink-0" />
            <span className="flex-1">{OFFLINE_TEXT[state.offlineReason ?? 'network']}</span>
            {state.offlineReason === 'setting' && (
              <Button size="xs" variant="secondary" onClick={() => void setOffline(false)}>
                Go online
              </Button>
            )}
          </div>
        )}
        {state.error && !state.offline && (
          <div className="mb-5 rounded-card bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            {state.error}
          </div>
        )}

        {nothing && !state.checking && <NoUpdates state={state} onCheck={() => void check()} />}

        {state.packages.length > 0 && (
          <Card
            title="Packages"
            actions={
              state.packages.length > 1 && (
                <Button
                  size="xs"
                  variant="primary"
                  leading={<ArrowUpCircle />}
                  disabled={busy}
                  onClick={() => void run({ target: 'packages' }, 'Updating packages')}
                >
                  Update all
                </Button>
              )
            }
          >
            {state.packages.map((pkg) => (
              <UpdateRow
                key={`${pkg.scope}:${pkg.source}`}
                icon={packageIcon(pkg)}
                title={pkg.displayName}
                technical={pkg.name}
                from={pkg.current}
                to={packageTarget(pkg)}
                link={pkg.changelogUrl}
                action={
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        { target: 'package', source: pkg.source },
                        `Updating ${pkg.displayName}`
                      )
                    }
                  >
                    Update
                  </Button>
                }
              />
            ))}
          </Card>
        )}

        <AnimatePresence>
          {log && (
            <ProcessLog
              key={log.runId}
              run={log}
              doneLabel="Updated"
              height={200}
              className="mb-5"
              onDismiss={() => useUpdates.setState({ logRunId: null })}
            />
          )}
        </AnimatePresence>

        <Card title="Vengeance">
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-card bg-surface-3 shadow-[var(--highlight),0_0_0_1px_var(--hairline)]">
              <Mark size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-ui font-medium text-fg">
                Vengeance {app.current}
                {app.latest && app.status !== 'idle' && (
                  <span className="text-fg-2"> → {app.latest}</span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-fg-3">
                {app.status === 'disabled' && (app.message ?? 'Self-updates are off.')}
                {app.status === 'idle' && 'Up to date'}
                {app.status === 'checking' && 'Checking…'}
                {app.status === 'available' && 'A new version is available.'}
                {app.status === 'downloading' && `Downloading… ${Math.round(app.progress ?? 0)}%`}
                {app.status === 'ready' && 'Ready — restart to finish updating.'}
                {app.status === 'error' && <span className="text-danger">{app.message}</span>}
              </div>
              {app.status === 'downloading' && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-hover">
                  <div
                    className="h-full rounded-full bg-accent-gradient transition-[width] duration-300"
                    style={{ width: `${app.progress ?? 0}%` }}
                  />
                </div>
              )}
            </div>
            {app.status === 'available' && (
              <Button
                size="sm"
                variant="secondary"
                leading={<Download />}
                onClick={() => void invoke('updates:app-download')}
              >
                Download
              </Button>
            )}
            {app.status === 'ready' && (
              <Button
                size="sm"
                variant="primary"
                leading={<RotateCw />}
                onClick={() => void invoke('updates:app-install')}
              >
                Restart
              </Button>
            )}
          </div>
        </Card>

        <Card title="Automatic updates">
          <div className="px-4 py-3">
            <SegmentedControl<AutoUpdateMode>
              value={updatesPrefs.mode ?? 'notify'}
              onValueChange={(mode) => updateFeature('updates', { ...updatesPrefs, mode })}
              segments={[
                { value: 'off', label: 'Off' },
                { value: 'notify', label: 'Notify' },
                { value: 'automatic', label: 'Automatic' }
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-fg-3">
              {(updatesPrefs.mode ?? 'notify') === 'automatic'
                ? 'Packages update while no agent is running. Vengeance updates download automatically; restart when ready to update the app and both engines.'
                : (updatesPrefs.mode ?? 'notify') === 'notify'
                  ? 'A pill appears in the titlebar when something new is available.'
                  : 'No background checks. Use “Check now” or the command palette.'}
            </p>
          </div>
          <div className="flex items-center gap-3 border-t border-hairline-soft px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-ui font-medium text-fg">Work offline</div>
              <div className="mt-0.5 text-xs text-fg-3">
                Pause update checks and downloads for both engines and Vengeance.
              </div>
            </div>
            <Switch
              aria-label="Work offline"
              checked={!!updatesPrefs.offline}
              onCheckedChange={(on) => void setOffline(on)}
            />
          </div>
        </Card>
      </div>
    </div>
  )
}
