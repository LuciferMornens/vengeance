// Fake LLM for QA suites: a local HTTP server on 127.0.0.1 that speaks three provider APIs the
// engine supports for models.json providers, with SSE streaming exactly as the engine parses it:
//
//   anthropic-messages   POST <url>/v1/messages        (pi-ai api/anthropic-messages.js parses
//                                                       the SSE stream itself)
//   openai-completions   POST <url>/v1/chat/completions (the openai SDK's Stream parses it)
//   openai-responses     POST <url>/v1/responses        (pi-ai api/openai-responses-shared.js);
//                        supports server compaction and explicit compaction_trigger input
//
// Tests script the answers in-process (`server.queue(turn)`) and assert on what the engine sent
// (`server.requests`). Requests keep every header, including auth headers, in memory only;
// `describeRequest()` is the redacted form for printing.
import { createServer } from 'node:http'
import { fakeCompactionItems } from './fake-compaction.mjs'
import { readRequestText as readBody } from './request-body.mjs'

export const API = Object.freeze({
  anthropic: 'anthropic-messages',
  openai: 'openai-completions',
  responses: 'openai-responses'
})

const ROUTES = {
  '/v1/messages': API.anthropic,
  '/v1/chat/completions': API.openai,
  '/v1/responses': API.responses
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive'
}

/** Characters per text/thinking/argument delta when a turn does not set `chunkSize`. */
const DEFAULT_CHUNK_SIZE = 16

/** Default usage numbers estimate tokens as characters / 4, the engine's own rule of thumb. */
const CHARS_PER_TOKEN = 4

/** Thinking blocks need a signature, or the engine replays them to Anthropic as plain text. */
const THINKING_SIGNATURE = 'qa-fake-signature'

const POLL_INTERVAL_MS = 25
const DEFAULT_WAIT_MS = 30_000
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie'])

/**
 * One scripted model answer. Content is any mix of `thinking`, `text` and `toolCalls`, streamed in
 * that order. `error` answers with an HTTP error instead; `hang` streams `thinking`/`text` (if
 * any, never tool calls) and then holds the response open until the engine aborts the request.
 *
 * @typedef {object} FakeTurn
 * @property {string} [text]
 * @property {string} [thinking]
 * @property {Array<{ name: string, args?: object, id?: string }>} [toolCalls]
 * @property {number} [chunkSize] characters per streamed delta
 * @property {number} [delayMs] pause before every streamed delta
 * @property {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} [usage]
 * @property {'stop' | 'length' | 'toolUse'} [stopReason] default: toolUse with tool calls
 * @property {{ status: number, message?: string, body?: unknown, retryAfter?: number,
 *   headers?: Record<string, string> }} [error]
 * @property {boolean} [hang]
 * @property {Array<object>} [compactionItems] override checkpoint output for failure tests
 * @property {string | true} [serviceTier] openai-responses: `service_tier` echoed on
 *   `response.created` / `response.completed`; `true` echoes the request's (or `default`)
 * @property {string | true} [speed] anthropic-messages: `usage.speed` on `message_start` and
 *   `message_delta`; `true` echoes the request's `speed` (or `standard`)
 * @property {(request: FakeRequest) => boolean} [when] answer only requests this accepts
 */

/**
 * @typedef {object} FakeRequest
 * @property {number} index
 * @property {string | null} api `anthropic-messages`, `openai-completions`, or null (unknown route)
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {any} body parsed JSON body (protocol boundary: provider payloads are untyped)
 * @property {number} receivedAt
 * @property {FakeTurn | null} turn the turn that answered it
 * @property {'streaming' | 'completed' | 'error' | 'aborted'} outcome
 */

export const turn = {
  text: (text, options = {}) => ({ ...options, text }),
  thinking: (thinking, text, options = {}) => ({ ...options, thinking, text }),
  toolCall: (name, args = {}, options = {}) => ({ ...options, toolCalls: [{ name, args }] }),
  toolCalls: (calls, options = {}) => ({ ...options, toolCalls: calls }),
  error: (status, options = {}) => {
    const { message, body, retryAfter, headers, ...rest } = options
    return { ...rest, error: { status, message, body, retryAfter, headers } }
  },
  hang: (options = {}) => ({ ...options, hang: true })
}

