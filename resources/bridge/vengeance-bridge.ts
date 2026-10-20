/**
 * Vengeance bridge — a pi extension the desktop app loads into every engine with `--extension <this file>`.
 *
 * RPC mode has no command for in-place tree navigation, reload, live tool toggles or entry labels; those
 * live on `ExtensionCommandContext` / `ExtensionAPI`, which only extension command handlers can use. The
 * bridge registers hidden commands that the app invokes through the RPC `prompt` command:
 *
 *   /vengeance-tree   {"reqId","entryId","summarize"?,"customInstructions"?,"replaceInstructions"?,"label"?}
 *   /vengeance-reload {"reqId"}
 *   /vengeance-tools  {"reqId","op":"get"} | {"reqId","op":"set","names":[...]}
 *   /vengeance-label  {"reqId","entryId","label"?}
 *   /vengeance-subagents {"reqId","method","params"?}
 *   /vengeance-speed  {"reqId","mode"?}   (mode: "standard" | "fast" | "ultrafast")
 *   /vengeance-system-prompt {"reqId"}
 *   /vengeance-mcp    {"reqId","action"?,"server"?}
 *                     (action: "reconnect" | "enable" | "disable" | "enable-project" | "disable-project" | "logout")
 *
 * `vengeance-subagents` proxies pi-subagents' in-process event-bus RPC (`subagents:rpc:v1:request` →
 * `subagents:rpc:v1:reply:<requestId>`), which an RPC host cannot reach directly. It posts nothing to the
 * session and costs no model turn. Its data is pi-subagents' reply (`{ success, data | error }`); when nothing
 * answers in time (pi-subagents is not installed) the data is `{ success: false, error: { code: 'timeout' } }`.
 *
 * `vengeance-speed` reads the session's response speed (`speed-mode.ts`), or requests `mode` first, and answers with
 * its `SpeedState`.
 * `vengeance-system-prompt` answers without making a model request, with the prompt of the latest turn in this
 * session while what it was built from still holds: the base prompt (`ctx.getSystemPrompt()` between turns:
 * tools, skills, context files, prompt sources), the active tools and the MCP servers' status, whoever changed
 * them. Otherwise (no turn ran since the latest `session_start`, which a process start, a reload and an in-place
 * session switch emit, or one of them changed) it answers the base prompt with `partial: true`, without the
 * sections extensions add when a run starts (`before_agent_start`, e.g. the MCP servers).
 * `vengeance-mcp` answers the conversation's MCP status (`mcp-status.ts`), after running `action` on
 * `server` first; null when no MCP extension reports.
 *
 * Each handler replies with `ctx.ui.setStatus('__vengeance:<reqId>', JSON)` carrying `{ ok, data | error }`.
 * pi awaits the handler before it answers the `prompt` command, so the reply always precedes that response
 * on stdout. The app hides `__vengeance:*` statuses.
 *
 * APIs used (pi 1.2.0 `dist/core/extensions/types.d.ts`): `ExtensionAPI.registerCommand`, `getActiveTools`,
 * `getAllTools`, `setActiveTools`, `setLabel`, `appendEntry`, `events`, `on` (`session_start`, `session_tree`,
 * `turn_start`, `agent_settled`, `model_select`, `before_provider_request`, `provider_stream_event`,
 * `message_end`, compaction events);
 * `ExtensionCommandContext.navigateTree`, `reload`, `sessionManager.getEntry` / `getLeafId` / `getBranch`,
 * `modelRegistry.isUsingOAuth` / `getApiKeyAndHeaders`; `ExtensionUIContext.setStatus`.
 *
 * The bridge also registers OpenAI native compaction (`openai-native-compaction.ts`), response speed
 * (`speed-mode.ts`) and the MCP status (`mcp-status.ts`), next to this file.
 *
 * pi loads these files with jiti: type imports are erased, and `@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-ai` resolve to the running Engine, so no runtime dependency ships with them.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext
} from '@earendil-works/pi-coding-agent'
import { registerMcpStatus } from './mcp-status'
import { isMcpLiveAction } from './mcp-status-core'
import { registerOpenAINativeCompaction } from './openai-native-compaction'
import { isSpeedMode } from './speed-mode-core'
import { registerSpeedMode } from './speed-mode'

const STATUS_PREFIX = '__vengeance:'
const SUBAGENTS_REQUEST_EVENT = 'subagents:rpc:v1:request'
const SUBAGENTS_REPLY_EVENT_PREFIX = 'subagents:rpc:v1:reply:'
const SUBAGENTS_PROTOCOL_VERSION = 1
const SUBAGENTS_TIMEOUT_MS = 15_000
/** pi-subagents answers ping without I/O, so silence this long means it is not loaded. */
const SUBAGENTS_PING_TIMEOUT_MS = 2_000

