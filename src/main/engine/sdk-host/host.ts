import { join } from 'node:path'
import { offeredModelIds } from '../../features/settings/offered-models'
import type {
  KeybindingsModule,
  ModelLike,
  ModelRuntimeLike,
  PackageManagerLike,
  PiAiEnvKeysModule,
  PiAiModule,
  PiSdkSurface
} from '../../features/settings/pi-modules'
import { describeProvider, importEngineFile, importPiAiFile } from './host-engine'
import type {
  CatalogModel,
  LevelModel,
  PackageScope,
  SdkHostArgs,
  SdkHostConfig,
  SdkHostMessage,
  SdkHostOp,
  SdkHostOps,
  SdkHostRequest,
  SdkHostResult
} from './protocol'

/**
 * The SDK host role of the host bundle: runs the installed engine's SDK for the main process and
 * answers one operation per call (`SdkHostOps`). It never loads extensions; those run in the provider
 * host. Packaged builds run this with the engine's own node from outside app.asar, so it imports only
 * node builtins, the installed engine and modules the main bundle does not import.
 */

/** Built-in extensions the engine registers as `builtin:<name>` resources (pi `dist/extensions/index.js`). */
const BUILTIN_EXTENSIONS = ['llama.cpp', 'codemode', 'tool-search', 'mcp']

/** Ambient credentials pi-ai accepts besides API-key variables (pi-ai `env-api-keys.js` getEnvApiKey). */
const AMBIENT_ENV: Record<string, string[]> = {
  'amazon-bedrock': ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK'],
  'google-vertex': ['GOOGLE_APPLICATION_CREDENTIALS']
}

/** An environment in which every variable is set, so findEnvKeys lists all the variables it checks. */
const EVERY_VARIABLE_SET = new Proxy<Record<string, string>>({}, { get: () => 'set' })

const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** The provider a ChatGPT sign-in belongs to (`features/settings/account-models.ts`). */
const ACCOUNT_PROVIDER = 'openai'
const ACCOUNT_FETCH_TIMEOUT_MS = 15_000
const OPENAI_BASE_URL = 'https://api.openai.com/v1'

const NPM_VIEW_TIMEOUT_MS = 10_000

/**
 * The engine package manager's own npm runner. It is not in the engine's public typings, but it is what
 * `pi update` runs, so the `npmCommand` setting and the user's npm config (registry, scoped registries) apply.
 */
interface EngineNpmRunner {
  getNpmCommand(): { command: string; args: string[] }
  runCommandCapture(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number }
  ): Promise<string>
}

type Operation<K extends SdkHostOp> = (args: SdkHostArgs<K>) => Promise<SdkHostResult<K>>