const DEFAULT_FALLBACK_TURN = turn.text('ok')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function chunkString(value, size) {
  if (value.length === 0) return []
  const pieces = []
  for (let start = 0; start < value.length; start += size) {
    pieces.push(value.slice(start, start + size))
  }
  return pieces
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value ?? '').length / CHARS_PER_TOKEN))
}

/** Usage for a turn: explicit numbers win, the rest is estimated from the request and answer. */
function resolveUsage(fakeTurn, body) {
  const prompt = JSON.stringify([body?.system ?? null, body?.messages ?? []])
  const answer = [
    fakeTurn.thinking ?? '',
    fakeTurn.text ?? '',
    ...(fakeTurn.toolCalls ?? []).map((call) => JSON.stringify(call.args ?? {}))
  ].join('')
  return {
    input: fakeTurn.usage?.input ?? estimateTokens(prompt),
    output: fakeTurn.usage?.output ?? estimateTokens(answer),
    cacheRead: fakeTurn.usage?.cacheRead ?? 0,
    cacheWrite: fakeTurn.usage?.cacheWrite ?? 0
  }
}

function resolveStopReason(fakeTurn) {
  if (fakeTurn.stopReason) return fakeTurn.stopReason
  return fakeTurn.toolCalls?.length ? 'toolUse' : 'stop'
}

/** Writes SSE frames until the engine disconnects; `closed` flips when it does. */
class SseWriter {
  constructor(response, request) {
    this.response = response
    this.closed = false
    response.on('close', () => {
      this.closed = true
      if (request.outcome === 'streaming') request.outcome = 'aborted'
    })
  }

  open() {
    this.response.writeHead(200, SSE_HEADERS)
    this.response.flushHeaders()
  }

  send(event, data) {
    if (this.closed) return
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    const eventLine = event ? `event: ${event}\n` : ''
    this.response.write(`${eventLine}data: ${payload}\n\n`)
  }

  end() {
    if (!this.closed) this.response.end()
  }

  async waitForClose() {
    while (!this.closed) await sleep(POLL_INTERVAL_MS)
  }
}

/** Streams `text` in pieces, calling `emit(piece)` after the turn's per-delta delay. */
async function streamPieces(writer, text, fakeTurn, emit) {
  for (const piece of chunkString(text, fakeTurn.chunkSize ?? DEFAULT_CHUNK_SIZE)) {
    if (fakeTurn.delayMs) await sleep(fakeTurn.delayMs)
    if (writer.closed) return
    emit(piece)
  }
}

const ANTHROPIC_STOP_REASONS = { stop: 'end_turn', length: 'max_tokens', toolUse: 'tool_use' }

/** A turn's `serviceTier` / `speed` echo: `true` mirrors the request field, else the literal. */
function speedEcho(value, requested, standard) {
  return value === true ? (requested ?? standard) : value
}

async function streamAnthropic(writer, request, fakeTurn, ids) {
  const usage = resolveUsage(fakeTurn, request.body)
  const speed = speedEcho(fakeTurn.speed, request.body?.speed, 'standard')
  const usageFields = {
    input_tokens: usage.input,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
    ...(speed === undefined ? {} : { speed })
  }
  writer.send('message_start', {
    type: 'message_start',
    message: {
      id: ids.next('msg_qa_'),
      type: 'message',
      role: 'assistant',
      model: request.body?.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usageFields, output_tokens: 1 }
    }
  })
  let index = 0
  const startBlock = (contentBlock) =>
    writer.send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock
    })
  const delta = (blockDelta) =>
    writer.send('content_block_delta', { type: 'content_block_delta', index, delta: blockDelta })
  const stopBlock = () => {
    writer.send('content_block_stop', { type: 'content_block_stop', index })
    index++
  }

  if (fakeTurn.thinking) {
    startBlock({ type: 'thinking', thinking: '', signature: '' })
    await streamPieces(writer, fakeTurn.thinking, fakeTurn, (piece) =>
      delta({ type: 'thinking_delta', thinking: piece })
    )
    if (fakeTurn.hang && !fakeTurn.text) return writer.waitForClose()
    delta({ type: 'signature_delta', signature: THINKING_SIGNATURE })
    stopBlock()
  }
  if (fakeTurn.text) {
    startBlock({ type: 'text', text: '' })
    await streamPieces(writer, fakeTurn.text, fakeTurn, (piece) =>
      delta({ type: 'text_delta', text: piece })
    )
    if (fakeTurn.hang) return writer.waitForClose()
    stopBlock()
  }
  if (fakeTurn.hang) return writer.waitForClose()
  for (const call of fakeTurn.toolCalls ?? []) {
    startBlock({
      type: 'tool_use',
      id: call.id ?? ids.next('toolu_qa_'),
      name: call.name,
      input: {}
    })
    await streamPieces(writer, JSON.stringify(call.args ?? {}), fakeTurn, (piece) =>
      delta({ type: 'input_json_delta', partial_json: piece })
    )
    stopBlock()
  }
  writer.send('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: ANTHROPIC_STOP_REASONS[resolveStopReason(fakeTurn)],
      stop_sequence: null
    },
    usage: { ...usageFields, output_tokens: usage.output }
  })
  writer.send('message_stop', { type: 'message_stop' })
  writer.end()
}

