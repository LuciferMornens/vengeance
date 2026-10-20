/**
 * Live MCP state of one conversation, the same for both engines.
 *
 * The Engine publishes it through the bridge (`resources/bridge/mcp-status.ts`) on the hidden status
 * `MCP_STATUS_KEY`, from its built-in MCP extension or from pi-mcp-adapter. Engine 2 answers it on
 * request (`engine:bridge` `{ op: 'mcp' }`) from its kernel's connections.
 *
 * Keep the types and constants in sync with `resources/bridge/mcp-status-core.ts`.
 */

export const MCP_STATUS_KEY = '__vengeance:mcp'

/**
 * - `connected`: open, with its tools listed.
 * - `connecting`: starting or reconnecting. Engine 2: its first status read since the server last
 *   answered ran out of time, as one does while the server opens; the next that does reads `failed`.
 * - `idle`: configured and usable, not opened yet (servers connect on first use).
 * - `needs-auth`: a sign-in or token is missing.
 * - `failed`: it could not connect; `error` says why.
 * - `disabled`: turned off.
 * - `blocked`: pi-mcp-adapter holds back a project server until the project is trusted.
 */
export type McpLiveState =
  'connected' | 'connecting' | 'idle' | 'needs-auth' | 'failed' | 'disabled' | 'blocked'

/** Who reports: the Engine's built-in MCP, pi-mcp-adapter in the Engine, or Engine 2. */
export type McpLiveSource = 'engine' | 'adapter' | 'prime'

/**
 * Where a server's on/off switch saves: `project` in the folder's mcp.json, for this folder alone;
 * `global` in the Engine's own mcp.json, which every folder reads; `session` nowhere, for this
 * conversation only (servers an extension registers).
 */
export type McpSwitchScope = 'project' | 'global' | 'session'

export interface McpLiveServer {
  name: string
  state: McpLiveState
  /** Tools the server offers, when known. */
  toolCount?: number
  /** Why it failed or what it needs, as the engine reports it. */
  error?: string
  /** Short qualifier after the state, such as "connects on first use". */
  note?: string
  /** Signs in with OAuth. */
  oauth: boolean
  /**
   * The engine turns it on or off from the conversation and saves the change where `saves` says.
   * Only the Engine's built-in MCP does, for servers whose save target it reports.
   */
  toggle: boolean
  /** Where the switch saves; set with `toggle`. */
  saves?: McpSwitchScope
  /**
   * The switch saves an override to the folder's mcp.json (`enable-project` / `disable-project`),
   * leaving the global mcp.json that defines the server unchanged, like the Engine's "Disable in this
   * project".
   */
  projectOverride?: true
  /**
   * False when the conversation runs no connection of the server, so Reconnect has nothing to act
   * on. Only Engine 2 sets it: it reconnects just the servers its running kernel lists.
   */
  reconnectable?: false
}

export interface McpLiveStatus {
  source: McpLiveSource
  servers: McpLiveServer[]
  /** Configuration problems that no single server row shows. */
  errors: string[]
  /**
   * Whether the states come from the running connections. Engine 2 reports configured states only
   * while its kernel is not running.
   */
  live: boolean
}

/**
 * Actions a conversation can take on one server. `enable-project` / `disable-project` are for
 * servers with `projectOverride`.
 */
export type McpLiveAction =
  'reconnect' | 'enable' | 'disable' | 'enable-project' | 'disable-project' | 'logout'

/** The action that turns `server` on or off: for this folder alone whenever the engine offers it. */
export function mcpSwitchAction(server: McpLiveServer, on: boolean): McpLiveAction {
  if (server.projectOverride) return on ? 'enable-project' : 'disable-project'
  return on ? 'enable' : 'disable'
}

export interface McpLiveCounts {
  /** Servers that are on. */
  enabled: number
  connected: number
  /** Servers that need the user: failed or waiting for a sign-in. */
  attention: number
}

export function mcpLiveCounts(status: McpLiveStatus): McpLiveCounts {
  const enabled = status.servers.filter((s) => s.state !== 'disabled' && s.state !== 'blocked')
  return {
    enabled: enabled.length,
    connected: enabled.filter((s) => s.state === 'connected').length,
    attention: enabled.filter((s) => s.state === 'failed' || s.state === 'needs-auth').length
  }
}

const LIVE_STATES = new Set<McpLiveState>([
  'connected',
  'connecting',
  'idle',
  'needs-auth',
  'failed',
  'disabled',
  'blocked'
])

/** The JSON the bridge publishes on `MCP_STATUS_KEY`; undefined when it is cleared or malformed. */
export function parseMcpLiveStatus(text: string | undefined): McpLiveStatus | undefined {
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { source, servers, errors, live } = value as Partial<McpLiveStatus>
  if (source !== 'engine' && source !== 'adapter' && source !== 'prime') return undefined
  if (!Array.isArray(servers)) return undefined
  return {
    source,
    servers: servers.filter(
      (server): server is McpLiveServer =>
        typeof server?.name === 'string' && LIVE_STATES.has(server.state)
    ),
    errors: Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : [],
    live: live !== false
  }
}
