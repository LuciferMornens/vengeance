import { app, net } from 'electron'
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_UPDATE_INTERVAL_HOURS,
  type EngineChangelog,
  type EngineUpdateInfo,
  type OfflineReason,
  type PackageUpdateInfo,
  type RunUpdateArgs,
  type UpdatesEventMap,
  type UpdatesPrefs,
  type UpdatesState
} from '@shared/api/updates'
import type { ProcessDoneEvent, ProcessLogEvent } from '@shared/api/settings'
import type { AppPersistedState } from '@shared/api/app'
import { appState } from '../../app-state'
import { env } from '../../env'
import { runGit } from '../../git'
import { locateEngine, type EngineLocation } from '../../engine/locate'
import { ENGINE_UPDATE_MESSAGE } from '../../engine/bundled'
import type { EngineManager } from '../../engine/manager'
import { sdkHostCall } from '../../engine/sdk-host/client'
import type { PackageScope } from '../../engine/sdk-host/protocol'
import { clearExtensionFlagCache, readSettingsList } from '../launch/flags'
import { trustPreflight } from '../launch/trust'
import { agentDir, projectRoot } from '../settings/agent-dir'
import { readJsonFile } from '../settings/json-file'
import { packageDisplayName, packageKind, packageLabel } from '../settings/package-source'
import { simulatePiCli, streamPiCli } from '../settings/pi-cli'
import { AppUpdates } from './app-updater'
import { latestNpmRelease, npmChangelogUrl } from './npm-release'

/**
 * Background update checks (launch + every N hours, offline-aware) for the engine, installed packages and
 * Vengeance itself; runs `pi update …` with a streamed log; Automatic mode applies updates when no agent
 * is busy and tells the renderer to restart idle engines. Also watches the managed install's
 * `current-version` so an engine updated from a terminal is noticed.
 */

const ENGINE_CHANGELOG =
  'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md'
const LAUNCH_DELAY_MS = 8_000
const BUSY_RETRY_MS = 30_000
const HOUR_MS = 3_600_000
/** Longest single wait for a check: a machine that slept or a changed clock is caught within it. */
const MAX_CHECK_WAIT_MS = HOUR_MS
/** Main hears of no network return, so checks retry at this pace while offline by network. */
const OFFLINE_RETRY_MS = 60_000

export interface UpdatesServiceHooks {
  broadcast<C extends keyof UpdatesEventMap>(channel: C, payload: UpdatesEventMap[C]): void
}

function prefs(): UpdatesPrefs {
  return appState.getPrefs().features.updates ?? {}
}

/** Why checks must not touch the network right now, or null when online. */
export function updatesOfflineReason(): OfflineReason | null {
  if (prefs().offline) return 'setting'
  if (process.env.PI_OFFLINE || process.env.PRIME_AGENT_OFFLINE) return 'environment'
  return net.isOnline() ? null : 'network'
}

/**
 * Milliseconds until the next background check, or null while checks are paused (mode off, offline by
 * setting or environment); a change of the updates prefs reschedules. Never earlier than `notBefore`.
 */
export function nextCheckDelay(lastChecked: number | null, notBefore: number): number | null {
  const { mode = 'notify', intervalHours = DEFAULT_UPDATE_INTERVAL_HOURS } = prefs()
  if (mode === 'off') return null
  const offline = updatesOfflineReason()
  if (offline && offline !== 'network') return null
  const due = lastChecked === null ? 0 : lastChecked + intervalHours * HOUR_MS
  const delay = Math.max(0, Math.min(Math.max(due, notBefore) - Date.now(), MAX_CHECK_WAIT_MS))
  // Offline by network: a check that is not due yet (the launch check) still runs on time.
  if (offline === 'network') return delay > 0 ? Math.min(delay, OFFLINE_RETRY_MS) : OFFLINE_RETRY_MS
  return delay
}

/** True when a prefs change can move or pause the background checks. */
export function updatesScheduleChanged(
  next: AppPersistedState,
  previous: AppPersistedState
): boolean {
  const now = next.features.updates ?? {}
  const before = previous.features.updates ?? {}
  return (
    now.mode !== before.mode ||
    now.intervalHours !== before.intervalHours ||
    now.offline !== before.offline
  )
}

