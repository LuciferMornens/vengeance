import { randomUUID } from 'node:crypto'
import type {
  JsonObject,
  McpOverview,
  McpServerDraft,
  McpServerInfo,
  McpServerPatch,
  McpServerStatus,
  SaveMcpServerArgs,
  SettingsScope
} from '@shared/api/settings'
import type { PrimeSettingsContext } from './configuration'
import { startPrimeLogin } from './auth'
import {
  assertSafeKey,
  jsonObject,
  jsonStrings,
  maskPrimeSecrets,
  mergePrimeSettings,
  primeSettingsPath,
  readPrimeJson,
  restorePrimeSecrets,
  updatePrimeJson
} from './configuration-store'

const MILLISECONDS_PER_SECOND = 1_000
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

function serverInfo(
  name: string,
  value: JsonObject,
  scope: SettingsScope,
  source: string
): McpServerInfo {
  return {
    name,
    scope,
    source,
    enabled: value.enabled !== false,
    exposure: 'direct',
    transport: value.type === 'http' ? 'http' : 'stdio',
    target:
      typeof value.url === 'string'
        ? value.url
        : [value.command, ...jsonStrings(value.args)].join(' '),
    envNames: [
      ...Object.keys(jsonObject(value.env) ?? {}),
      ...(typeof value.bearerTokenEnvVar === 'string' ? [value.bearerTokenEnvVar] : [])
    ],
    headerNames: Object.keys(jsonObject(value.headers) ?? {}),
    oauth: value.oauth === true
  }
}

export async function primeMcpOverview(cwd: string | null): Promise<McpOverview> {
  const global = await readPrimeJson(primeSettingsPath('global', cwd))
  const project = cwd ? await readPrimeJson(primeSettingsPath('project', cwd)) : null
  const servers = new Map<string, McpServerInfo>()
  const definitions = new Map<string, JsonObject>()
  const errors: string[] = []
  const files = [
    { state: global, scope: 'global' as const },
    ...(project ? [{ state: project, scope: 'project' as const }] : [])
  ]
  for (const { state, scope } of files) {
    if (state.error) errors.push(state.error)
    for (const [name, raw] of Object.entries(jsonObject(state.data.mcpServers) ?? {})) {
      const value = jsonObject(raw)
      if (!value) {
        errors.push(`MCP server ${name} must be an object.`)
        continue
      }
      const effective = mergePrimeSettings(definitions.get(name) ?? {}, value)
      definitions.set(name, effective)
      const info = serverInfo(name, effective, scope, state.path)
      if (servers.has(name)) info.override = state.path
      servers.set(name, info)
    }
  }
  return {
    servers: [...servers.values()],
    errors,
    autoEnableCodemode: false,
    globalPath: global.path,
    projectPath: project?.path ?? null,
    projectConfig: project?.path ?? null,
    builtinDisabled: false
  }
}

