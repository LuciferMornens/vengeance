/**
 * Pure rules of the conversation's MCP status (`mcp-status.ts`): what the Engine's built-in MCP
 * extension and pi-mcp-adapter report on the extension event bus, in the app's words. No imports, so
 * the offline checks and the mock engine share these rules without an Engine.
 *
 * Keep the types and constants in sync with `src/shared/api/mcp.ts`.
 */

export const MCP_STATUS_KEY = '__vengeance:mcp'
/** The built-in MCP extension publishes its state here (pi patch 0009). */
export const ENGINE_MCP_STATE_EVENT = 'mcp:state'
/** Requests to the built-in MCP extension (pi patch 0009). */
export const ENGINE_MCP_REQUEST_EVENT = 'mcp:request'
/** pi-mcp-adapter's status snapshot (`McpStatusSnapshot`, version 1). */
export const ADAPTER_MCP_STATUS_EVENT = 'pi-mcp-adapter/status/v1'

export type McpLiveState =
  'connected' | 'connecting' | 'idle' | 'needs-auth' | 'failed' | 'disabled' | 'blocked'
export type McpLiveSource = 'engine' | 'adapter' | 'prime'
export type McpSwitchScope = 'project' | 'global' | 'session'

export interface McpLiveServer {
  name: string
  state: McpLiveState
  toolCount?: number
  error?: string
  note?: string
  oauth: boolean
  toggle: boolean
  saves?: McpSwitchScope
  projectOverride?: true
}

export interface McpLiveStatus {
  source: McpLiveSource
  servers: McpLiveServer[]
  errors: string[]
  live: boolean
}

export type McpLiveAction =
  'reconnect' | 'enable' | 'disable' | 'enable-project' | 'disable-project' | 'logout'

const MCP_LIVE_ACTIONS: ReadonlySet<unknown> = new Set<McpLiveAction>([
  'reconnect',
  'enable',
  'disable',
  'enable-project',
  'disable-project',
  'logout'
])

export function isMcpLiveAction(value: unknown): value is McpLiveAction {
  return MCP_LIVE_ACTIONS.has(value)
}

type Fields = Record<string, unknown>

function record(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** State of one server of the built-in extension (`McpHostServerState.state`). */
function engineState(state: unknown): { state: McpLiveState; note?: string } | undefined {
  switch (state) {
    case 'disabled':
    case 'connected':
    case 'needs-auth':
    case 'failed':
      return { state }
    case 'starting':
    case 'connecting':
      return { state: 'connecting' }
    case 'disconnected':
      return { state: 'idle', note: 'Reconnects on next use' }
    case 'closed':
      return { state: 'idle' }
    default:
      return undefined
  }
}

/** Where the built-in extension saves a server's `enable` / `disable` (`McpHostServerState.saves`). */
function engineSaves(saves: unknown): McpSwitchScope | undefined {
  return saves === 'global' || saves === 'project' || saves === 'session' ? saves : undefined
}

/**
 * The built-in MCP extension's `McpHostState`, or undefined when the value is not one. A server gets
 * the on/off switch only when the extension says where it saves; with a `projectConfig` it saves an
 * override there, for this folder alone.
 */
export function fromEngineState(value: unknown): McpLiveStatus | undefined {
  const state = record(value)
  if (state?.version !== 1 || !Array.isArray(state.servers)) return undefined
  const servers: McpLiveServer[] = []
  for (const item of state.servers) {
    const server = record(item)
    const name = text(server?.name)
    const mapped = engineState(server?.state)
    if (!server || !name || !mapped) continue
    // The extension keeps the last connection error until a connection settles; while one is open or
    // opening, that error is stale.
    const showsError = mapped.state !== 'connected' && mapped.state !== 'connecting'
    const saves = engineSaves(server.saves)
    const projectOverride = saves === 'global' && text(server.projectConfig) !== undefined
    servers.push({
      name,
      ...mapped,
      ...(mapped.state === 'connected' && count(server.toolCount) !== undefined
        ? { toolCount: count(server.toolCount) }
        : {}),
      ...(showsError && text(server.error) ? { error: text(server.error) } : {}),
      oauth: server.oauth === true,
      toggle: saves !== undefined,
      ...(saves ? { saves: projectOverride ? 'project' : saves } : {}),
      ...(projectOverride ? { projectOverride: true } : {})
    })
  }
  const errors = Array.isArray(state.configErrors)
    ? state.configErrors.filter((error): error is string => text(error) !== undefined)
    : []
  return { source: 'engine', servers, errors, live: true }
}

function failedAgo(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined
  if (seconds < 60) return 'Failed moments ago; retries after a pause'
  const minutes = Math.round(seconds / 60)
  return `Failed ${minutes} min ago; retries after a pause`
}

/** pi-mcp-adapter's `McpStatusSnapshot`, or undefined when the value is not one. */
export function fromAdapterSnapshot(value: unknown): McpLiveStatus | undefined {
  const snapshot = record(value)
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.servers)) return undefined
  const servers: McpLiveServer[] = []
  for (const item of snapshot.servers) {
    const server = record(item)
    const name = text(server?.name)
    if (!server || !name) continue
    const tools = count(server.toolCount)
    const base = { name, oauth: server.status === 'needs-auth', toggle: false }
    switch (server.status) {
      case 'connected':
        servers.push({ ...base, state: 'connected', ...(tools !== undefined ? { toolCount: tools } : {}) })
        break
      case 'cached':
        servers.push({
          ...base,
          state: 'idle',
          note: 'Connects on first use',
          ...(tools ? { toolCount: tools } : {})
        })
        break
      case 'not-connected':
        servers.push({ ...base, state: 'idle', note: 'Connects on first use' })
        break
      case 'needs-auth':
        servers.push({ ...base, state: 'needs-auth' })
        break
      case 'failed': {
        const error = failedAgo(count(server.failedAgoSeconds))
        servers.push({ ...base, state: 'failed', ...(error ? { error } : {}) })
        break
      }
      case 'blocked': {
        const error = text(server.blockedReason)
        servers.push({ ...base, state: 'blocked', ...(error ? { error } : {}) })
        break
      }
      case 'disabled':
        servers.push({ ...base, state: 'disabled' })
        break
    }
  }
  return { source: 'adapter', servers, errors: [], live: true }
}

/**
 * The status to show: the built-in extension's while it has servers, else pi-mcp-adapter's while it
 * has servers (it replaces the built-in `/mcp` when installed), else whichever reported, the built-in
 * one first so its configuration errors show.
 */
export function chooseStatus(
  engine: McpLiveStatus | undefined,
  adapter: McpLiveStatus | undefined
): McpLiveStatus | undefined {
  if (engine && engine.servers.length > 0) return engine
  if (adapter && adapter.servers.length > 0) return adapter
  return engine ?? adapter
}
