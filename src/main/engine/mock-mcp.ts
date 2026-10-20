import type { McpLiveAction } from '@shared/api/mcp'

/**
 * MCP servers of the mock engines, shaped like what each engine reports: the Engine's built-in MCP
 * state (pi patch 0009) and Engine 2's connections and kernel listing (patch 0024). The names match
 * the mock Settings configuration (`features/settings/mock-agent-dir.ts`): every server is in the
 * global mcp.json, and the conversation's folder is trusted, so the Engine turns each one on or off
 * for the folder alone with a project override.
 */

interface MockServer {
  name: string
  oauth: boolean
  tools: number
  enabled: boolean
  state: 'connected' | 'connecting' | 'needs-auth' | 'failed'
  error?: string
  /** The folder's mcp.json overrides `enabled` (the Engine's `enable-project` / `disable-project`). */
  override?: boolean
}

const GLOBAL_CONFIG = 'mcp.json'
const PROJECT_CONFIG = '.pi/mcp.json'

const RECONNECT_MS = 700

function initialServers(): MockServer[] {
  return [
    { name: 'filesystem', oauth: false, tools: 5, enabled: true, state: 'connected' },
    { name: 'github', oauth: true, tools: 4, enabled: true, state: 'connected' },
    { name: 'sentry', oauth: true, tools: 6, enabled: true, state: 'needs-auth' },
    {
      name: 'linear',
      oauth: false,
      tools: 2,
      enabled: true,
      state: 'failed',
      error: 'MCP error -32000: Connection closed\nnpx: command exited with code 1'
    },
    { name: 'postgres', oauth: false, tools: 3, enabled: false, state: 'connected' }
  ]
}

export class MockMcp {
  private servers = initialServers()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly changed: () => void) {}

  /** The built-in extension's `McpHostState`. */
  engineState(): Record<string, unknown> {
    return {
      version: 1,
      configErrors: [],
      servers: this.servers.map((server) => ({
        name: server.name,
        state: server.enabled ? server.state : 'disabled',
        scope: 'global',
        source: server.override ? PROJECT_CONFIG : GLOBAL_CONFIG,
        saves: server.override ? 'project' : 'global',
        ...(server.override ? {} : { projectConfig: PROJECT_CONFIG }),
        exposure: 'codemode',
        ...(server.enabled && server.state === 'connected' ? { toolCount: server.tools } : {}),
        hasResources: server.name === 'github',
        oauth: server.oauth,
        ...(server.enabled && server.error ? { error: server.error } : {})
      }))
    }
  }

  /** Engine 2's `get_mcp_connections`. */
  primeConnections(): Record<string, unknown> {
    return {
      connections: [],
      credentials: [],
      catalogDiagnostics: [],
      services: this.servers.map((server) => ({
        serviceId: server.name,
        label: server.name,
        source: 'user',
        connectionStatus: !server.enabled
          ? 'disabled'
          : server.state === 'needs-auth'
            ? 'not_connected'
            : 'connected',
        connectable: true,
        usesOauth: server.oauth,
        connectionIds: [],
        ...(server.state === 'needs-auth' ? { setupHint: `Sign in to ${server.name} to use it.` } : {})
      }))
    }
  }

  /** Engine 2's `get_mcp_status`. */
  primeStatus(): Record<string, unknown> {
    return {
      kernelRunning: true,
      servers: this.servers
        .filter((server) => server.enabled && server.state !== 'needs-auth')
        .map((server) => ({
          server: server.name,
          tools:
            server.state === 'connected'
              ? Array.from({ length: server.tools }, (_, index) => ({
                  name: `tool_${index + 1}`,
                  description: ''
                }))
              : null,
          // A server that does not answer within the listing's bound reports a bare timeout.
          error:
            server.state === 'failed'
              ? `McpStartupError: ${server.error ?? 'failed'}`
              : server.state === 'connecting'
                ? 'TimeoutError: '
                : null
        }))
    }
  }

  /**
   * `settled`: the reconnect finishes before this returns, as Engine 2's `reconnect_mcp_server`
   * reloads the server before it answers; the Engine's built-in extension reports it on the way.
   */
  act(name: string, action: McpLiveAction, { settled = false }: { settled?: boolean } = {}): void {
    const server = this.servers.find((candidate) => candidate.name === name)
    if (!server) throw new Error(`No MCP server named "${name}".`)
    switch (action) {
      case 'enable':
      case 'disable':
        server.enabled = action === 'enable'
        break
      case 'enable-project':
      case 'disable-project': {
        const enabled = action === 'enable-project'
        if (server.enabled === enabled) break
        if (server.override) {
          throw new Error(
            `MCP server "${name}" cannot be turned ${enabled ? 'on' : 'off'} for the project alone. Only global servers without a project override can, in a trusted project.`
          )
        }
        server.override = true
        server.enabled = enabled
        break
      }
      case 'logout':
        if (!server.oauth) throw new Error(`MCP server "${name}" does not use OAuth.`)
        server.state = 'needs-auth'
        break
      case 'reconnect': {
        if (!server.enabled) throw new Error(`MCP server "${name}" is disabled.`)
        if (server.state === 'needs-auth') break
        if (settled) {
          server.state = 'connected'
          server.error = undefined
          break
        }
        server.state = 'connecting'
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          server.state = 'connected'
          server.error = undefined
          this.changed()
        }, RECONNECT_MS)
        this.timers.add(timer)
        break
      }
    }
    this.changed()
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
