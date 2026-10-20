/**
 * The conversation's MCP status for the desktop app.
 *
 * The Engine's built-in MCP extension publishes its per-server state on the extension event bus and
 * takes reconnect, enable, disable and sign-out requests there (pi patch 0009). pi-mcp-adapter, when
 * installed instead, publishes a status snapshot. The app cannot reach that bus, so this module
 * re-publishes the state, in the app's words (`mcp-status-core.ts`), as JSON on the hidden status
 * `MCP_STATUS_KEY` whenever it changes, and runs actions for `/vengeance-mcp`.
 *
 * pi-mcp-adapter takes no requests on the bus; the app sends its `/mcp` subcommands as prompts.
 */
import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import {
  ADAPTER_MCP_STATUS_EVENT,
  chooseStatus,
  ENGINE_MCP_REQUEST_EVENT,
  ENGINE_MCP_STATE_EVENT,
  fromAdapterSnapshot,
  fromEngineState,
  MCP_STATUS_KEY,
  type McpLiveAction,
  type McpLiveStatus
} from './mcp-status-core'

/**
 * How long an action's answer is awaited, below the app's wait for the reply. A reconnect can take longer:
 * it waits for a startup connection still opening, then for the server's handshake, each request bounded
 * by the server's `timeout` (60 s by default). The action then goes on, and the published state shows how
 * it ends.
 */
const ACTION_TIMEOUT_MS = 50_000

export interface McpStatusControl {
  current(): McpLiveStatus | null
  run(server: string, action: McpLiveAction): Promise<McpLiveStatus | null>
}

export function registerMcpStatus(pi: ExtensionAPI): McpStatusControl {
  let ui: ExtensionUIContext | undefined
  let engine: McpLiveStatus | undefined
  let adapter: McpLiveStatus | undefined
  let published: string | undefined

  const current = () => chooseStatus(engine, adapter) ?? null

  const publish = () => {
    const status = current()
    const json = status ? JSON.stringify(status) : undefined
    if (!ui || json === published) return
    published = json
    ui.setStatus(MCP_STATUS_KEY, json)
  }

  pi.events.on(ENGINE_MCP_STATE_EVENT, (data) => {
    engine = fromEngineState(data)
    publish()
  })
  pi.events.on(ADAPTER_MCP_STATUS_EVENT, (data) => {
    adapter = fromAdapterSnapshot(data)
    publish()
  })

  pi.on('session_start', (_event, ctx) => {
    ui = ctx.ui
    published = undefined
    // The built-in extension may have published before this handler ran; ask for its state.
    pi.events.emit(ENGINE_MCP_REQUEST_EVENT, {
      version: 1,
      action: 'state',
      reply: (state: unknown) => {
        engine = fromEngineState(state) ?? engine
      }
    })
    publish()
  })

  /** The action's error, if it failed; undefined once it succeeded or is still running. */
  const request = (server: string, action: McpLiveAction): Promise<string | undefined> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), ACTION_TIMEOUT_MS)
      let answered = false
      pi.events.emit(ENGINE_MCP_REQUEST_EVENT, {
        version: 1,
        action,
        server,
        reply: (error: string | undefined) => {
          answered = true
          clearTimeout(timer)
          resolve(error)
        }
      })
      // Requests are answered asynchronously; without a listener nothing ever answers.
      if (!answered && !engine) {
        clearTimeout(timer)
        reject(new Error('The built-in MCP extension is not loaded'))
      }
    })

  return {
    current,
    async run(server, action) {
      if (current()?.source === 'adapter') {
        throw new Error('The MCP adapter extension runs its actions through /mcp')
      }
      const error = await request(server, action)
      if (error) throw new Error(error)
      return current()
    }
  }
}
