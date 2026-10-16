import { parseInspectReply, SUBAGENT_INSPECT_WIDGET_KEY, type SubagentInspectReply, type SubagentInspectRequest } from '@shared/subagents'
import type { EngineHandle } from './handle'

/**
 * Main-process client for pi-subagents' `/subagents-inspect-rpc` host command. The extension answers inside
 * the command handler with `setWidget('subagent-inspect', [PREFIX + json])` and retracts it right away, so the
 * reply is on stdout before the `prompt` response. Replies are matched by request id; others are dropped.
 */

/** pi-subagents caps `--lines` at 200; the detail view asks for the last 40 messages. */
const DEFAULT_LINES = 40
const INSPECT_COMMAND = 'subagents-inspect-rpc'

/** Engines known to have the command; an unknown slash command would start a model turn instead. */
const engines = new WeakSet<EngineHandle>()

async function hasInspectCommand(handle: EngineHandle): Promise<boolean> {
  if (engines.has(handle)) return true
  const response = await handle.send({ type: 'get_commands' })
  const found = response.success && response.command === 'get_commands' && response.data.commands.some((command) => command.name === INSPECT_COMMAND)
  if (found) engines.add(handle)
  return found
}

let requestCounter = 0

function nextRequestId(): string {
  requestCounter += 1
  return `vi-${Date.now().toString(36)}${requestCounter.toString(36)}`
}

export async function inspectSubagent(handle: EngineHandle, req: SubagentInspectRequest, timeoutMs = 10_000): Promise<SubagentInspectReply> {
  const requestId = nextRequestId()
  if (!(await hasInspectCommand(handle))) {
    return { requestId, error: { code: 'unavailable', message: 'The subagents extension is not loaded in this engine' } }
  }
  let reply: SubagentInspectReply | null = null
  const off = handle.on('event', (event) => {
    if (event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== SUBAGENT_INSPECT_WIDGET_KEY) return
    const parsed = parseInspectReply(event.widgetLines)
    if (parsed?.requestId === requestId) reply = parsed
  })
  const child = req.childId ? ` ${req.childId}` : ''
  try {
    const response = await handle.send({ type: 'prompt', message: `/${INSPECT_COMMAND} ${requestId} ${req.asyncId}${child} --lines ${req.lines ?? DEFAULT_LINES}` }, { timeoutMs })
    if (!response.success) return { requestId, error: { code: 'unavailable', message: response.error } }
    if (response.command === 'prompt' && response.data.disposition !== 'handled') {
      return { requestId, error: { code: 'unavailable', message: 'The subagents extension is not loaded in this engine' } }
    }
  } catch (error) {
    return { requestId, error: { code: 'timeout', message: (error as Error).message } }
  } finally {
    off()
  }
  return reply ?? { requestId, error: { code: 'timeout', message: 'The subagents extension did not answer' } }
}