type Payload = Record<string, unknown> & { reqId: string }
type Reply = { ok: true; data: unknown } | { ok: false; error: string }

function parsePayload(args: string): Payload {
  let value: unknown
  try {
    value = JSON.parse(args)
  } catch {
    throw new Error('Vengeance bridge: payload is not JSON')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { reqId?: unknown }).reqId !== 'string'
  ) {
    throw new Error('Vengeance bridge: payload must be a JSON object with a string reqId')
  }
  return value as Payload
}

function stringField(payload: Payload, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

function requiredString(payload: Payload, key: string): string {
  const value = stringField(payload, key)
  if (!value) throw new Error(`Vengeance bridge: missing "${key}"`)
  return value
}

type SubagentsReply =
  { success: true; data: unknown } | { success: false; error: { code: string; message: string } }

/** Keep only the reply fields the app reads; anything malformed becomes an error reply. */
function subagentsReply(value: unknown): SubagentsReply {
  if (typeof value !== 'object' || value === null)
    return {
      success: false,
      error: { code: 'invalid_reply', message: 'pi-subagents sent a malformed reply' }
    }
  const record = value as {
    success?: unknown
    data?: unknown
    error?: { code?: unknown; message?: unknown }
  }
  if (record.success === true) return { success: true, data: record.data ?? null }
  return {
    success: false,
    error: {
      code: String(record.error?.code ?? 'execution_failed'),
      message: String(record.error?.message ?? 'pi-subagents request failed')
    }
  }
}

function requestSubagents(
  pi: ExtensionAPI,
  reqId: string,
  method: string,
  params: unknown
): Promise<SubagentsReply> {
  const requestId = `vg-${reqId}`
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        off()
        resolve({
          success: false,
          error: { code: 'timeout', message: 'The subagents extension did not answer' }
        })
      },
      method === 'ping' ? SUBAGENTS_PING_TIMEOUT_MS : SUBAGENTS_TIMEOUT_MS
    )
    const off = pi.events.on(`${SUBAGENTS_REPLY_EVENT_PREFIX}${requestId}`, (data) => {
      clearTimeout(timer)
      off()
      resolve(subagentsReply(data))
    })
    pi.events.emit(SUBAGENTS_REQUEST_EVENT, {
      version: SUBAGENTS_PROTOCOL_VERSION,
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
      source: { extension: 'vengeance' }
    })
  })
}

function reply(ui: ExtensionUIContext, reqId: string, body: Reply): void {
  ui.setStatus(`${STATUS_PREFIX}${reqId}`, JSON.stringify(body))
}

