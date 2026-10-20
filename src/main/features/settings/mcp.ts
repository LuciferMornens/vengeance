import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  JsonObject,
  JsonValue,
  McpExposure,
  McpOAuthConfig,
  McpOverview,
  McpServerDraft,
  McpServerInfo,
  McpServerPatch,
  McpServerStatus,
  ProcessDoneEvent,
  ProcessLogEvent,
  SaveMcpServerArgs,
  TextTail
} from '@shared/api/settings'
import { env } from '../../env'
import { trustPreflight } from '../launch/trust'
import { agentDir, projectRoot } from './agent-dir'
import { readJsonFile, setAtPath, updateJsonFile } from './json-file'
import { runPiCli, simulatePiCli, streamPiCli, type StreamedRun } from './pi-cli'
import { piMcpConfig } from './pi-modules'
import { isMasked, maskIfSecret, unmask } from './secrets'
import { readScopeSettings } from './settings-store'

/** MCP servers through pi's own mcp.json helpers (`dist/extensions/mcp/config.js`) and `pi mcp`. */

const EXPOSURES = new Set<McpExposure>(['codemode', 'deferred', 'direct', 'hidden'])
const SERVER_NAME = /^[A-Za-z0-9_-]+$/

function globalMcpPath(): string {
  return join(agentDir(), 'mcp.json')
}

function projectMcpPath(cwd: string): string {
  return join(projectRoot(cwd), '.pi', 'mcp.json')
}

function scopePath(scope: 'global' | 'project', cwd: string | null): string {
  if (scope === 'global') return globalMcpPath()
  if (!cwd) throw new Error('Open a project to edit its MCP servers.')
  return projectMcpPath(cwd)
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(asObject(value) ?? {}))
    if (typeof entry === 'string') result[key] = entry
  return result
}

function asExposure(value: unknown): McpExposure {
  if (value === 'codemode-deferred') return 'codemode'
  return typeof value === 'string' && EXPOSURES.has(value as McpExposure)
    ? (value as McpExposure)
    : 'codemode'
}

function isHttp(config: JsonObject): boolean {
  return (
    typeof config.url === 'string' || config.type === 'http' || config.type === 'streamable-http'
  )
}

function rawCodemode(path: string | null): boolean | undefined {
  if (!path) return undefined
  const value = readJsonFile(path).data.autoEnableCodemode
  return typeof value === 'boolean' ? value : undefined
}

export async function mcpOverview(
  override: string | null,
  cwd: string | null
): Promise<McpOverview> {
  const mcp = await piMcpConfig(override)
  // N15: project servers are listed only when engines started here load them (security.md project trust).
  const projectTrusted = cwd !== null && (await trustPreflight(override, cwd)).engineDefault
  const loaded = mcp.loadMcpConfig({
    agentDir: agentDir(),
    cwd: cwd ? projectRoot(cwd) : agentDir(),
    projectTrusted
  })
  const servers: McpServerInfo[] = loaded.servers.map((entry) => {
    const config = entry.config as JsonObject
    const http = isHttp(config)
    return {
      name: entry.name,
      scope: entry.scope ?? 'global',
      source: entry.source,
      override: entry.override,
      enabled: config.enabled !== false,
      exposure: asExposure(config.exposure),
      transport: http ? 'http' : 'stdio',
      target: http
        ? String(config.url ?? '')
        : [String(config.command ?? ''), ...stringList(config.args)].join(' ').trim(),
      description: typeof config.description === 'string' ? config.description : undefined,
      envNames: Object.keys(asObject(config.env) ?? {}),
      headerNames: Object.keys(asObject(config.headers) ?? {}),
      oauth:
        http &&
        !Object.keys(asObject(config.headers) ?? {}).some(
          (h) => h.toLowerCase() === 'authorization'
        )
    }
  })
  const extensions = stringList(readScopeSettings('global', null).extensions)
  const projectPath = cwd ? projectMcpPath(cwd) : null
  return {
    servers,
    errors: loaded.errors,
    autoEnableCodemode: loaded.autoEnableCodemode !== false,
    autoEnableCodemodeGlobal: rawCodemode(globalMcpPath()),
    autoEnableCodemodeProject: rawCodemode(projectPath),
    globalPath: globalMcpPath(),
    projectPath,
    projectConfig: loaded.projectConfig ?? null,
    builtinDisabled: extensions.includes('-builtin:mcp')
  }
}