const OPENAI_FINISH_REASONS = { stop: 'stop', length: 'length', toolUse: 'tool_calls' }

async function streamOpenAi(writer, request, fakeTurn, ids) {
  const usage = resolveUsage(fakeTurn, request.body)
  const base = {
    id: ids.next('chatcmpl-qa-'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: request.body?.model
  }
  const chunk = (choiceDelta, finishReason = null) =>
    writer.send(null, {
      ...base,
      choices: [{ index: 0, delta: choiceDelta, finish_reason: finishReason }]
    })

  chunk({ role: 'assistant', content: '' })
  if (fakeTurn.thinking) {
    await streamPieces(writer, fakeTurn.thinking, fakeTurn, (piece) =>
      chunk({ reasoning_content: piece })
    )
  }
  if (fakeTurn.text) {
    await streamPieces(writer, fakeTurn.text, fakeTurn, (piece) => chunk({ content: piece }))
  }
  if (fakeTurn.hang) return writer.waitForClose()
  for (const [index, call] of (fakeTurn.toolCalls ?? []).entries()) {
    const id = call.id ?? ids.next('call_qa_')
    chunk({
      tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }]
    })
    await streamPieces(writer, JSON.stringify(call.args ?? {}), fakeTurn, (piece) =>
      chunk({ tool_calls: [{ index, function: { arguments: piece } }] })
    )
  }
  chunk({}, OPENAI_FINISH_REASONS[resolveStopReason(fakeTurn)])
  writer.send(null, {
    ...base,
    choices: [],
    usage: {
      prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
      prompt_tokens_details: {
        cached_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite
      }
    }
  })
  writer.send(null, '[DONE]')
  writer.end()
}

/**
 * OpenAI Responses stream. A compaction trigger returns checkpoint items without an answer.
 */