export async function primeMcpServer(
  cwd: string | null,
  name: string,
  scope: SettingsScope
): Promise<McpServerDraft> {
  const state = await readPrimeJson(primeSettingsPath(scope, cwd))
  const raw = jsonObject(jsonObject(state.data.mcpServers)?.[name])
  if (!raw) throw new Error('This MCP server is no longer configured.')
  const global = scope === 'project' ? await readPrimeJson(primeSettingsPath('global', cwd)) : null
  const inherited = jsonObject(jsonObject(global?.data.mcpServers)?.[name]) ?? {}
  const value = maskPrimeSecrets(mergePrimeSettings(inherited, raw))
  const env = Object.fromEntries(
    Object.entries(jsonObject(value.env) ?? {}).flatMap(([key, reference]) => {
      const variable = jsonObject(reference)?.env
      return typeof variable === 'string' ? [[key, `\${${variable}}`]] : []
    })
  )
  const headers = Object.fromEntries(
    Object.entries(jsonObject(value.headers) ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  return {
    name,
    transport: value.type === 'http' ? 'http' : 'stdio',
    command: typeof value.command === 'string' ? value.command : undefined,
    args: jsonStrings(value.args),
    cwd: typeof value.cwd === 'string' ? value.cwd : undefined,
    url: typeof value.url === 'string' ? value.url : undefined,
    env,
    headers,
    oauth: value.oauth === true ? {} : undefined,
    timeout:
      typeof value.callTimeoutMs === 'number'
        ? value.callTimeoutMs / MILLISECONDS_PER_SECOND
        : undefined,
    enabled: value.enabled !== false,
    exposure: 'direct'
  }
}

function nativeEnvironment(values: Record<string, string> | undefined): JsonObject {
  const result: JsonObject = {}
  for (const [name, reference] of Object.entries(values ?? {})) {
    const variable = /^\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(reference)?.[1]
    if (!variable) {
      throw new Error(`Engine 2 requires an environment variable reference for ${name}.`)
    }
    result[name] = { env: variable }
  }
  return result
}

export async function savePrimeMcpServer(args: SaveMcpServerArgs): Promise<McpOverview> {
  const { server } = args
  if (!SERVER_NAME.test(server.name))
    throw new Error('Use an MCP name with letters, digits, - or _.')
  assertSafeKey(server.name)
  if (server.exposure !== 'direct') throw new Error('Engine 2 exposes MCP tools directly.')
  if (server.transport === 'http') {
    const url = new URL(server.url ?? '')
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Use an HTTP or HTTPS endpoint.')
  } else if (!server.command?.trim()) {
    throw new Error('Enter the MCP server command.')
  }
  const global =
    args.scope === 'project' ? await readPrimeJson(primeSettingsPath('global', args.cwd)) : null
  await updatePrimeJson(primeSettingsPath(args.scope, args.cwd), (current) => {
    const servers = { ...(jsonObject(current.mcpServers) ?? {}) }
    const previousName = args.previousName ?? server.name
    const inherited = jsonObject(jsonObject(global?.data.mcpServers)?.[previousName]) ?? {}
    const previous = mergePrimeSettings(inherited, jsonObject(servers[previousName]) ?? {})
    const next: JsonObject = { ...previous, type: server.transport, enabled: server.enabled }
    for (const key of ['command', 'args', 'cwd', 'env', 'url', 'headers', 'oauth', 'callTimeoutMs'])
      delete next[key]
    if (server.transport === 'stdio') {
      next.command = server.command!.trim()
      if (server.args?.length) next.args = server.args
      if (server.cwd) next.cwd = server.cwd
      if (server.env && Object.keys(server.env).length) next.env = nativeEnvironment(server.env)
    } else {
      next.url = server.url!
      if (server.headers && Object.keys(server.headers).length) next.headers = server.headers
      if (server.oauth) next.oauth = true
    }
    if (server.timeout !== undefined) {
      if (!Number.isFinite(server.timeout) || server.timeout <= 0)
        throw new Error('Timeout must be positive.')
      next.callTimeoutMs = Math.round(server.timeout * MILLISECONDS_PER_SECOND)
    }
    if (previousName !== server.name) delete servers[previousName]
    servers[server.name] = restorePrimeSecrets(next, previous)
    return { ...current, mcpServers: servers }
  })
  return primeMcpOverview(args.cwd)
}

export async function removePrimeMcpServer(
  cwd: string | null,
  name: string,
  local: boolean
): Promise<McpOverview> {
  assertSafeKey(name)
  await updatePrimeJson(primeSettingsPath(local ? 'project' : 'global', cwd), (current) => {
    const servers = { ...(jsonObject(current.mcpServers) ?? {}) }
    delete servers[name]
    return { ...current, mcpServers: servers }
  })
  return primeMcpOverview(cwd)
}

export async function updatePrimeMcpServer(
  cwd: string | null,
  name: string,
  patch: McpServerPatch
): Promise<McpOverview> {
  assertSafeKey(name)
  if (patch.exposure && patch.exposure !== 'direct') {
    throw new Error('Engine 2 exposes MCP tools directly.')
  }
  const overview = await primeMcpOverview(cwd)
  const server = overview.servers.find((candidate) => candidate.name === name)
  if (!server) throw new Error('This MCP server is no longer configured.')
  const scope = patch.projectOverride
    ? 'project'
    : server.scope === 'project'
      ? 'project'
      : 'global'
  const sourceState = await readPrimeJson(server.source)
  const sourceEntry = jsonObject(jsonObject(sourceState.data.mcpServers)?.[name]) ?? {}
  await updatePrimeJson(primeSettingsPath(scope, cwd), (current) => {
    const servers = { ...(jsonObject(current.mcpServers) ?? {}) }
    if (patch.projectOverride === 'clear') delete servers[name]
    else {
      const entry = { ...(jsonObject(servers[name]) ?? sourceEntry) }
      if (patch.enabled !== undefined) entry.enabled = patch.enabled
      servers[name] = entry
    }
    return { ...current, mcpServers: servers }
  })
  return primeMcpOverview(cwd)
}

export async function primeMcpStatus(
  cwd: string | null,
  context: PrimeSettingsContext
): Promise<McpServerStatus[]> {
  if (!context.nativeCommand) return []
  const result = await context.nativeCommand('get_mcp_connections', {}, cwd)
  const statuses = new Map<string, McpServerStatus>()
  for (const raw of Array.isArray(result.services) ? result.services : []) {
    const entry = jsonObject(raw)
    if (typeof entry?.serviceId !== 'string' || typeof entry.connectionStatus !== 'string') continue
    statuses.set(entry.serviceId, {
      name: entry.serviceId,
      label: typeof entry.label === 'string' ? entry.label : entry.serviceId,
      state: entry.connectionStatus,
      tools: [],
      usesOAuth: entry.usesOauth === true,
      connectable: entry.connectable === true,
      pasteToken: entry.pasteToken === true,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      docsUrl: typeof entry.docsUrl === 'string' ? entry.docsUrl : undefined,
      source: typeof entry.source === 'string' ? entry.source : undefined,
      connectionIds: jsonStrings(entry.connectionIds),
      toolCount: typeof entry.toolCount === 'number' ? entry.toolCount : undefined,
      error: typeof entry.setupHint === 'string' ? entry.setupHint : undefined
    })
  }
  for (const raw of Array.isArray(result.connections) ? result.connections : []) {
    const entry = jsonObject(raw)
    const name = typeof entry?.server === 'string' ? entry.server : entry?.name
    if (typeof name !== 'string' || statuses.has(name)) continue
    statuses.set(name, {
      name,
      state:
        typeof entry?.status === 'string'
          ? entry.status
          : entry?.connected === true
            ? 'connected'
            : 'disconnected',
      tools: jsonStrings(entry?.tools),
      error: typeof entry?.error === 'string' ? entry.error : undefined
    })
  }
  return [...statuses.values()]
}

export async function primeMcpAuth(
  cwd: string | null,
  name: string,
  action: 'login' | 'logout',
  context: PrimeSettingsContext
): Promise<string> {
  if (action === 'login') {
    return startPrimeLogin(
      { providerId: `mcp:${name}`, method: 'oauth', cwd: cwd ?? undefined },
      context
    )
  }
  if (!context.nativeCommand) throw new Error('Open an Engine 2 session to manage this connection.')
  const runId = `prime-mcp-${randomUUID()}`
  setTimeout(() => {
    void context.nativeCommand!('remove_mcp_connection', { server: name }, cwd)
      .then(() => {
        context.broadcast?.('settings:process-done', { runId, ok: true, code: 0 })
        context.broadcast?.('settings:changed', { area: 'mcp' })
      })
      .catch((error: unknown) => {
        context.broadcast?.('settings:process-done', {
          runId,
          ok: false,
          code: null,
          error: (error as Error).message
        })
      })
  }, 0)
  return runId
}
