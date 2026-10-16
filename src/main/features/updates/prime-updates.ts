import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AppUpdateInfo,
  EngineChangelog,
  EngineUpdateChannel,
  RunUpdateArgs,
  UpdatesState
} from '@shared/api/updates'
import { appState } from '../../app-state'
import { ENGINE_UPDATE_MESSAGE } from '../../engine/bundled'
import { connectPrimeDaemon } from '../../engine/prime/daemon'
import { getPrimeAgentDir, locatePrimeEngine } from '../../engine/prime/locate'
import { env } from '../../env'
import {
  nextCheckDelay,
  updatesOfflineReason,
  updatesScheduleChanged,
  type UpdatesServiceHooks
} from './updates-service'

const LAUNCH_DELAY_MS = 8_000
const PRIME_CHANGELOG_URL = 'https://github.com/PrimeIntellect-ai/prime-agent/releases'

export class PrimeUpdatesService {
  private state: UpdatesState
  private nextCheck?: NodeJS.Timeout
  private checksFrom = 0
  private stopPrefsListener?: () => void
  private readonly controller = new AbortController()

  constructor(
    private readonly override: () => string | null,
    private readonly appInfo: () => AppUpdateInfo,
    private readonly hooks: UpdatesServiceHooks
  ) {
    this.state = {
      engineId: 'prime',
      checking: false,
      lastChecked: null,
      offline: false,
      engine: null,
      packages: [],
      app: appInfo(),
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
  }

  stop(): void {
    this.checksFrom = 0
    this.stopPrefsListener?.()
    this.stopPrefsListener = undefined
    clearTimeout(this.nextCheck)
    this.controller.abort()
  }

  private scheduleCheck(): void {
    clearTimeout(this.nextCheck)
    this.nextCheck = undefined
    if (!this.checksFrom) return
    const delay = nextCheckDelay(this.state.lastChecked, this.checksFrom)
    if (delay === null) return
    this.nextCheck = setTimeout(() => void this.check(), delay)
  }

  getState(): UpdatesState {
    const offline = updatesOfflineReason()
    const app = this.appInfo()
    return {
      ...this.state,
      app,
      count: Number(['available', 'ready', 'downloading'].includes(app.status)),
      offline: !!offline,
      offlineReason: offline ?? undefined
    }
  }

  private publish(patch: Partial<UpdatesState>): void {
    this.state = { ...this.state, ...patch }
    this.hooks.broadcast('updates:state', this.getState())
  }

  async load(): Promise<UpdatesState> {
    if (this.state.engine) return this.getState()
    return this.check()
  }

  async check(): Promise<UpdatesState> {
    if (this.state.checking) return this.getState()
    this.publish({ checking: true, error: undefined })
    try {
      const location = env.mock
        ? { version: '0.10.0+vengeance.1', source: 'bundled' }
        : await locatePrimeEngine(this.override())
      this.publish({
        checking: false,
        lastChecked: Date.now(),
        engine: {
          current: location.version,
          available: false,
          managedByApp: location.source === 'bundled',
          note:
            location.source === 'bundled'
              ? ENGINE_UPDATE_MESSAGE
              : 'Custom engine. Updates are managed outside Vengeance.',
          changelogUrl: PRIME_CHANGELOG_URL
        }
      })
    } catch (error) {
      this.publish({ checking: false, lastChecked: Date.now(), error: (error as Error).message })
    }
    this.scheduleCheck()
    return this.getState()
  }

  async setChannel(_channel: EngineUpdateChannel): Promise<UpdatesState> {
    throw new Error(ENGINE_UPDATE_MESSAGE)
  }

  async run(args: RunUpdateArgs, automatic = false): Promise<string> {
    if (args.engine && args.engine !== 'prime')
      throw new Error('Choose the matching engine updater.')
    if (['engine', 'all', 'rollback'].includes(args.target)) throw new Error(ENGINE_UPDATE_MESSAGE)
    if (this.state.running) throw new Error('An Engine 2 update is already running.')
    if (updatesOfflineReason()) throw new Error('Turn off offline mode before updating.')
    if (
      args.target === 'package' &&
      (!args.source?.trim() ||
        args.source.startsWith('-') ||
        ['self', 'pi', 'prime-agent'].includes(args.source))
    )
      throw new Error('Choose a package source to update.')
    const runId = randomUUID()
    this.publish({ running: { runId, target: args.target }, error: undefined })
    setImmediate(() => void this.update(runId, args, automatic))
    return runId
  }

  private async update(runId: string, args: RunUpdateArgs, automatic: boolean): Promise<void> {
    const packages = args.target === 'packages' || args.target === 'package'
    try {
      if (!env.mock && packages)
        await this.updatePackages(runId, args.target === 'package' ? args.source : undefined)
      if (!env.mock && args.target === 'models') {
        const client = await connectPrimeDaemon({ executablePath: this.override() })
        try {
          await client.request('get_model_catalog')
        } finally {
          client.close()
        }
      }
      this.publish({ running: null })
      this.hooks.broadcast('updates:done', { runId, target: args.target, code: 0, ok: true })
      if (packages)
        this.hooks.broadcast('updates:applied', {
          engineId: 'prime',
          engine: false,
          packages,
          automatic
        })
    } catch (error) {
      const message = (error as Error).message
      this.publish({ running: null, error: message })
      this.hooks.broadcast('updates:done', {
        runId,
        target: args.target,
        code: null,
        ok: false,
        error: message
      })
    }
  }

  private async updatePackages(runId: string, source?: string): Promise<void> {
    const location = await locatePrimeEngine(this.override())
    const args = ['package', 'update', ...(source ? [source] : [])]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(location.executablePath, args, {
        cwd: getPrimeAgentDir(),
        windowsHide: true,
        signal: this.controller.signal,
        env: {
          ...process.env,
          PRIME_AGENT_CODING_AGENT_DIR: getPrimeAgentDir(),
          PI_PACKAGE_DIR: location.packageDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (text: string) =>
        this.hooks.broadcast('updates:log', { runId, text, stream: 'stdout' })
      )
      child.stderr.on('data', (text: string) =>
        this.hooks.broadcast('updates:log', { runId, text, stream: 'stderr' })
      )
      child.once('error', reject)
      child.once('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Engine 2 package update exited with code ${code}.`))
      )
    })
  }

  async changelog(): Promise<EngineChangelog> {
    if (env.mock)
      return {
        version: '0.10.0+vengeance.1',
        path: '',
        markdown: '## Engine 2\n\nIncluded with Vengeance.'
      }
    const location = await locatePrimeEngine(this.override())
    const path = join(location.packageDir, 'CHANGELOG.md')
    try {
      return { version: location.version, path, markdown: await readFile(path, 'utf8') }
    } catch {
      return {
        version: location.version,
        path: '',
        markdown: `## ${location.version}\n\n[Read upstream release notes](${PRIME_CHANGELOG_URL}).`
      }
    }
  }
}