/** Text of a user/custom message entry, which the TUI puts back into the editor after navigating to it. */
function entryEditorText(ctx: ExtensionCommandContext, entryId: string): string | undefined {
  const entry = ctx.sessionManager.getEntry(entryId)
  if (!entry) return undefined
  const content =
    entry.type === 'message' && entry.message.role === 'user'
      ? entry.message.content
      : entry.type === 'custom_message'
        ? entry.content
        : undefined
  if (content === undefined) return undefined
  if (typeof content === 'string') return content
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

export default function vengeanceBridge(pi: ExtensionAPI): void {
  const speed = registerSpeedMode(pi)
  registerOpenAINativeCompaction(pi, speed)
  const mcp = registerMcpStatus(pi)

  /**
   * The full prompt of this session's latest turn, with what it was built from: the active tools and MCP
   * servers at that turn, and the base prompt as its run settled (during a run the prompt includes the
   * sections added when the run started, so the base can only be read between runs).
   */
  let turn: { prompt: string; inputs: string; base?: string } | undefined
  const turnInputs = () =>
    JSON.stringify([
      pi.getActiveTools(),
      mcp.current()?.servers.map(({ name, state }) => [name, state]) ?? null
    ])
  pi.on('session_start', () => {
    turn = undefined
  })
  pi.on('turn_start', (_event, ctx) => {
    turn = { prompt: ctx.getSystemPrompt(), inputs: turnInputs() }
  })
  pi.on('agent_settled', (_event, ctx) => {
    if (turn) turn.base ??= ctx.getSystemPrompt()
  })

  const command = (
    name: string,
    run: (payload: Payload, ctx: ExtensionCommandContext) => Promise<unknown>
  ): void => {
    pi.registerCommand(name, {
      description: 'Vengeance desktop bridge (internal)',
      handler: async (args, ctx) => {
        // Captured before running: after ctx.reload() the old ctx is stale, the UI context is not.
        const ui = ctx.ui
        let payload: Payload
        try {
          payload = parsePayload(args)
        } catch {
          // Not a Vengeance request (typed by hand or malformed): there is no request id to answer, and an
          // extension error notice for an internal command would only confuse.
          return
        }
        try {
          const data = await run(payload, ctx)
          reply(ui, payload.reqId, { ok: true, data: data ?? null })
        } catch (error) {
          reply(ui, payload.reqId, {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })
  }

  const toolsState = () => ({
    active: pi.getActiveTools(),
    tools: pi.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      exposure: tool.exposure,
      namespace: tool.namespace?.name,
      annotations: tool.annotations,
      sourceInfo: tool.sourceInfo
    }))
  })

  command('vengeance-tree', async (payload, ctx) => {
    const entryId = requiredString(payload, 'entryId')
    const editorText = entryEditorText(ctx, entryId)
    const result = await ctx.navigateTree(entryId, {
      summarize: payload.summarize === true,
      customInstructions: stringField(payload, 'customInstructions'),
      replaceInstructions: payload.replaceInstructions === true,
      label: stringField(payload, 'label')
    })
    return {
      cancelled: result.cancelled,
      leafId: ctx.sessionManager.getLeafId(),
      editorText: result.cancelled ? undefined : editorText
    }
  })

  command('vengeance-reload', async (_payload, ctx) => {
    await ctx.reload()
    return null
  })

  command('vengeance-system-prompt', async (_payload, ctx) => {
    const base = ctx.getSystemPrompt()
    return turn?.base === base && turn.inputs === turnInputs()
      ? { text: turn.prompt }
      : { text: base, partial: true }
  })

  command('vengeance-tools', async (payload) => {
    if (payload.op === 'set') {
      const names = payload.names
      if (
        !Array.isArray(names) ||
        !names.every((name): name is string => typeof name === 'string')
      ) {
        throw new Error('Vengeance bridge: "names" must be a string array')
      }
      pi.setActiveTools(names)
    } else if (payload.op !== 'get') {
      throw new Error('Vengeance bridge: "op" must be "get" or "set"')
    }
    return toolsState()
  })

  command('vengeance-label', async (payload) => {
    const label = stringField(payload, 'label')?.trim()
    pi.setLabel(requiredString(payload, 'entryId'), label ? label : undefined)
    return null
  })

  command('vengeance-subagents', async (payload) =>
    requestSubagents(pi, payload.reqId, requiredString(payload, 'method'), payload.params)
  )

  command('vengeance-mcp', async (payload) => {
    const action = payload.action
    if (action === undefined) return mcp.current()
    if (!isMcpLiveAction(action)) {
      throw new Error(
        'Vengeance bridge: "action" must be "reconnect", "enable", "disable", "enable-project", "disable-project" or "logout"'
      )
    }
    return mcp.run(requiredString(payload, 'server'), action)
  })

  command('vengeance-speed', async (payload, ctx) => {
    const mode = payload.mode
    if (mode !== undefined && !isSpeedMode(mode)) {
      throw new Error('Vengeance bridge: "mode" must be "standard", "fast" or "ultrafast"')
    }
    return speed.request(ctx, mode)
  })
}