const MOCK_STATUS: Record<string, Omit<McpServerStatus, 'name'>> = {
  filesystem: {
    state: 'connected',
    tools: ['read_file', 'write_file', 'list_directory', 'search_files', 'get_file_info']
  },
  github: {
    state: 'connected',
    tools: ['search_code', 'get_issue', 'create_pull_request', 'list_commits'],
    resources: 3
  },
  sentry: { state: 'needs-auth', tools: [], error: 'The server requires sign-in.' },
  linear: { state: 'failed', tools: [], error: 'MCP error -32000: Connection closed' }
}

/** `pi mcp list --json`: connects to every enabled server and reports its state. */
export async function mcpStatus(
  override: string | null,
  cwd: string | null
): Promise<McpServerStatus[]> {
  if (env.mock) {
    const overview = await mcpOverview(override, cwd)
    return overview.servers.map((s) => ({
      name: s.name,
      ...(s.enabled
        ? (MOCK_STATUS[s.name] ?? { state: 'connected', tools: [] })
        : { state: 'disabled', tools: [] })
    }))
  }
  const result = await runPiCli(override, ['mcp', 'list', '--json'], {
    cwd: cwd ? projectRoot(cwd) : agentDir(),
    timeoutMs: 90_000
  })
  const start = result.stdout.indexOf('{')
  if (start === -1)
    throw new Error((result.stderr || result.stdout).trim() || 'MCP status is unavailable.')
  const parsed = JSON.parse(result.stdout.slice(start)) as {
    servers?: Array<{
      name: string
      state: string
      tools?: string[]
      resources?: number | boolean
      error?: string
    }>
  }
  return (parsed.servers ?? []).map((server) => ({
    name: server.name,
    state: server.state,
    tools: server.tools ?? [],
    // pi lists resources on demand; older custom engines report their count here.
    resources: typeof server.resources === 'number' ? server.resources : undefined,
    supportsResources: server.resources === true,
    error: server.error
  }))
}

// ─── Server editor ──────────────────────────────────────────────────────────

/** Keys the editor owns; anything else in an entry (e.g. `auth`) is preserved on save. */
const EDITOR_KEYS = [
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'oauth',
  'timeout',
  'enabled',
  'exposure',
  'toolExposure',
  'description'
]

function maskRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, maskIfSecret(value)])
  )
}

function oauthDraft(value: unknown): McpOAuthConfig | undefined {
  const raw = asObject(value)
  if (!raw) return undefined
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined)
  return {
    clientId: text('clientId'),
    clientSecret:
      text('clientSecret') === undefined ? undefined : maskIfSecret(text('clientSecret')!),
    callbackPort: typeof raw.callbackPort === 'number' ? raw.callbackPort : undefined,
    callbackUrl: text('callbackUrl'),
    scope: text('scope'),
    clientName: text('clientName'),
    clientRegistration: raw.clientRegistration === 'cimd' ? 'cimd' : undefined,
    authServerMetadataUrl: text('authServerMetadataUrl')
  }
}

function readEntry(path: string, name: string): JsonObject | null {
  return asObject(asObject(readJsonFile(path).data.mcpServers)?.[name])
}

/** One mcp.json entry as an editable draft with secrets masked. */
export function mcpServerDraft(
  cwd: string | null,
  name: string,
  scope: 'global' | 'project'
): McpServerDraft {
  const config = readEntry(scopePath(scope, cwd), name)
  if (!config) throw new Error(`No server named "${name}" in the ${scope} mcp.json.`)
  const http = isHttp(config)
  const toolExposure: Record<string, McpExposure> = {}
  for (const [tool, exposure] of Object.entries(asObject(config.toolExposure) ?? {}))
    toolExposure[tool] = asExposure(exposure)
  return {
    name,
    transport: http ? 'http' : 'stdio',
    command: typeof config.command === 'string' ? config.command : undefined,
    args: stringList(config.args),
    env: maskRecord(stringRecord(config.env)),
    cwd: typeof config.cwd === 'string' ? config.cwd : undefined,
    url: typeof config.url === 'string' ? config.url : undefined,
    headers: maskRecord(stringRecord(config.headers)),
    oauth: oauthDraft(config.oauth),
    timeout: typeof config.timeout === 'number' ? config.timeout : undefined,
    enabled: config.enabled !== false,
    exposure: asExposure(config.exposure),
    toolExposure,
    description: typeof config.description === 'string' ? config.description : undefined
  }
}

