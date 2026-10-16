import { basename, dirname, extname, join } from 'node:path'
import { describeProvider, importEngineFile, SignIns } from '../../engine/sdk-host/host-engine'
import { serveSdkHost } from '../../engine/sdk-host/host'
import type { SdkHostConfig } from '../../engine/sdk-host/protocol'
import type { ExtensionLoaderModule, ModelLike, ModelRuntimeLike, PiSdkSurface } from './pi-modules'
import type { ExtensionProviders, HostMessage, HostModel, HostRequest, ProviderHostConfig } from './provider-host-protocol'

/**
 * Entry of the host bundle (`provider-host.js`), a child process of Vengeance that runs the installed engine's code
 * so the main process never loads it. Its first argument picks the role: the SDK host (`engine/sdk-host`) or the
 * provider host below. It answers over the Node IPC channel; stdout and stderr stay free for the engine's output.
 *
 * The provider host (started by `provider-host.ts`) builds the engine's model runtime the way the engine builds its
 * session services (pi `dist/core/agent-session-services.js`): built-in providers, models.json, and every provider,
 * native provider and virtual model the active workspace's extensions register.
 *
 * Packaged builds run this file with the engine's own node from outside app.asar, so it imports only node builtins,
 * the installed engine and modules the main bundle does not import.
 */

/** Built-in extensions (llama.cpp, MCP…) talk to local servers and register no sign-in; they are left to the engine. */
const BUILTIN_PREFIX = 'builtin:'

const LOGOUT_TIMEOUT_MS = 15_000

interface LoadedRuntime {
  runtime: ModelRuntimeLike
  sdk: PiSdkSurface
  /** Providers and models that exist without extensions (built in or models.json). */
  baseProviderIds: Set<string>
  baseModelKeys: Set<string>
  modifiedBy: Record<string, string>
}

const modelKey = (model: ModelLike) => `${model.provider}/${model.id}`

/** `<...>/pi-black/extensions/pi-black.ts` → `pi-black`; `<...>/my-ext/index.ts` → `my-ext`. */
function extensionName(extensionPath: string): string {
  const file = basename(extensionPath, extname(extensionPath))
  return file === 'index' ? basename(dirname(extensionPath)) : file
}

function serveExtensionProviders(config: ProviderHostConfig): void {
  const signIns = new SignIns((message) => send(message))
  let loaded: Promise<LoadedRuntime> | null = null

  function send(message: HostMessage): void {
    process.send?.(message)
  }

  async function loadRuntime(): Promise<LoadedRuntime> {
    const [sdk, loader] = await Promise.all([
      importEngineFile<PiSdkSurface>(config.packageDir, 'index.js'),
      importEngineFile<ExtensionLoaderModule>(config.packageDir, 'core', 'extensions', 'loader.js')
    ])
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(config.agentDir, 'auth.json'),
      modelsPath: join(config.agentDir, 'models.json'),
      allowModelNetwork: false
    })
    const baseProviderIds = new Set(runtime.getProviders().map((provider) => provider.id))
    const baseModelKeys = new Set(runtime.getModels().map(modelKey))

    // Missing packages are skipped, like `pi list` does: the host never installs anything.
    const settingsManager = sdk.SettingsManager.create(config.cwd, config.agentDir, { projectTrusted: config.projectTrusted })
    const packages = new sdk.DefaultPackageManager({ cwd: config.cwd, agentDir: config.agentDir, settingsManager })
    const resolved = await packages.resolve(async () => 'skip')
    const paths = resolved.extensions.filter((resource) => resource.enabled && !resource.path.startsWith(BUILTIN_PREFIX)).map((resource) => resource.path)
    const { runtime: registrations } = await loader.loadExtensions(paths, config.cwd)

    const modifiedBy: Record<string, string> = {}
    const register = (providerId: string | null, extensionPath: string, action: () => void) => {
      try {
        action()
        if (providerId && baseProviderIds.has(providerId)) modifiedBy[providerId] = extensionName(extensionPath)
      } catch {
        // A failing registration only loses that provider; the engine reports extension errors in its sessions.
      }
    }
    for (const { name, config: providerConfig, extensionPath } of registrations.pendingProviderRegistrations) {
      register(name, extensionPath, () => runtime.registerProvider(name, providerConfig))
    }
    for (const { provider, extensionPath } of registrations.pendingNativeProviderRegistrations) {
      register(provider.id, extensionPath, () => runtime.registerNativeProvider(provider))
    }
    for (const { definition, extensionPath } of registrations.pendingVirtualModelRegistrations) {
      register(null, extensionPath, () => runtime.registerVirtualModel(definition))
    }
    return { runtime, sdk, baseProviderIds, baseModelKeys, modifiedBy }
  }

  /** The runtime, loaded once per host and re-read (models.json, credentials) on every use. */
  async function currentRuntime(): Promise<LoadedRuntime> {
    if (!loaded) {
      const pending = loadRuntime()
      pending.catch(() => {
        if (loaded === pending) loaded = null
      })
      loaded = pending
    }
    const state = await loaded
    await state.runtime.refresh({ allowNetwork: false })
    return state
  }

  async function extensionProviders(): Promise<ExtensionProviders> {
    const { runtime, baseProviderIds, baseModelKeys, modifiedBy } = await currentRuntime()
    const available = new Set(runtime.getAvailableSnapshot().map(modelKey))
    const providers = runtime
      .getProviders()
      .filter((provider) => !baseProviderIds.has(provider.id))
      .map((provider) => describeProvider(runtime, provider))
    const models = runtime
      .getModels()
      .filter((model) => !baseModelKeys.has(modelKey(model)))
      .map(
        (model): HostModel => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          api: model.api,
          reasoning: model.reasoning,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: model.cost,
          thinkingLevelMap: model.thinkingLevelMap,
          available: available.has(modelKey(model))
        })
      )
    return { providers, models, modifiedBy }
  }

  async function login(id: number, providerId: string, method: 'oauth' | 'api_key'): Promise<void> {
    const { runtime, sdk } = await currentRuntime()
    const settings = sdk.SettingsManager.create(config.agentDir, config.agentDir)
    await signIns.run(id, (interaction) =>
      runtime.login(providerId, method, interaction, { getDeviceId: () => settings.getOrCreateDeviceId(), agentName: 'Vengeance' })
    )
    await settings.flush()
  }

  async function logout(providerId: string): Promise<void> {
    const { runtime } = await currentRuntime()
    await runtime.logout(providerId, { signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS) })
  }

  async function answer(id: number, run: () => Promise<ExtensionProviders | void>): Promise<void> {
    try {
      const value = await run()
      send(value ? { id, type: 'result', value } : { id, type: 'result' })
    } catch (error) {
      send({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  process.on('message', (request: HostRequest) => {
    switch (request.type) {
      case 'extension-providers':
        void answer(request.id, extensionProviders)
        break
      case 'login':
        void answer(request.id, () => login(request.id, request.providerId, request.method))
        break
      case 'logout':
        void answer(request.id, () => logout(request.providerId))
        break
      case 'respond':
        signIns.respond(request.id, request.promptId, request.value)
        break
      case 'cancel':
        signIns.cancel(request.id)
        break
    }
  })
}

const hostConfig = JSON.parse(process.argv[2] ?? '{}') as ProviderHostConfig | SdkHostConfig
if (hostConfig.role === 'sdk') {
  serveSdkHost(hostConfig)
} else {
  serveExtensionProviders(hostConfig)
}

// Vengeance went away (quit or crash): never outlive it.
process.on('disconnect', () => process.exit(0))
