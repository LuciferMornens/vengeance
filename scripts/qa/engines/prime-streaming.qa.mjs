import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { createEngineFixture } from './integration-fixture.mjs'
import { chooseSpeed, responsesModel, waitForPill } from './speed-mode-helpers.mjs'

const MODEL_ID = 'gpt-6.1-sol'
const ACCOUNT_ID = 'qa-empty-reasoning'
const MODEL_REPLY = 'The empty reasoning block did not interrupt this response.'
const OAUTH_VALIDITY_MS = 86_400_000
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const ACCESS_TOKEN = `${encode({ alg: 'none' })}.${encode({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID }
})}.qa-signature`

// Hold actual Responses frames between assertions so a completed message cannot hide a stream crash.
function responseStream(response, body, index) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const responseId = `qa-response-${index}`
  const reasoning = { type: 'reasoning', id: `qa-reasoning-${index}`, summary: [] }
  const textItem = { type: 'message', id: `qa-text-${index}`, role: 'assistant', content: [] }
  const emit = (type, fields) => response.write(`data: ${JSON.stringify({ type, ...fields })}\n\n`)
  const add = (outputIndex, item) =>
    emit('response.output_item.added', { output_index: outputIndex, item })
  const done = (outputIndex, item) =>
    emit('response.output_item.done', { output_index: outputIndex, item })
  emit('response.created', {
    response: { id: responseId, status: 'in_progress', output: [], service_tier: 'priority' }
  })
  add(0, reasoning)
  done(0, reasoning)
  add(1, textItem)
  emit('response.content_part.added', {
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '' }
  })
  return {
    body,
    response,
    text() {
      emit('response.output_text.delta', {
        output_index: 1,
        content_index: 0,
        delta: MODEL_REPLY
      })
    },
    tool() {
      add(2, {
        type: 'function_call',
        id: 'qa-function',
        call_id: 'qa-call',
        name: 'ipython',
        arguments: ''
      })
      emit('response.function_call_arguments.delta', {
        output_index: 2,
        delta: JSON.stringify({ code: 'print("ok")' })
      })
    },
    finish() {
      const completedText = {
        ...textItem,
        content: [{ type: 'output_text', text: MODEL_REPLY, annotations: [] }]
      }
      done(1, completedText)
      emit('response.completed', {
        response: {
          id: responseId,
          status: 'completed',
          service_tier: 'priority',
          output: [reasoning, completedText],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 }
        }
      })
      response.end()
    }
  }
}

console.log('▶ Engine 2 empty reasoning: native subscription stream, max reasoning, Fast')
const fixture = await createEngineFixture()
const streams = []
const serverErrors = []
const server = createServer((request, response) => {
  const handleRequest = async () => {
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          models: [{ slug: MODEL_ID, service_tiers: [{ id: 'priority' }] }]
        })
      )
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    streams.push(responseStream(response, body, streams.length))
  }
  void handleRequest().catch((error) => {
    serverErrors.push(error)
    response.destroy()
  })
})
let application
let failure

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const openaiBaseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await writeFile(
    join(fixture.primeDirectory, 'models.json'),
    JSON.stringify({
      providers: {
        'openai-codex': {
          baseUrl: openaiBaseUrl,
          api: 'openai-codex-responses',
          models: [
            {
              ...responsesModel({ openaiBaseUrl }, MODEL_ID, 'GPT-6.1 Sol'),
              api: 'openai-codex-responses',
              reasoning: true,
              thinkingLevelMap: { max: 'xhigh' }
            }
          ]
        }
      }
    })
  )
  await writeFile(
    join(fixture.primeDirectory, 'auth.json'),
    JSON.stringify({
      'openai-codex': {
        type: 'oauth',
        access: ACCESS_TOKEN,
        refresh: 'qa-refresh',
        expires: Date.now() + OAUTH_VALIDITY_MS,
        accountId: ACCOUNT_ID
      }
    })
  )
  application = await launchApp({
    exe: process.env.QA_PACKAGED_EXE,
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: reportShotsDir('prime-streaming')
  })
  await application.openWorkspace({
    cwd: await fixture.root.folder('workspace'),
    args: { engine: 'prime', provider: 'openai-codex', model: MODEL_ID, thinking: 'max' }
  })
  await chooseSpeed(application, 'fast')
  await waitForPill(application, 'Fast')
  assert.equal((await application.agentState()).thinkingLevel, 'max')

  await application.send('Reply with ok.')
  await until(() => streams.length === 1, { label: 'native subscription request' })
  const first = streams[0]
  assert.equal(first.body.model, MODEL_ID)
  assert.equal(first.body.reasoning.effort, 'xhigh')
  assert.equal(first.body.service_tier, 'priority')
  first.text()
  await application.page.getByText(MODEL_REPLY, { exact: true }).waitFor()
  assert.deepEqual((await application.agentState()).streaming.message.content, [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: MODEL_REPLY }
  ])
  application.assertNoErrors()
  await application.screenshot('engine2-empty-reasoning-streaming')
  first.finish()
  await application.waitForSettle()

  await application.send('Prepare a tiny tool call.')
  await until(() => streams.length === 2, { label: 'second native subscription request' })
  const second = streams[1]
  second.tool()
  await until(
    async () => (await application.agentState()).streaming?.message.content.length === 3,
    { label: 'tool following empty reasoning and empty text' }
  )
  const state = await application.agentState()
  assert.deepEqual(state.streaming.message.content.slice(0, 2), [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '' }
  ])
  assert.equal(state.streaming.message.content[2].name, 'ipython')
  application.assertNoErrors()
  await application.screenshot('engine2-empty-reasoning-tool')
  await application.page.getByRole('button', { name: 'Stop', exact: true }).click()
  await application.waitForSettle()
  await until(() => second.response.destroyed, { label: 'native stream cancellation' })
  assert.deepEqual(serverErrors, [])
  application.assertNoErrors()
  console.log('✓ Native empty reasoning, text, tools, max/Fast transport and Stop passed')
} catch (error) {
  failure = error
  await application?.screenshot('prime-streaming-FAILED').catch(() => undefined)
} finally {
  try {
    await application?.close({ beforeCleanup: fixture.stopNativeDaemon })
  } catch (error) {
    failure ??= error
  }
  for (const stream of streams) stream.response.destroy()
  server.closeAllConnections()
  await new Promise((resolveClose) => server.close(resolveClose))
  await fixture.cleanup()
}

if (failure) throw failure