function validateDraft(server: McpServerDraft): void {
  if (!SERVER_NAME.test(server.name))
    throw new Error('Server names may contain only letters, digits, "_" and "-".')
  if (server.transport === 'stdio' && !server.command?.trim())
    throw new Error('Enter the command that starts the server.')
  if (server.transport === 'http' && !/^https?:\/\//i.test(server.url ?? ''))
    throw new Error('Enter an http(s) URL.')
  if (server.timeout !== undefined && (!Number.isFinite(server.timeout) || server.timeout <= 0))
    throw new Error('The timeout must be a positive number of seconds.')
  for (const [tool, exposure] of Object.entries(server.toolExposure ?? {})) {
    if (!tool.trim()) throw new Error('Tool exposure rules need a tool name or pattern.')
    if (!EXPOSURES.has(exposure)) throw new Error(`Unknown exposure "${exposure}" for ${tool}.`)
  }
  const oauth = server.oauth
  if (!oauth) return
  if (
    oauth.callbackPort !== undefined &&
    (!Number.isInteger(oauth.callbackPort) || oauth.callbackPort < 1 || oauth.callbackPort > 65535)
  )
    throw new Error('The callback port must be between 1 and 65535.')
  if (
    oauth.callbackUrl &&
    !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(oauth.callbackUrl)
  )
    throw new Error('The callback URL must use http on localhost, 127.0.0.1 or [::1].')
  if (oauth.clientRegistration === 'cimd' && (oauth.clientId || oauth.clientName))
    throw new Error(
      'Client ID metadata registration cannot be combined with a client ID or client name.'
    )
  if (
    oauth.authServerMetadataUrl &&
    !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/)/i.test(
      oauth.authServerMetadataUrl
    )
  )
    throw new Error('The authorization server metadata URL must use https.')
}

function restoreRecord(
  values: Record<string, string> | undefined,
  original: unknown,
  label: string
): JsonObject | undefined {
  if (!values || Object.keys(values).length === 0) return undefined
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(values)) {
    if (!key.trim()) continue
    const restored = unmask(value, asObject(original)?.[key])
    if (isMasked(restored)) throw new Error(`Re-enter the value of ${label} ${key}.`)
    result[key] = restored
  }
  return Object.keys(result).length ? result : undefined
}

function oauthConfig(oauth: McpOAuthConfig | undefined, original: unknown): JsonObject | undefined {
  if (!oauth) return undefined
  const result: JsonObject = {}
  const put = (key: keyof McpOAuthConfig, value: JsonValue | undefined) => {
    if (value !== undefined && value !== '') result[key] = value
  }
  put('clientId', oauth.clientId?.trim())
  if (oauth.clientSecret) {
    const secret = unmask(oauth.clientSecret, asObject(original)?.clientSecret)
    if (isMasked(secret)) throw new Error('Re-enter the OAuth client secret.')
    put('clientSecret', secret)
  }
  put('callbackPort', oauth.callbackPort)
  put('callbackUrl', oauth.callbackUrl?.trim())
  put('scope', oauth.scope?.trim())
  put('clientName', oauth.clientName?.trim())
  put('clientRegistration', oauth.clientRegistration)
  put('authServerMetadataUrl', oauth.authServerMetadataUrl?.trim())
  return Object.keys(result).length ? result : undefined
}

/** Build the mcp.json entry: unknown keys of the original survive, editor-owned keys come from the draft. */
function entryFromDraft(server: McpServerDraft, original: JsonObject | null): JsonObject {
  const entry: JsonObject = {}
  for (const [key, value] of Object.entries(original ?? {}))
    if (!EDITOR_KEYS.includes(key)) entry[key] = value
  const set = (key: string, value: JsonValue | undefined) => {
    if (value !== undefined) entry[key] = value
  }
  const sameTransport = original ? isHttp(original) === (server.transport === 'http') : false
  if (sameTransport && typeof original?.type === 'string') entry.type = original.type
  if (server.transport === 'stdio') {
    set('command', server.command!.trim())
    if (server.args?.length) set('args', server.args)
    set('env', restoreRecord(server.env, original?.env, 'environment variable'))
    if (server.cwd?.trim()) set('cwd', server.cwd.trim())
  } else {
    set('url', server.url!.trim())
    set('headers', restoreRecord(server.headers, original?.headers, 'header'))
    set('oauth', oauthConfig(server.oauth, original?.oauth))
  }
  set('timeout', server.timeout)
  if (!server.enabled) entry.enabled = false
  if (server.exposure !== 'codemode') entry.exposure = server.exposure
  if (server.toolExposure && Object.keys(server.toolExposure).length)
    set('toolExposure', server.toolExposure)
  if (server.description?.trim()) set('description', server.description.trim())
  return entry
}

