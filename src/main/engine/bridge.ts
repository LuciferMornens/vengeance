import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRIDGE_FILE_NAME,
  BRIDGE_STATUS_PREFIX,
  type BridgeCommandName,
  type BridgeOp,
  type BridgeRequest,
  type BridgeResultMap
} from '@shared/api/engine'
import type { EngineHandle } from './handle'

/**
 * Main-process side of the Vengeance bridge extension (`resources/bridge/vengeance-bridge.ts`).
 *
 * A bridge call is an RPC `prompt` whose message is `/<command> <json payload>`. pi runs extension
 * commands before answering `prompt`, so the bridge's `setStatus('__vengeance:<reqId>', json)` reply
 * (or an `extension_error` for the command) is always seen on stdout before the `prompt` response.
 */

/**
 * Absolute path of the bridge file: `<resources>/bridge/` in packaged builds (electron-builder
 * extraResources), `<repo>/resources/bridge/` in dev and for the built-but-unpackaged app
 * (`out/main/index.js`). Null when the file is missing, so the engine starts without it.
 */
export function bridgeExtensionPath(packaged: boolean, resourcesPath: string): string | null {
  const candidate = packaged
    ? join(resourcesPath, 'bridge', BRIDGE_FILE_NAME)
    : join(__dirname, '..', '..', 'resources', 'bridge', BRIDGE_FILE_NAME)
  return existsSync(candidate) ? candidate : null
}

/** pi exits at startup when an extension fails to load; detect that it was the bridge. */
export function bridgeLoadFailed(stderr: string): boolean {
  return stderr.includes('Failed to load extension') && stderr.includes(BRIDGE_FILE_NAME)
}

const OP_COMMAND: Record<BridgeOp, BridgeCommandName> = {
  tree: 'vengeance-tree',
  reload: 'vengeance-reload',
  'tools-get': 'vengeance-tools',
  'tools-set': 'vengeance-tools',
  label: 'vengeance-label',
  subagents: 'vengeance-subagents',
  speed: 'vengeance-speed',
  'system-prompt': 'vengeance-system-prompt',
  mcp: 'vengeance-mcp'
}

/** The bridge waits up to 15 s for pi-subagents' event-bus reply; allow for the prompt round trip on top. */
const SUBAGENTS_TIMEOUT_MS = 20_000
/** The bridge waits up to 50 s for an MCP action (a reconnect handshake); allow for the round trip. */
const MCP_ACTION_TIMEOUT_MS = 55_000

/** Default time allowed per operation (a branch summary runs a model call; reload re-initializes extensions). */
export function bridgeTimeout(request: BridgeRequest): number {
  if (request.op === 'tree') return request.summarize ? 10 * 60_000 : 60_000
  if (request.op === 'reload') return 3 * 60_000
  if (request.op === 'subagents') return SUBAGENTS_TIMEOUT_MS
  if (request.op === 'mcp' && request.action) return MCP_ACTION_TIMEOUT_MS
  return 30_000
}

function payloadOf(request: BridgeRequest, reqId: string): Record<string, unknown> {
  switch (request.op) {
    case 'tree': {
      const { op: _op, ...rest } = request
      return { reqId, ...rest }
    }
    case 'reload':
    case 'system-prompt':
      return { reqId }
    case 'tools-get':
      return { reqId, op: 'get' }
    case 'tools-set':
      return { reqId, op: 'set', names: request.names }
    case 'label':
      return { reqId, entryId: request.entryId, label: request.label }
    case 'subagents':
      return { reqId, method: request.method, params: request.params }
    case 'speed':
      return { reqId, mode: request.mode }
    case 'mcp':
      return { reqId, action: request.action, server: request.server }
  }
}

let requestCounter = 0

/** Run one bridge operation on an engine that has the bridge loaded. */
export async function callBridge<O extends BridgeOp>(
  handle: EngineHandle,
  request: Extract<BridgeRequest, { op: O }>,
  timeoutMs: number
): Promise<BridgeResultMap[O]> {
  const command = OP_COMMAND[request.op]
  const reqId = `b${Date.now().toString(36)}-${++requestCounter}`
  const statusKey = `${BRIDGE_STATUS_PREFIX}${reqId}`
  let reply: string | undefined
  let commandError: string | undefined
  const off = handle.on('event', (event) => {
    if (
      event.type === 'extension_ui_request' &&
      event.method === 'setStatus' &&
      event.statusKey === statusKey
    ) {
      reply = event.statusText
    } else if (event.type === 'extension_error' && event.extensionPath === `command:${command}`) {
      commandError = event.error
    }
  })
  try {
    const response = await handle.send(
      { type: 'prompt', message: `/${command} ${JSON.stringify(payloadOf(request, reqId))}` },
      { timeoutMs }
    )
    if (!response.success) throw new Error(response.error)
    if (response.command === 'prompt' && response.data.disposition !== 'handled') {
      // The command was not recognized; pi treated the payload as a user prompt.
      throw new Error(`The engine did not run /${command} (bridge not loaded)`)
    }
  } finally {
    off()
  }
  if (commandError !== undefined) throw new Error(commandError)
  if (reply === undefined) throw new Error(`The bridge did not answer /${command}`)
  const parsed = JSON.parse(reply) as
    { ok: true; data: BridgeResultMap[O] } | { ok: false; error: string }
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.data
}