/** Mock mode: a short, realistic changelog of the mock engine's installed version (MOCK_ENGINE.current). */
const MOCK_CHANGELOG = [
  '# Changelog',
  '',
  '## [1.1.0] - 2026-06-18',
  '',
  '### Added',
  '',
  '- Built-in MCP support with OAuth sign-in and per-tool exposure.',
  '- Project trust prompts for folders with project resources.',
  '',
  '### Changed',
  '',
  '- `update --models` refreshes model catalogs on demand.',
  '',
  '## [1.0.0] - 2026-05-30',
  '',
  '### Added',
  '',
  '- Packages: install extensions, skills, prompts and themes from npm or git.',
  '- `/tree` navigates and forks the session history.',
  '',
  '### Fixed',
  '',
  '- Faster startup when many packages are installed.',
  ''
].join('\n')

function gitShortHead(dir: string): Promise<string | undefined> {
  return runGit(['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 10_000 }).then(
    (stdout) => stdout.trim() || undefined,
    () => undefined
  )
}

function gitWebUrl(source: string): string | undefined {
  const path = packageDisplayName(source)
  return /^[\w.-]+\.[a-z]{2,}\//i.test(path) ? `https://${path}/commits` : undefined
}

const MOCK_ENGINE: EngineUpdateInfo = {
  current: '1.2.0+vengeance.1',
  managedByApp: true,
  available: false,
  note: ENGINE_UPDATE_MESSAGE,
  changelogUrl: ENGINE_CHANGELOG
}

const MOCK_PACKAGES: PackageUpdateInfo[] = [
  {
    source: 'npm:pi-subagents',
    name: 'pi-subagents',
    displayName: packageLabel('npm:pi-subagents'),
    kind: 'npm',
    scope: 'user',
    current: '2.3.1',
    latest: '2.4.0',
    changelogUrl: 'https://www.npmjs.com/package/pi-subagents?activeTab=versions'
  },
  {
    source: 'npm:pi-lens',
    name: 'pi-lens',
    displayName: packageLabel('npm:pi-lens'),
    kind: 'npm',
    scope: 'user',
    current: '0.6.2',
    latest: '0.7.0',
    changelogUrl: 'https://www.npmjs.com/package/pi-lens?activeTab=versions'
  },
  {
    source: 'git:github.com/paoloanzn/pi-black',
    name: 'github.com/paoloanzn/pi-black',
    displayName: packageLabel('git:github.com/paoloanzn/pi-black'),
    kind: 'git',
    scope: 'user',
    current: '3f9c2e1',
    changelogUrl: 'https://github.com/paoloanzn/pi-black/commits'
  }
]

/** The service's own state; `getState()` adds the offline state, read live like the Engine 2 service does. */
type StoredUpdatesState = Omit<UpdatesState, 'offline' | 'offlineReason'>

export class UpdatesService {
  private state: StoredUpdatesState
  private readonly app: AppUpdates
  private nextCheck: NodeJS.Timeout | null = null
  /** Launch time plus LAUNCH_DELAY_MS; 0 until start() and after stop(), when nothing schedules. */
  private checksFrom = 0
  private stopPrefsListener: (() => void) | null = null
  private autoRetry: NodeJS.Timeout | null = null
  private versionWatcher: FSWatcher | null = null
  private versionDebounce: NodeJS.Timeout | null = null
  private knownVersion: string | null = null

  constructor(
    private readonly manager: EngineManager,
    private readonly override: () => string | null,
    private readonly hooks: UpdatesServiceHooks
  ) {
    this.app = new AppUpdates(app, () => this.publish({ app: this.app.info }))
    this.state = {
      engineId: 'pi',
      checking: false,
      lastChecked: null,
      engine: null,
      packages: [],
      app: this.app.info,
      running: null,
      count: 0
    }
  }

  start(): void {
    this.checksFrom = Date.now() + LAUNCH_DELAY_MS
    this.scheduleCheck()
    this.stopPrefsListener = appState.onPrefsChange((next, previous) => {
      if (updatesScheduleChanged(next, previous)) this.scheduleCheck()
    })
    void this.watchEngineVersion()
  }

  stop(): void {
    this.checksFrom = 0
    this.stopPrefsListener?.()
    this.stopPrefsListener = null
    if (this.nextCheck) clearTimeout(this.nextCheck)
    this.nextCheck = null
    if (this.autoRetry) clearTimeout(this.autoRetry)
    if (this.versionDebounce) clearTimeout(this.versionDebounce)
    this.versionWatcher?.close()
  }

  /** Managed installs switch versions by rewriting `install/current-version` (pi-launcher.js). */
  private async watchEngineVersion(): Promise<void> {
    let location: EngineLocation
    try {
      location = await locateEngine(this.override())
    } catch {
      return
    }
    this.knownVersion = location.version
    const root = location.managedInstallRoot
    if (!root || !existsSync(root)) return
    try {
      this.versionWatcher = watch(root, { persistent: false }, (_event, filename) => {
        if (filename !== 'current-version') return
        if (this.versionDebounce) clearTimeout(this.versionDebounce)
        this.versionDebounce = setTimeout(() => void this.onVersionFileChanged(), 600)
      })
      this.versionWatcher.on('error', () => this.versionWatcher?.close())
    } catch {
      this.versionWatcher = null
    }
  }

  private async onVersionFileChanged(): Promise<void> {
    try {
      const location = await locateEngine(this.override(), true)
      if (location.version === this.knownVersion) return
      const from = this.knownVersion ?? undefined
      this.knownVersion = location.version
      clearExtensionFlagCache()
      if (this.state.engine) {
        this.publish({
          engine: {
            ...this.state.engine,
            current: location.version,
            available: false
          }
        })
      }
      this.hooks.broadcast('updates:engine-changed', { engineId: 'pi', from, to: location.version })
    } catch {
      // A half-written install: the next change event retries.
    }
  }

  /** The installed engine's CHANGELOG.md (in-app viewer and `/changelog`). */
  async changelog(): Promise<EngineChangelog> {
    if (env.mock)
      return { version: MOCK_ENGINE.current, path: 'CHANGELOG.md', markdown: MOCK_CHANGELOG }
    const location = await locateEngine(this.override())
    const path = join(location.packageDir, 'CHANGELOG.md')
    if (!existsSync(path)) throw new Error('This engine version ships without a changelog.')
    return { version: location.version, path, markdown: readFileSync(path, 'utf8') }
  }

  getState(): UpdatesState {
    const offline = updatesOfflineReason()
    return { ...this.state, offline: !!offline, offlineReason: offline ?? undefined }
  }

  async load(): Promise<UpdatesState> {
    if (!this.state.engine) {
      try {
        this.publish({ engine: env.mock ? MOCK_ENGINE : await this.checkEngine() })
      } catch (error) {
        this.publish({ error: (error as Error).message })
      }
    }
    return this.getState()
  }

  private publish(patch: Partial<StoredUpdatesState>): void {
    const next = { ...this.state, ...patch }
    const appCount =
      next.app.status === 'available' ||
      next.app.status === 'ready' ||
      next.app.status === 'downloading'
        ? 1
        : 0
    next.count = (next.engine?.available ? 1 : 0) + next.packages.length + appCount
    this.state = next
    this.hooks.broadcast('updates:state', this.getState())
  }

  /** One timer for every background check: launch, interval, offline retry. Stopped: no timer. */
  private scheduleCheck(): void {
    if (this.nextCheck) clearTimeout(this.nextCheck)
    this.nextCheck = null
    if (!this.checksFrom) return
    const delay = nextCheckDelay(this.state.lastChecked, this.checksFrom)
    if (delay === null) return
    this.nextCheck = setTimeout(() => {
      this.nextCheck = null
      void this.maybeCheck()
    }, delay)
  }

  private async maybeCheck(): Promise<void> {
    const { mode = 'notify', intervalHours = DEFAULT_UPDATE_INTERVAL_HOURS } = prefs()
    // A running check reschedules when it ends.
    if (this.state.checking) return
    const due =
      this.state.lastChecked === null ||
      Date.now() - this.state.lastChecked >= intervalHours * HOUR_MS
    if (mode === 'off' || !due) {
      this.scheduleCheck()
      return
    }
    await this.check()
    if (mode === 'automatic') this.applyAutomatically()
  }

  /** Work offline on/off: persists the pref, then pauses checks or resumes them right away. */
  setOffline(offline: boolean): UpdatesState {
    appState.setPrefs({ features: { updates: { ...prefs(), offline: offline || undefined } } })
    if (offline) {
      this.publish({ checking: false })
    } else {
      this.publish({})
      void this.maybeCheck()
    }
    return this.getState()
  }

  async check(): Promise<UpdatesState> {
    if (this.state.checking) return this.getState()
    if (updatesOfflineReason()) {
      await this.load()
      this.publish({ checking: false })
      this.scheduleCheck()
      return this.getState()
    }
    this.publish({ checking: true, error: undefined })
    try {
      const [engine, packages] = env.mock
        ? [MOCK_ENGINE, MOCK_PACKAGES]
        : await Promise.all([this.checkEngine(), this.checkPackages()])
      this.publish({ engine, packages, lastChecked: Date.now(), checking: false })
    } catch (error) {
      this.publish({ checking: false, lastChecked: Date.now(), error: (error as Error).message })
    }
    this.scheduleCheck()
    await this.checkApp()
    return this.getState()
  }

  async checkApp(): Promise<void> {
    if (updatesOfflineReason()) return
    const { mode = 'notify', feedUrl } = prefs()
    await this.app.check(feedUrl?.trim() || undefined, mode === 'automatic')
  }

  private async checkEngine(): Promise<EngineUpdateInfo | null> {
    const location = await locateEngine(this.override(), true)
    return {
      current: location.version,
      managedByApp: location.source === 'bundled',
      available: false,
      note:
        location.source === 'bundled'
          ? ENGINE_UPDATE_MESSAGE
          : 'Custom engine. Updates are managed outside Vengeance.',
      changelogUrl: ENGINE_CHANGELOG
    }
  }

  private async checkPackages(): Promise<PackageUpdateInfo[]> {
    const cwd = appState.getPrefs().activeWorkspace
    // N15: same rule as `pi update` (useSavedProjectTrustOnly): only a saved "trusted" decision checks project packages.
    const projectTrusted =
      cwd !== null && (await trustPreflight(this.override(), cwd)).saved === true
    const scope: PackageScope = {
      cwd: cwd ? projectRoot(cwd) : agentDir(),
      agentDir: agentDir(),
      projectTrusted
    }
    // The engine checks only the packages settings list: with none, the SDK host has nothing to answer.
    const listed = [
      ...readSettingsList(join(scope.agentDir, 'settings.json'), 'packages'),
      ...(projectTrusted
        ? readSettingsList(join(scope.cwd, '.pi', 'settings.json'), 'packages')
        : [])
    ]
    if (listed.length === 0) return []
    const { updates, configured } = await sdkHostCall(this.override(), 'package-updates', scope)
    return Promise.all(
      updates.map(async (update): Promise<PackageUpdateInfo> => {
        const installedPath = configured.find(
          (c) => c.source === update.source && c.scope === update.scope
        )?.installedPath
        const kind = packageKind(update.source) === 'git' ? 'git' : 'npm'
        const name = packageDisplayName(update.source)
        const displayName = packageLabel(update.source)
        if (kind === 'git') {
          return {
            source: update.source,
            name,
            displayName,
            kind,
            scope: update.scope,
            current: installedPath ? await gitShortHead(installedPath) : undefined,
            changelogUrl: gitWebUrl(update.source)
          }
        }
        const current = installedPath
          ? readJsonFile(join(installedPath, 'package.json')).data.version
          : undefined
        const release = await latestNpmRelease(this.override(), scope, name)
        return {
          source: update.source,
          name,
          displayName,
          kind,
          scope: update.scope,
          current: typeof current === 'string' ? current : undefined,
          latest: release.version,
          changelogUrl: npmChangelogUrl(name, release)
        }
      })
    )
  }

  async run(args: RunUpdateArgs, automatic = false): Promise<string> {
    if (args.engine && args.engine !== 'pi') throw new Error('Choose the matching engine updater.')
    if (['engine', 'all', 'rollback'].includes(args.target)) throw new Error(ENGINE_UPDATE_MESSAGE)
    if (updatesOfflineReason()) throw new Error('Turn off offline mode before updating.')
    if (this.state.running) throw new Error('An update is already running.')
    if (
      args.target === 'package' &&
      (!args.source?.trim() || args.source.startsWith('-') || ['pi', 'self'].includes(args.source))
    ) {
      throw new Error('Choose a package to update.')
    }
    const cliArgs = updateCliArgs(args)
    const onLog = (event: ProcessLogEvent) => this.hooks.broadcast('updates:log', event)
    const onDone = (event: ProcessDoneEvent) => {
      void this.finishRun(args, automatic, event).catch((error: Error) =>
        this.publish({ running: null, error: error.message })
      )
    }
    const cwd =
      args.target === 'package' &&
      this.state.packages.find((p) => p.source === args.source)?.scope === 'project'
        ? appState.getPrefs().activeWorkspace
        : null
    const run = env.mock
      ? simulatePiCli(cliArgs, mockUpdateSteps(args, this.state), { onLog, onDone })
      : await streamPiCli(this.override(), cliArgs, {
          cwd: cwd ? projectRoot(cwd) : agentDir(),
          onLog,
          onDone
        })
    this.publish({ running: { runId: run.runId, target: args.target, source: args.source } })
    return run.runId
  }

  private async finishRun(
    args: RunUpdateArgs,
    automatic: boolean,
    event: ProcessDoneEvent
  ): Promise<void> {
    const packages = args.target === 'packages' || args.target === 'package'
    if (event.ok) clearExtensionFlagCache()
    this.hooks.broadcast('updates:done', { ...event, target: args.target })
    this.publish({ running: null })
    if (!event.ok) return
    this.publish({
      packages:
        args.target === 'package'
          ? this.state.packages.filter((p) => p.source !== args.source)
          : packages
            ? []
            : this.state.packages
    })
    // A model catalog refresh needs no engine restart; the renderer reloads the catalog on updates:done.
    if (packages)
      this.hooks.broadcast('updates:applied', {
        engineId: 'pi',
        engine: false,
        packages,
        automatic
      })
  }

  /** Automatic mode: apply when nothing is streaming; otherwise retry until every agent settled. */
  private applyAutomatically(): void {
    if (this.autoRetry) clearTimeout(this.autoRetry)
    const packages = this.state.packages.length > 0
    if (!packages || this.state.running) return
    if (this.manager.anyBusy('pi')) {
      this.autoRetry = setTimeout(() => this.applyAutomatically(), BUSY_RETRY_MS)
      return
    }
    void this.run({ target: 'packages' }, true).catch((error: Error) =>
      this.publish({ error: error.message })
    )
  }

  downloadApp(): Promise<void> {
    if (updatesOfflineReason())
      return Promise.reject(new Error('Turn off offline mode before downloading.'))
    return this.app.download()
  }

  installApp(): void {
    this.app.install()
  }
}

function updateCliArgs(args: RunUpdateArgs): string[] {
  switch (args.target) {
    case 'rollback':
    case 'engine':
    case 'all':
      throw new Error(ENGINE_UPDATE_MESSAGE)
    case 'packages':
      return ['update', '--extensions']
    case 'models':
      return ['update', '--models']
    case 'package':
      return ['update', args.source!]
  }
}

function mockUpdateSteps(args: RunUpdateArgs, state: StoredUpdatesState): Array<[number, string]> {
  const steps: Array<[number, string]> = []
  if (args.target === 'models') {
    return [
      [260, 'Refreshing model catalogs\u2026\n'],
      [520, '\x1b[2mfetched catalog overlay (214 models, 31 providers)\x1b[22m\n'],
      [240, '\x1b[32mModel catalogs are up to date\x1b[39m\n']
    ]
  }
  const packages =
    args.target === 'package'
      ? state.packages.filter((p) => p.source === args.source)
      : state.packages
  for (const pkg of packages) {
    steps.push(
      [360, `Updating ${pkg.name}${pkg.latest ? ` → ${pkg.latest}` : ''}…\n`],
      [520, `\x1b[2mchanged 3 packages in 2s\x1b[22m\n`],
      [160, `\x1b[32mUpdated ${pkg.name}\x1b[39m\n`]
    )
  }
  return steps.length ? steps : [[200, 'Everything is up to date.\n']]
}