const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`

function catalogModel(model: ModelLike, available: boolean, levels: string[]): CatalogModel {
  return {
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
    available,
    thinkingLevels: levels
  }
}

export function serveSdkHost(config: SdkHostConfig): void {
  // Each operation imports only the engine files it needs: a cold host answers sooner than with the SDK entry.
  const engineFile = <K extends keyof PiSdkSurface>(...segments: string[]) =>
    importEngineFile<Pick<PiSdkSurface, K>>(config.packageDir, ...segments)
  const modelRuntime = () => engineFile<'ModelRuntime'>('core', 'model-runtime.js')
  const settingsManager = () => engineFile<'SettingsManager'>('core', 'settings-manager.js')
  const packageManagerModule = () => engineFile<'DefaultPackageManager'>('core', 'package-manager.js')
  const resourceLoader = () => engineFile<'loadProjectContextFiles'>('core', 'resource-loader.js')

  function send(message: SdkHostMessage): void {
    process.send?.(message)
  }

  async function createRuntime(agentDir: string): Promise<ModelRuntimeLike> {
    return (await modelRuntime()).ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      allowModelNetwork: false
    })
  }

  async function supportedLevels(): Promise<(model: LevelModel) => string[]> {
    try {
      return (await importPiAiFile<PiAiModule>(config.packageDir)).getSupportedThinkingLevels
    } catch {
      return (model) =>
        model.reasoning
          ? ALL_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null)
          : ['off']
    }
  }

  /** The environment variables a provider reads, from the installed pi-ai (plus ambient cloud credentials). */
  async function envVarNames(): Promise<(providerId: string) => string[]> {
    let findEnvKeys: (providerId: string) => string[] = () => []
    try {
      const module = await importPiAiFile<PiAiEnvKeysModule>(
        config.packageDir,
        'dist',
        'env-api-keys.js'
      )
      findEnvKeys = (providerId) => module.findEnvKeys(providerId, EVERY_VARIABLE_SET) ?? []
    } catch {
      // Without pi-ai's list only the ambient credentials are named.
    }
    return (providerId) => [...findEnvKeys(providerId), ...(AMBIENT_ENV[providerId] ?? [])]
  }

  async function packageManager(scope: PackageScope): Promise<PackageManagerLike> {
    const [{ SettingsManager }, { DefaultPackageManager }] = await Promise.all([
      settingsManager(),
      packageManagerModule()
    ])
    return new DefaultPackageManager({
      cwd: scope.cwd,
      agentDir: scope.agentDir,
      settingsManager: SettingsManager.create(scope.cwd, scope.agentDir, {
        projectTrusted: scope.projectTrusted
      }),
      builtinExtensions: BUILTIN_EXTENSIONS
    })
  }

  async function fetchOfferedIds(runtime: ModelRuntimeLike): Promise<string[] | null> {
    const result = await runtime.getAuth(ACCOUNT_PROVIDER)
    const apiKey = result?.auth.apiKey
    if (!apiKey) return null
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.auth.headers ?? {}))
      if (typeof value === 'string') headers[name] = value
    headers.authorization = `Bearer ${apiKey}`
    const baseUrl =
      result.auth.baseUrl ?? runtime.getModels(ACCOUNT_PROVIDER)[0]?.baseUrl ?? OPENAI_BASE_URL
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(ACCOUNT_FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const ids = offeredModelIds(await response.json())
    return ids.length > 0 ? ids : null
  }

  const operations: { [K in SdkHostOp]: Operation<K> } = {
    async catalog({ agentDir, extraModels, extraProviderIds }) {
      const [runtime, levelsOf, envVarsOf] = await Promise.all([
        createRuntime(agentDir),
        supportedLevels(),
        envVarNames()
      ])
      const available = new Set(runtime.getAvailableSnapshot().map(modelKey))
      const providers = runtime.getProviders().map((provider) => describeProvider(runtime, provider))
      const providerIds = [...providers.map((provider) => provider.id), ...extraProviderIds]
      return {
        providers,
        models: runtime
          .getModels()
          .map((model) => catalogModel(model, available.has(modelKey(model)), levelsOf(model))),
        envVars: Object.fromEntries(providerIds.map((providerId) => [providerId, envVarsOf(providerId)])),
        extraLevels: extraModels.map(levelsOf),
        error: runtime.getError()
      }
    },

    async 'account-models'({ agentDir, fetch: shouldFetch }) {
      const runtime = await createRuntime(agentDir)
      if (!runtime.isUsingOAuth(ACCOUNT_PROVIDER)) return { usingOAuth: false, ids: null }
      // Unreachable or refused: no list, so the last one stays.
      const ids = shouldFetch ? await fetchOfferedIds(runtime).catch(() => null) : null
      return { usingOAuth: true, ids }
    },

    async packages(scope) {
      const manager = await packageManager(scope)
      return {
        configured: manager.listConfiguredPackages(),
        resolved: await manager.resolve(async () => 'skip')
      }
    },

    async 'package-updates'(scope) {
      const manager = await packageManager(scope)
      return {
        updates: await manager.checkForAvailableUpdates(),
        configured: manager.listConfiguredPackages()
      }
    },

    async 'npm-view'({ name, ...scope }) {
      // SAFETY: both members are checked with typeof before use; an engine without them yields no answer.
      const runner = (await packageManager(scope)) as unknown as Partial<EngineNpmRunner>
      if (typeof runner.getNpmCommand !== 'function' || typeof runner.runCommandCapture !== 'function')
        return null
      const npm = runner.getNpmCommand()
      return runner
        .runCommandCapture(npm.command, [...npm.args, 'view', name, 'version', 'dist.tarball', '--json'], {
          cwd: scope.cwd,
          timeoutMs: NPM_VIEW_TIMEOUT_MS
        })
        .catch(() => null)
    },

    async 'context-files'({ cwd, agentDir }) {
      return (await resourceLoader())
        .loadProjectContextFiles({ cwd, agentDir })
        .map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) }))
    },

    async keybindings({ config: raw }) {
      const module = await importEngineFile<KeybindingsModule>(
        config.packageDir,
        'core',
        'keybindings.js'
      )
      return {
        actions: Object.entries(module.KEYBINDINGS).map(([id, definition]) => ({
          id,
          description: definition.description,
          defaultKeys:
            typeof definition.defaultKeys === 'string'
              ? definition.defaultKeys
              : [...definition.defaultKeys]
        })),
        config: raw ? module.migrateKeybindingsConfig(raw).config : null
      }
    },

    async warm() {
      await Promise.all([modelRuntime(), settingsManager(), packageManagerModule()])
    }
  }

  async function answer(id: number, op: SdkHostOp, args: unknown): Promise<void> {
    try {
      // SAFETY: protocol boundary — main sends `args` typed as `SdkHostArgs<op>` (client.ts).
      const run = operations[op] as Operation<keyof SdkHostOps>
      send({ id, type: 'result', value: await run(args as never) })
    } catch (error) {
      send({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  process.on('message', (request: SdkHostRequest) => {
    void answer(request.id, request.op, request.args)
  })
}
