import { shell } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { SettingsChangeArea, SettingsEventMap } from '@shared/api/settings'
import type { IpcContext } from './context'
import { broadcast, handle, onQuit } from './handle'
import { appState } from '../app-state'
import { disposeSdkHost, prewarmSdkHost, releaseSdkHost } from '../engine/sdk-host/client'
import { isInside } from '../paths'
import { ACCOUNT_PROVIDER, refreshAccountModels } from '../features/settings/account-models'
import { agentDir, prepareAgentDir, projectRoot } from '../features/settings/agent-dir'
import { clearExtensionFlagCache } from '../features/launch/flags'
import { setProjectTrust, trustPreflight } from '../features/launch/trust'
import { ConfigWatcher } from '../features/settings/config-watcher'
import {
  contextOverview,
  readInstructionFile,
  writeInstructionFile
} from '../features/settings/instructions'
import { readKeybindings, writeKeybindings } from '../features/settings/keybindings'
import {
  mcpAuth,
  mcpLogTail,
  mcpOverview,
  mcpServerDraft,
  mcpStatus,
  removeMcpServer,
  saveMcpServer,
  setAutoEnableCodemode,
  updateMcpServer
} from '../features/settings/mcp'
import {
  cancelLogin,
  catalogWithExtensionProviders,
  checkAuth,
  logout,
  modelCatalog,
  readModelsJson,
  refillModelCatalog,
  respondLogin,
  startLogin,
  validateModelsJson,
  writeModelsJson
} from '../features/settings/models'
import {
  listPackages,
  listResources,
  runPackageAction,
  setPackageEnabled,
  toggleResource
} from '../features/settings/packages'
import { cancelRun } from '../features/settings/pi-cli'
import {
  disposeProviderHost,
  noteProviderConfigChange,
  releaseProviderHost
} from '../features/settings/provider-host'
import {
  setSetting,
  settingsSnapshot,
  validateRawSettings,
  writeRawSettings
} from '../features/settings/settings-store'
import { installedThemeNames } from '../features/settings/themes'
import { listTrust, updateTrustEntry } from '../features/settings/trust'

/** Files the OS may open with their default app; everything else is only revealed (never executed). */
const OPENABLE_EXTENSIONS = new Set(['.md', '.json', '.jsonl'])

/** S1: directories open; .md/.json/.jsonl open only inside the agent dir or the active project. */
async function openPathSafely(path: string): Promise<void> {
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new Error(`${path} does not exist.`)
  }
  const workspace = appState.getPrefs().activeWorkspace
  const roots = [agentDir(), ...(workspace ? [projectRoot(workspace)] : [])].map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })
  const openable =
    statSync(real).isDirectory() ||
    (OPENABLE_EXTENSIONS.has(extname(real).toLowerCase()) &&
      roots.some((root) => isInside(root, real)))
  if (!openable) {
    shell.showItemInFolder(real)
    return
  }
  const error = await shell.openPath(real)
  if (error) throw new Error(error)
}

const ACCOUNT_MODELS_FIRST_CHECK_MS = 4000
const ACCOUNT_MODELS_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Areas that can change which extensions load, and with them the flags the engine's `--help` lists. */
const FLAG_AREAS = new Set<SettingsChangeArea>(['settings', 'packages', 'resources'])

function invalidateFlagsFor(area: SettingsChangeArea): void {
  if (FLAG_AREAS.has(area)) clearExtensionFlagCache()
}