async function streamResponses(writer, request, fakeTurn, ids) {
  const triggered = request.body?.input?.at(-1)?.type === 'compaction_trigger'
  if (triggered) fakeTurn = { ...fakeTurn, text: undefined, toolCalls: [] }
  const usage = resolveUsage(fakeTurn, {
    system: request.body?.instructions,
    messages: request.body?.input
  })
  const responseId = ids.next('resp_qa_')
  const tier = speedEcho(fakeTurn.serviceTier, request.body?.service_tier, 'default')
  const serviceTier = tier === undefined ? {} : { service_tier: tier }
  const output = []
  let outputIndex = 0
  const emit = (type, fields) => writer.send(null, { type, ...fields })
  const addItem = (item) => {
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { ...item, status: 'in_progress' }
    })
    return outputIndex
  }
  const doneItem = (item) => {
    const done = { ...item, status: 'completed' }
    emit('response.output_item.done', { output_index: outputIndex, item: done })
    output.push(done)
    outputIndex++
  }

  emit('response.created', {
    response: { id: responseId, status: 'in_progress', output: [], ...serviceTier }
  })
  for (const checkpoint of fakeCompactionItems(request, fakeTurn, ids)) {
    addItem(checkpoint)
    doneItem(checkpoint)
  }
  if (fakeTurn.text) {
    const item = { type: 'message', id: ids.next('msg_qa_'), role: 'assistant', content: [] }
    const index = addItem(item)
    emit('response.content_part.added', {
      output_index: index,
      item_id: item.id,
      content_index: 0,
      part: { type: 'output_text', text: '' }
    })
    await streamPieces(writer, fakeTurn.text, fakeTurn, (piece) =>
      emit('response.output_text.delta', {
        output_index: index,
        item_id: item.id,
        content_index: 0,
        delta: piece
      })
    )
    if (fakeTurn.hang) return writer.waitForClose()
    doneItem({ ...item, content: [{ type: 'output_text', text: fakeTurn.text, annotations: [] }] })
  }
  if (fakeTurn.hang) return writer.waitForClose()
  for (const call of fakeTurn.toolCalls ?? []) {
    const args = JSON.stringify(call.args ?? {})
    const item = {
      type: 'function_call',
      id: ids.next('fc_qa_'),
      call_id: call.id ?? ids.next('call_qa_'),
      name: call.name,
      arguments: ''
    }
    const index = addItem(item)
    await streamPieces(writer, args, fakeTurn, (piece) =>
      emit('response.function_call_arguments.delta', {
        output_index: index,
        item_id: item.id,
        delta: piece
      })
    )
    emit('response.function_call_arguments.done', {
      output_index: index,
      item_id: item.id,
      arguments: args
    })
    doneItem({ ...item, arguments: args })
  }
  const stop = resolveStopReason(fakeTurn)
  emit('response.completed', {
    response: {
      id: responseId,
      status: stop === 'length' ? 'incomplete' : 'completed',
      ...(stop === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...serviceTier,
      output,
      usage: {
        input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
        input_tokens_details: {
          cached_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite
        },
        output_tokens: usage.output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output
      }
    }
  })
  writer.end()
}

function errorBody(api, error) {
  if (error.body !== undefined) return error.body
  const message = error.message ?? `QA fake error ${error.status}`
  if (api === API.openai || api === API.responses) {
    return { error: { message, type: 'qa_fake_error', code: String(error.status) } }
  }
  return { type: 'error', error: { type: 'api_error', message } }
}

function respondWithError(response, request, error) {
  const headers = { 'content-type': 'application/json', ...error.headers }
  if (error.retryAfter !== undefined) headers['retry-after'] = String(error.retryAfter)
  const body = errorBody(request.api, error)
  response.writeHead(error.status, headers)
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
  request.outcome = 'error'
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

function createIdSource() {
  let counter = 0
  return { next: (prefix) => `${prefix}${++counter}` }
}

/** A request with auth headers redacted, for printing in failure reports. */
export function describeRequest(request) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      AUTH_HEADERS.has(name) ? '<redacted>' : value
    ])
  )
  return { ...request, headers, turn: request.turn ? { ...request.turn, when: undefined } : null }
}

/**
 * Start the fake LLM. Resolves once it listens on 127.0.0.1 at a random port.
 * @param {{ fallback?: FakeTurn }} [options] answer for requests with no matching queued turn
 */