/** Add or replace a server (renames remove the previous entry). */
export async function saveMcpServer(
  override: string | null,
  args: SaveMcpServerArgs
): Promise<McpOverview> {
  validateDraft(args.server)
  const path = scopePath(args.scope, args.cwd)
  const previous = args.previousName ?? args.server.name
  const original = readEntry(path, previous)
  if (args.previousName === undefined && readEntry(path, args.server.name))
    throw new Error(`A server named "${args.server.name}" already exists.`)
  if (
    args.previousName !== undefined &&
    args.previousName !== args.server.name &&
    readEntry(path, args.server.name)
  )
    throw new Error(`A server named "${args.server.name}" already exists.`)
  const entry = entryFromDraft(args.server, original)
  const mcp = await piMcpConfig(override)
  mcp.addMcpServerConfig(path, args.server.name, entry)
  if (args.previousName !== undefined && args.previousName !== args.server.name)
    mcp.removeMcpServerConfig(path, args.previousName)
  return mcpOverview(override, args.cwd)
}

export async function removeMcpServer(
  override: string | null,
  cwd: string | null,
  name: string,
  local: boolean
): Promise<McpOverview> {
  const mcp = await piMcpConfig(override)
  const path = local && cwd ? projectMcpPath(cwd) : globalMcpPath()
  if (!mcp.removeMcpServerConfig(path, name))
    throw new Error(`No server named "${name}" in ${path}.`)
  return mcpOverview(override, cwd)
}

/** Enable/disable or change exposure in the defining file, or as a project override (like `/mcp`). */
export async function updateMcpServer(
  override: string | null,
  cwd: string | null,
  name: string,
  patch: McpServerPatch
): Promise<McpOverview> {
  const overview = await mcpOverview(override, cwd)
  const server = overview.servers.find((s) => s.name === name)
  if (!server) throw new Error(`Unknown MCP server "${name}".`)
  if (server.scope === 'extension')
    throw new Error('Servers registered by extensions are configured by their extension.')
  const mcp = await piMcpConfig(override)
  const { projectOverride, ...change } = patch
  if (projectOverride) {
    if (!overview.projectConfig) throw new Error('Trust this project to save project overrides.')
    if (projectOverride === 'clear') {
      if (server.override) mcp.removeMcpServerConfig(server.override, name)
    } else {
      mcp.updateMcpServerConfig(overview.projectConfig, name, change, { override: true })
    }
  } else {
    mcp.updateMcpServerConfig(server.override ?? server.source, name, change)
  }
  return mcpOverview(override, cwd)
}

/** `autoEnableCodemode` sits beside `mcpServers`; pi has no writer for it, so edit the file under its lock. */
export async function setAutoEnableCodemode(
  override: string | null,
  cwd: string | null,
  scope: 'global' | 'project',
  value: boolean | null
): Promise<McpOverview> {
  await updateJsonFile(scopePath(scope, cwd), override, (current) =>
    setAtPath(current, ['autoEnableCodemode'], value ?? undefined)
  )
  return mcpOverview(override, cwd)
}

/** Last `maxBytes` of `<agentDir>/mcp.log`, starting at a line boundary. */
export function mcpLogTail(maxBytes: number): TextTail {
  const path = join(agentDir(), 'mcp.log')
  if (!existsSync(path)) return { path, exists: false, text: '' }
  const size = statSync(path).size
  const length = Math.min(size, Math.max(1024, Math.min(maxBytes, 1024 * 1024)))
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  let text = buffer.toString('utf8')
  if (length < size) text = text.slice(text.indexOf('\n') + 1)
  return { path, exists: true, text }
}

export async function mcpAuth(
  override: string | null,
  cwd: string | null,
  name: string,
  action: 'login' | 'logout',
  onLog: (event: ProcessLogEvent) => void,
  onDone: (event: ProcessDoneEvent) => void
): Promise<StreamedRun> {
  const args = ['mcp', action, name]
  if (env.mock) {
    const steps: Array<[number, string]> =
      action === 'login'
        ? [
            [300, `Opening the authorization page for "${name}"…\n`],
            [900, 'Waiting for the browser (timeout 300s)…\n'],
            [1400, `\x1b[32mSigned in to ${name}.\x1b[39m\n`]
          ]
        : [[300, `\x1b[32mSigned out of ${name}.\x1b[39m\n`]]
    return simulatePiCli(args, steps, { onLog, onDone })
  }
  return streamPiCli(override, args, { cwd: cwd ? projectRoot(cwd) : agentDir(), onLog, onDone })
}
