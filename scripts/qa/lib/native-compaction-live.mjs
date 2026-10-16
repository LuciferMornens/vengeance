// Explicitly invoked live qualification. Credentials stay in the caller's memory; the engines
// receive disposable proxy credentials and all their files live under the QA temp root.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { API } from './fake-llm.mjs'
import { readRequestText } from './request-body.mjs'
import {
  compactionFixture,
  MODEL,
  nativeRequest,
  ordinaryRequest,
  TASK,
  verifyFinishedTask
} from './native-compaction-fixture.mjs'

export async function liveCompactionServer({
  apiKey,
  endpoint = 'https://api.openai.com/v1/responses',
  headers = {},
  subscription = false
}) {
  assert.ok(apiKey, 'A live credential is required')
  assert.ok(endpoint.startsWith('https://'), 'The upstream provider must use HTTPS')
  const requests = []
  const usage = []
  let ordinaryCount = 0
  let forwarded = 0
  let workspace
  const active = new Set()
  const server = createServer(async (incoming, response) => {
    const cancel = new AbortController()
    active.add(cancel)
    response.on('close', () => {
      if (!response.writableFinished) cancel.abort()
    })
    try {
      const body = JSON.parse((await readRequestText(incoming)) || '{}')
      const request = {
        index: requests.length,
        api: API.responses,
        method: incoming.method,
        path: incoming.url,
        body,
        outcome: 'streaming'
      }
      requests.push(request)
      if (incoming.method === 'GET' && incoming.url.includes('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ models: [{ slug: MODEL, visibility: 'list', supported_in_api: true }] })
        )
        request.outcome = 'completed'
        return
      }
      // This proxy forwards SSE. Codex's WebSocket negotiation must get a non-retryable refusal
      // so the native transport can fall back to HTTP, as it does with the offline fixture.
      if (incoming.method !== 'POST') {
        response.writeHead(404)
        response.end()
        request.outcome = 'unsupported-transport'
        return
      }
      assert.ok(incoming.url.endsWith('/responses'), 'Only Responses requests may be forwarded')
      assert.equal(body.model, MODEL)
      assert.ok(incoming.headers.authorization, 'native transport supplies authorization')
      if (subscription && incoming.url.includes('/codex/')) {
        assert.ok(
          incoming.headers['chatgpt-account-id'],
          'Codex transport supplies the account header'
        )
      }
      if (ordinaryRequest(request)) ordinaryCount++
      // Force the actual overflow recovery path after the first tool call, without a large prompt.
      if (ordinaryRequest(request) && ordinaryCount === 2) {
        assert.ok(
          body.input.some((item) => item.type === 'function_call_output'),
          'first turn must perform a real tool call'
        )
        assert.ok(workspace)
        assert.equal(
          await access(join(workspace, 'result.txt')).then(
            () => true,
            () => false
          ),
          false,
          'the task must still have unfinished file work when compaction interrupts it'
        )
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              message: 'prompt is too long: 300000 tokens > 272000 maximum'
            }
          })
        )
        request.outcome = 'injected-overflow'
        return
      }
      // Each run is a tiny task: bound the number of paid calls and total observed tokens.
      assert.ok(++forwarded <= 12, 'Live call limit reached')
      assert.ok(
        usage.reduce((sum, row) => sum + row.total_tokens, 0) < 150000,
        'Live token limit reached'
      )
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 400000, 'Unexpectedly large live prompt')
      if (!nativeRequest(request)) assert.ok((body.max_output_tokens ?? 4096) <= 16384)
      const forwardedHeaders = {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(incoming.headers.originator ? { originator: incoming.headers.originator } : {}),
        ...headers
      }
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: forwardedHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(120000)])
      })
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream'
      })
      // Observe only usage. No token, response body or encrypted checkpoint is written to a log.
      const [stream, observer] = upstream.body.tee()
      const observed = (async () => {
        if (!upstream.ok) {
          const text = await new Response(observer).text()
          request.error = text.replaceAll(apiKey, '<redacted>').slice(0, 1000)
          return
        }
        // Some native clients close immediately after response.completed, before the SSE EOF.
        const decoder = new TextDecoder()
        let pending = ''
        for await (const chunk of observer) {
          pending += decoder.decode(chunk, { stream: true })
          const lines = pending.split('\n')
          pending = lines.pop()
          for (const line of lines) {
            if (!line.startsWith('data: {')) continue
            const event = JSON.parse(line.slice(6))
            if (event.type === 'response.completed' && event.response?.usage) {
              request.outcome = 'completed'
              const measured = event.response.usage
              usage.push({
                input_tokens: measured.input_tokens,
                output_tokens: measured.output_tokens,
                total_tokens: measured.total_tokens
              })
            }
          }
        }
      })()
      await Promise.all([pipeline(Readable.fromWeb(stream), response), observed])
      request.outcome = upstream.ok ? 'completed' : `HTTP ${upstream.status}`
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ error: { message: 'Live qualification proxy stopped the request' } })
      )
      // Local assertion descriptions contain no credentials or provider response bodies.
      if (error.code === 'ERR_ASSERTION') console.error(error.message)
    } finally {
      active.delete(cancel)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    requests,
    usage,
    setWorkspace(value) {
      workspace = value
    },
    openaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async waitForRequest(predicate, { timeoutMs = 120000 } = {}) {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const request = requests.find(predicate)
        if (request) return request
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error('Timed out waiting for the live native compaction request')
    },
    async close() {
      for (const cancel of active) cancel.abort()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

export async function runLiveCompaction(engine, credentials) {
  const server = await liveCompactionServer(credentials)
  let test
  try {
    test = await compactionFixture(engine, credentials.subscription ?? false, server)
    server.setWorkspace(test.workspace)
    await test.app.send(TASK)
    await server.waitForRequest(nativeRequest)
    const result = await verifyFinishedTask(test)
    assert.equal(server.requests.find(nativeRequest).outcome, 'completed')
    assert.ok(server.usage.length >= 4, 'live usage must be observed before native clients close')
    const route =
      credentials.subscription === 'codex' ? 'codex' : credentials.subscription ? 'chatgpt' : 'api'
    await test.app.screenshot(`${engine}-live-${route}`)
    return {
      engine,
      subscription: credentials.subscription ?? false,
      ...result,
      calls: server.usage.length,
      usage: server.usage,
      requests: server.requests.map(({ index, path, outcome, body }) => ({
        index,
        path,
        outcome,
        native: body.input?.at(-1)?.type === 'compaction_trigger'
      }))
    }
  } catch (error) {
    await test?.app.screenshot(`${engine}-live-FAILED`)
    console.error(
      server.requests.map((request) => ({
        index: request.index,
        path: request.path,
        outcome: request.outcome,
        native: nativeRequest(request),
        error: request.error
      }))
    )
    throw error
  } finally {
    await test?.close()
    await server.close()
  }
}
