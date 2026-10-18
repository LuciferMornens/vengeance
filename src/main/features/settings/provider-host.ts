import type { SettingsChangeArea } from '@shared/api/settings'
import { appState } from '../../app-state'
import { callWithSignIn, HostProcess, spawnHost, type HostFailureTexts } from '../../engine/host-process'
import { locateEngine } from '../../engine/locate'
import { trustPreflight } from '../launch/trust'
import { agentDir, projectRoot } from './agent-dir'
import { hasEnabledUserExtensions, invalidateConfiguredPackagesCache } from './packages'
import type { AuthInteractionLike } from './pi-modules'
import type { ExtensionProviders, HostCall, ProviderHostConfig } from './provider-host-protocol'

/**
 * Providers registered by extensions, read through the provider host (`provider-host-entry.ts`): a child process
 * that loads the extensions, so their code never runs in the main process. The host starts only when the
 * Providers page asks for extension providers or a sign-in targets one, and exits after a minute without work.
 * The last list is kept here, so the regular catalog includes it without starting anything.
 */

/** How long an unused host stays up: long enough for the Providers page, short enough to free its memory. */
const IDLE_MS = 60_000
/** Loading every extension can take a while on a cold start (TypeScript extensions are compiled on load). */
const LIST_TIMEOUT_MS = 60_000
/** The host aborts a logout after 15 s; this covers the start of a fresh host on top. */
const LOGOUT_TIMEOUT_MS = 45_000

const FAILURE_TEXTS: HostFailureTexts = {
  start: 'The extensions could not be started.',
  crashed: 'The extensions stopped unexpectedly.',
  cancelled: 'Cancelled: the extensions were reloaded.',
  timedOut: 'Extensions took too long to load.'
}

/** Areas that change which extensions load: installed and enabled packages, extension resources, project trust. */
const EXTENSION_AREAS = new Set<SettingsChangeArea>(['packages', 'resources', 'trust'])

let host: HostProcess | null = null
let cached: { scope: string; providers: ExtensionProviders } | null = null
let refreshing: Promise<unknown> | null = null

/** Which engine and workspace a cached list belongs to. */
function scopeOf(override: string | null): string {
  return `${override ?? ''}\n${appState.getPrefs().activeWorkspace ?? ''}`
}

async function startedHost(override: string | null): Promise<HostProcess> {
  const cwd = appState.getPrefs().activeWorkspace ?? null
  const location = await locateEngine(override)
  const config: ProviderHostConfig = {
    role: 'extensions',
    packageDir: location.packageDir,
    agentDir: agentDir(),
    cwd: cwd ? projectRoot(cwd) : agentDir(),
    // Project extensions count only when the engine would load them (N15, same rule as packages.ts).
    projectTrusted: cwd !== null && (await trustPreflight(override, cwd)).engineDefault
  }
  const key = `${location.packageDir}\n${config.cwd}\n${config.projectTrusted}`
  if (host?.alive && host.key === key) return host
  host?.dispose()
  host = new HostProcess(key, spawnHost(location, config, config.cwd), IDLE_MS, FAILURE_TEXTS, (exited) => {
    if (host === exited) host = null
  })
  return host
}

function call(target: HostProcess, request: HostCall, timeoutMs: number): Promise<unknown> {
  return target.call(request, { timeoutMs }).done
}

/** Re-read the extension providers of the active workspace (starts the host when needed). */
export async function refreshExtensionProviders(override: string | null): Promise<void> {
  const scope = scopeOf(override)
  const run = (async () => {
    if (!host?.alive) {
      const cwd = appState.getPrefs().activeWorkspace ?? null
      const projectTrusted = cwd !== null && (await trustPreflight(override, cwd)).engineDefault
      if (!(await hasEnabledUserExtensions(override, cwd, projectTrusted))) {
        cached = { scope, providers: { providers: [], models: [], modifiedBy: {} } }
        return
      }
    }
    const target = await startedHost(override)
    // SAFETY: protocol boundary — the host answers `extension-providers` with ExtensionProviders.
    const providers = (await call(target, { type: 'extension-providers' }, LIST_TIMEOUT_MS)) as ExtensionProviders | undefined
    if (providers) cached = { scope, providers }
  })()
  refreshing = run
  try {
    await run
  } finally {
    if (refreshing === run) refreshing = null
  }
}

/** The last list read for the active workspace, without starting the host (waits for a read in progress). */
export async function cachedExtensionProviders(override: string | null): Promise<ExtensionProviders | null> {
  await refreshing?.catch(() => undefined)
  return cached?.scope === scopeOf(override) ? cached.providers : null
}

/** Sign in to a provider only an extension registers, relaying the flow's prompts and notices to `ui`. */
export async function loginThroughHost(override: string | null, providerId: string, method: 'oauth' | 'api_key', ui: AuthInteractionLike): Promise<void> {
  const request: HostCall = { type: 'login', providerId, method }
  await callWithSignIn(await startedHost(override), request, ui)
}

export async function logoutThroughHost(override: string | null, providerId: string): Promise<void> {
  await call(await startedHost(override), { type: 'logout', providerId }, LOGOUT_TIMEOUT_MS)
}

/**
 * A change that alters the loaded extensions stops the host and forgets its list. settings.json can list extensions
 * too, but it changes for many other reasons (a sign-in writes the device id): an idle host is stopped so the next
 * read loads the new settings, and the list is kept until then.
 */
export function noteProviderConfigChange(area: SettingsChangeArea): void {
  if (area === 'settings' || EXTENSION_AREAS.has(area)) {
    invalidateConfiguredPackagesCache()
  }
  if (area === 'settings' && !host?.busy) {
    disposeProviderHost()
  } else if (EXTENSION_AREAS.has(area)) {
    cached = null
    disposeProviderHost()
  }
}

/** Settings closed: shorten the interactive keep-alive window so an idle host exits promptly. */
export function releaseProviderHost(): void {
  host?.trimIdle(1_500)
}

/** Stop the host and everything it started (app quit). */
export function disposeProviderHost(): void {
  host?.dispose()
}