export async function startFakeLlm(options = {}) {
  /** @type {FakeTurn[]} */
  const queued = []
  /** @type {FakeRequest[]} */
  const requests = []
  const openResponses = new Map()
  const ids = createIdSource()
  let fallback = options.fallback ?? DEFAULT_FALLBACK_TURN
  /** ChatGPT's `GET /v1/models` catalog (`models[].slug`); null answers 404. */
  let accountModels = null

  function takeTurn(request) {
    const position = queued.findIndex((candidate) => !candidate.when || candidate.when(request))
    if (position === -1) return fallback
    return queued.splice(position, 1)[0]
  }

  async function handle(incoming, response) {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.replace('/codex/', '/')
    const request = {
      index: requests.length,
      api: ROUTES[route] ?? null,
      method: incoming.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { ...incoming.headers },
      body: parseJson(await readBody(incoming)),
      receivedAt: Date.now(),
      turn: null,
      outcome: 'streaming'
    }
    requests.push(request)
    if (route === '/v1/models' && request.method === 'GET' && accountModels) {
      request.outcome = 'completed'
      response.writeHead(200, { 'content-type': 'application/json' })
      const tiers = (slug) =>
        accountModels.serviceTiers[slug] ? { service_tiers: accountModels.serviceTiers[slug] } : {}
      const listed = accountModels.offered.map((slug) => ({
        slug,
        visibility: 'list',
        supported_in_api: true,
        ...tiers(slug)
      }))
      const hidden = accountModels.hidden.map((slug) => ({
        slug,
        visibility: 'hide',
        supported_in_api: true,
        ...tiers(slug)
      }))
      response.end(JSON.stringify({ models: [...listed, ...hidden] }))
      return
    }
    if (!request.api || request.method !== 'POST') {
      respondWithError(response, request, {
        status: 404,
        message: `QA fake LLM: no route ${request.path}`
      })
      return
    }
    const fakeTurn = takeTurn(request)
    request.turn = fakeTurn
    if (fakeTurn.error) {
      respondWithError(response, request, fakeTurn.error)
      return
    }
    const writer = new SseWriter(response, request)
    writer.open()
    openResponses.set(response, request)
    try {
      if (request.api === API.anthropic) await streamAnthropic(writer, request, fakeTurn, ids)
      else if (request.api === API.responses) await streamResponses(writer, request, fakeTurn, ids)
      else await streamOpenAi(writer, request, fakeTurn, ids)
      if (request.outcome === 'streaming') request.outcome = 'completed'
    } finally {
      openResponses.delete(response)
    }
  }

  const server = createServer((incoming, response) => {
    handle(incoming, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(`QA fake LLM failure: ${error.message}`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}`

  async function waitUntil(predicate, timeoutMs, label) {
    const started = Date.now()
    for (;;) {
      const value = predicate()
      if (value) return value
      if (Date.now() - started > timeoutMs) {
        throw new Error(`QA fake LLM: timed out waiting for ${label}`)
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  return {
    url,
    /** Base URL for `anthropic-messages` models (the SDK appends /v1/messages). */
    anthropicBaseUrl: url,
    /** OpenAI model base URL; the SDK appends the completions or Responses route. */
    openaiBaseUrl: `${url}/v1`,
    requests,
    /** Queue one turn or several, answered in order (a turn with `when` waits for its request). */
    queue(...turns) {
      queued.push(...turns.flat())
    },
    /** Turns still waiting for a request. */
    pending: () => queued.length,
    setFallback(fakeTurn) {
      fallback = fakeTurn
    },
    /**
     * Answer `GET /v1/models` with these ids (null: 404); `hidden` gets `visibility: "hide"`.
     * `serviceTiers` maps model slugs to `[{ id, name, description }]`, as ChatGPT lists them.
     * Catalog requests are recorded with `api: null`.
     */
    setAccountModels(offered, { hidden = [], serviceTiers = {} } = {}) {
      accountModels = offered ? { offered, hidden, serviceTiers } : null
    },
    /** Forget queued turns and recorded requests; the fallback goes back to the default. */
    reset() {
      queued.length = 0
      requests.length = 0
      fallback = options.fallback ?? DEFAULT_FALLBACK_TURN
    },
    /** The first request at index >= `from` that `predicate` accepts. */
    waitForRequest(predicate = () => true, { from = 0, timeoutMs = DEFAULT_WAIT_MS } = {}) {
      const find = () => requests.slice(from).find((request) => request.api && predicate(request))
      return waitUntil(find, timeoutMs, 'a model request')
    },
    /** Resolves once `request` finished streaming (completed, error or aborted). */
    waitForOutcome(request, { timeoutMs = DEFAULT_WAIT_MS } = {}) {
      return waitUntil(
        () => request.outcome !== 'streaming' && request.outcome,
        timeoutMs,
        'the request outcome'
      )
    },
    /** Close selected fixture responses after recording their native outcomes. */
    releaseRequests(requestsToRelease) {
      const selected = new Set(requestsToRelease)
      const released = []
      for (const [response, request] of openResponses) {
        if (!selected.has(request)) continue
        released.push(request.index)
        response.destroy()
      }
      return released
    },
    async close() {
      for (const response of openResponses.keys()) response.destroy()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text' || block.type === 'input_text')
    .map((block) => block.text)
    .join('\n')
}

function countImages(content) {
  if (!Array.isArray(content)) return 0
  return content.filter(
    (block) => block.type === 'image' || block.type === 'image_url' || block.type === 'input_image'
  ).length
}

function normalizeAnthropicMessages(body) {
  const messages = []
  for (const message of body.messages ?? []) {
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content
    const results = blocks.filter((block) => block.type === 'tool_result')
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.tool_use_id,
        text: contentText(result.content),
        images: countImages(result.content),
        isError: result.is_error === true
      })
    }
    if (results.length === blocks.length) continue
    messages.push({
      role: message.role,
      text: contentText(blocks),
      thinking: blocks
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking)
        .join('\n'),
      images: countImages(blocks),
      toolCalls: blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, args: block.input }))
    })
  }
  return messages
}

/** Convert Responses input to messages, with compaction items carrying `id` and `encrypted`. */
function normalizeResponsesMessages(body) {
  const messages = []
  for (const item of body.input ?? []) {
    if (item.type === 'compaction') {
      messages.push({
        role: 'compaction',
        id: item.id,
        encrypted: item.encrypted_content,
        text: '',
        images: 0,
        toolCalls: []
      })
    } else if (item.type === 'function_call') {
      const previous = messages.at(-1)
      const call = { id: item.call_id, name: item.name, args: parseJson(item.arguments ?? '') }
      if (previous?.role === 'assistant') previous.toolCalls.push(call)
      else
        messages.push({ role: 'assistant', text: '', thinking: '', images: 0, toolCalls: [call] })
    } else if (item.type === 'function_call_output') {
      messages.push({
        role: 'toolResult',
        toolCallId: item.call_id,
        text: contentText(item.output),
        images: countImages(item.output)
      })
    } else if (item.type === 'reasoning') {
      continue
    } else if (item.role) {
      messages.push({
        role: item.role === 'developer' ? 'system' : item.role,
        text: contentText(
          typeof item.content === 'string'
            ? item.content
            : (item.content ?? []).map((c) =>
                c.type === 'output_text' ? { ...c, type: 'text' } : c
              )
        ),
        thinking: '',
        images: countImages(item.content),
        toolCalls: []
      })
    }
  }
  return messages
}

function normalizeOpenAiMessages(body) {
  return (body.messages ?? []).map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'toolResult',
        toolCallId: message.tool_call_id,
        text: contentText(message.content),
        images: 0
      }
    }
    return {
      role: message.role === 'developer' ? 'system' : message.role,
      text: contentText(message.content),
      thinking: message.reasoning_content ?? '',
      images: countImages(message.content),
      toolCalls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function?.name,
        args: parseJson(call.function?.arguments ?? '')
      }))
    }
  })
}

/**
 * The parts of a request suites usually assert on, the same shape for both APIs. The raw body
 * stays on `request.body` for everything else (sampling params, headers on `request.headers`).
 */
export function inspectRequest(request) {
  const body = request.body ?? {}
  const anthropic = request.api === API.anthropic
  const responses = request.api === API.responses
  const messages = anthropic
    ? normalizeAnthropicMessages(body)
    : responses
      ? normalizeResponsesMessages(body)
      : normalizeOpenAiMessages(body)
  const systemFromBody = anthropic
    ? contentText(body.system)
    : responses
      ? String(body.instructions ?? '')
      : ''
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.text)
  const userMessages = messages.filter((message) => message.role === 'user')
  return {
    api: request.api,
    model: body.model,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    /** Anthropic `thinking`: `{ type: 'enabled', budget_tokens: 2048 }`, `{ type: 'disabled' }`. */
    thinking: body.thinking ?? null,
    /** OpenAI `reasoning_effort` (Responses: `reasoning.effort`), e.g. `'low'`. */
    reasoningEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
    temperature: body.temperature,
    system: [systemFromBody, ...systemMessages].filter(Boolean).join('\n'),
    tools: (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name),
    messages: messages.filter((message) => message.role !== 'system'),
    lastUserText: userMessages.at(-1)?.text ?? '',
    toolResults: messages.filter((message) => message.role === 'toolResult'),
    imageCount: messages.reduce((total, message) => total + message.images, 0)
  }
}