/** Settings feature: engine settings, providers & auth, custom models, packages, resources, MCP, instructions, trust, keybindings. */
export function registerSettingsIpc(context: IpcContext): void {
  void prepareAgentDir()
  const override = () => context.engineOverridePath()
  /** `force`: re-read the account's models now (a sign-in through Vengeance); otherwise only when the list is stale. */
  const checkAccountModels = (force: boolean) =>
    void refreshAccountModels(override(), force).then(
      (changed) =>
        changed &&
        broadcast('settings:account-models', { providerId: ACCOUNT_PROVIDER, engine: 'pi' })
    )
  /** What every change (outside or our own) invalidates, before `settings:changed` goes out. */
  const noteChange = (area: SettingsChangeArea) => {
    invalidateFlagsFor(area)
    noteProviderConfigChange(area)
    if (area === 'models' || area === 'auth') refillModelCatalog(override())
  }
  const watcher = new ConfigWatcher(
    (area, projectCwd, fromRun) => {
      noteChange(area)
      // Engines rewrite auth.json when they refresh a token: a cheap local check, no fetch unless the list is stale.
      if (area === 'auth') checkAccountModels(false)
      const event = { area, external: true, engine: 'pi' as const, ...(fromRun ? { fromRun } : {}) }
      if (!projectCwd) {
        broadcast('settings:changed', event)
        return
      }
      // A project's config only concerns that folder's sessions, and only once the folder is trusted.
      void trustPreflight(override(), projectCwd)
        .then((trust) => trust.engineDefault)
        .catch(() => false)
        .then((trusted) =>
          broadcast('settings:changed', { ...event, project: { cwd: projectCwd, trusted } })
        )
    },
    () => context.manager.list().some((agent) => agent.status === 'starting')
  )
  watcher.start()
  // Before the will-quit temp-dir cleanup: open watcher handles keep the mock dir locked on Windows.
  onQuit('before-quit', () => watcher.stop())
  onQuit('will-quit', disposeProviderHost)
  onQuit('will-quit', disposeSdkHost)
  // After startup settles, every six hours while Vengeance runs, and when Work offline is turned off.
  setTimeout(() => checkAccountModels(false), ACCOUNT_MODELS_FIRST_CHECK_MS).unref()
  setInterval(() => checkAccountModels(false), ACCOUNT_MODELS_INTERVAL_MS).unref()
  const stopOfflineListener = appState.onPrefsChange((next, previous) => {
    if (previous.features.updates?.offline && !next.features.updates?.offline) checkAccountModels(false)
  })
  onQuit('before-quit', stopOfflineListener)

  const changed = (
    area: SettingsChangeArea,
    project?: SettingsEventMap['settings:changed']['project']
  ) => {
    noteChange(area)
    watcher.noteSelfChange(area)
    broadcast(
      'settings:changed',
      project ? { area, project, engine: 'pi' } : { area, engine: 'pi' }
    )
  }
  const log = (event: SettingsEventMap['settings:process-log']) =>
    broadcast('settings:process-log', { ...event, engine: 'pi' })
  /** `projectCwd`: the run only touched that project's `.pi`, so only its sessions (when they load it) are concerned. */
  const done =
    (area: 'packages' | 'mcp', projectCwd: string | null = null) =>
    (event: SettingsEventMap['settings:process-done']) => {
      broadcast('settings:process-done', { ...event, engine: 'pi' })
      if (!event.ok) return
      if (!projectCwd) return changed(area)
      void trustPreflight(override(), projectCwd)
        .then((trust) => changed(area, { cwd: projectCwd, trusted: trust.engineDefault }))
        .catch(() => changed(area))
    }
  /**
   * A sign-in or sign-out through Vengeance. The ChatGPT account's models are read now (even working offline: the
   * user just signed in); any other provider's only re-checks them when stale, like an outside auth change.
   */
  const accountSignInChanged = (providerId: string) =>
    checkAccountModels(providerId === ACCOUNT_PROVIDER)
  /** Run a write, then announce the change (muting the watcher for our own write). */
  const write = async <T>(area: SettingsChangeArea, run: () => Promise<T>): Promise<T> => {
    watcher.noteSelfChange(area)
    const result = await run()
    changed(area)
    return result
  }

  handle('settings:snapshot', (cwd) => settingsSnapshot(override(), cwd))
  handle('settings:prewarm', () => prewarmSdkHost(override()))
  handle('settings:release', () => {
    releaseSdkHost()
    releaseProviderHost()
  })
  handle('settings:set', (args) => write('settings', () => setSetting(override(), args)))
  handle('settings:validate', (text, scope) => validateRawSettings(text, scope))
  handle('settings:write-raw', (args) =>
    write('settings', () => writeRawSettings(override(), args))
  )
  handle('settings:set-trust', (cwd, decision) =>
    write('trust', async () => {
      await setProjectTrust(override(), cwd, decision)
      return settingsSnapshot(override(), cwd)
    })
  )

  handle('settings:catalog', () => modelCatalog(override(), context.manager))
  handle('settings:extension-providers', () =>
    catalogWithExtensionProviders(override(), context.manager)
  )
  handle('settings:auth-login', (args) => {
    watcher.noteSelfChange('auth')
    return startLogin(
      override(),
      args,
      (event) => broadcast('settings:auth-event', { ...event, engine: 'pi' }),
      () => {
        changed('auth')
        accountSignInChanged(args.providerId)
      }
    )
  })
  handle('settings:auth-respond', (loginId, promptId, value) =>
    respondLogin(loginId, promptId, value)
  )
  handle('settings:auth-cancel', (loginId) => cancelLogin(loginId))
  handle('settings:auth-logout', async (providerId) => {
    await write('auth', () => logout(override(), providerId))
    accountSignInChanged(providerId)
    return modelCatalog(override(), context.manager)
  })
  handle('settings:auth-check', (providerId) => checkAuth(override(), providerId))

  handle('settings:models-json', () => readModelsJson())
  handle('settings:models-json-validate', (data) => validateModelsJson(data))
  handle('settings:models-json-write', (data) =>
    write('models', () => writeModelsJson(override(), data))
  )

  handle('settings:packages', (cwd) => listPackages(override(), cwd))
  handle(
    'settings:package-run',
    async (args) =>
      (
        await runPackageAction(
          override(),
          args,
          log,
          done('packages', args.local ? args.cwd : null)
        )
      ).runId
  )
  handle('settings:package-enable', (cwd, pkg, enabled) =>
    write('packages', () => setPackageEnabled(override(), cwd, pkg, enabled))
  )

  handle('settings:resources', (cwd) => listResources(override(), cwd))
  handle('settings:resource-toggle', (args) =>
    write('resources', () => toggleResource(override(), args))
  )
  handle('settings:themes', (cwd) => installedThemeNames(override(), cwd))

  handle('settings:mcp', (cwd) => mcpOverview(override(), cwd))
  handle('settings:mcp-status', (cwd) => mcpStatus(override(), cwd))
  handle('settings:mcp-server', (cwd, name, scope) => mcpServerDraft(cwd, name, scope))
  handle('settings:mcp-save', (args) => write('mcp', () => saveMcpServer(override(), args)))
  handle('settings:mcp-remove', (cwd, name, local) =>
    write('mcp', () => removeMcpServer(override(), cwd, name, local))
  )
  handle('settings:mcp-update', (cwd, name, patch) =>
    write('mcp', () => updateMcpServer(override(), cwd, name, patch))
  )
  handle('settings:mcp-codemode', (cwd, scope, value) =>
    write('mcp', () => setAutoEnableCodemode(override(), cwd, scope, value))
  )
  handle('settings:mcp-log', (maxBytes) => mcpLogTail(maxBytes))
  handle(
    'settings:mcp-auth',
    async (cwd, name, action) =>
      (await mcpAuth(override(), cwd, name, action, log, done('mcp'))).runId
  )

  handle('settings:context', (cwd) => contextOverview(override(), cwd))
  handle('settings:instruction-file', (cwd, ref) => readInstructionFile(cwd, ref))
  handle('settings:instruction-file-write', (cwd, ref, text) =>
    write('instructions', () => writeInstructionFile(cwd, ref, text))
  )

  handle('settings:trust-list', () => listTrust())
  handle('settings:trust-entry', (path, decision) =>
    write('trust', () => updateTrustEntry(override(), path, decision))
  )

  handle('settings:keybindings', () => readKeybindings(override()))
  handle('settings:keybindings-write', (bindings) =>
    write('keybindings', () => writeKeybindings(override(), bindings))
  )

  handle('settings:open-path', (path) => openPathSafely(path))
  handle('settings:cancel-run', (runId) => {
    cancelRun(runId)
  })
}
