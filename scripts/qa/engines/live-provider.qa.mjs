// Paid provider smoke is opt-in: VENGEANCE_LIVE_PROVIDER_QA=1 and OPENROUTER_API_KEY in the
// launching environment. --prepare verifies the key, model catalog and executable without turns.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { launchApp, reportShotsDir, ROOT, shutdownOwnedPrimeDaemons } from '../lib/app.mjs'
import { executableName } from '../lib/platform.mjs'
import { processTable } from '../lib/processes.mjs'
import { assertOutsideRealHome, isInside, tempRoot } from '../lib/tmp.mjs'

const SUITE_NAME = 'engines-live-provider'
const PROVIDER = 'openrouter'
const API_BASE_URL = 'https://openrouter.ai/api/v1'
const API_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 120_000
const MODEL_OUTPUT_LIMIT = 512
const LIVE_THINKING_LEVEL = 'minimal'
const TOKENS_PER_MILLION = 1_000_000
const SPEND_LIMIT_USD = 0.5
const COST_DISPLAY_PRECISION = 4
const PROMPT_MAX_CHARACTERS = 80
const PROMPT = 'Reply with just: ok'
const TOOL_MARKER = 'tool-ok'
const TOOL_PROMPT = 'Use ipython once to print("tool-ok"), then reply with just: ok'
const CONTEXT_MARKER = 'LIVE_CONTEXT_OK'
const SECRET_VARIABLE = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i
const PRIME_VARIABLE = /^PRIME_AGENT_/
const MODEL_IDS = ['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5', 'openai/gpt-6-astra']
const SHOTS_DIRECTORY = reportShotsDir(SUITE_NAME)

function redact(message, apiKey) {
  return String(message)
    .replaceAll(apiKey, '<REDACTED>')
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '<REDACTED>')
}

async function providerModels(apiKey) {
  const responses = await Promise.all([
    fetch(`${API_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    }),
    fetch(`${API_BASE_URL}/models`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  ])
  const [keyResponse, modelsResponse] = responses
  assert.ok(keyResponse.ok, `OpenRouter key check returned HTTP ${keyResponse.status}`)
  assert.ok(modelsResponse.ok, `OpenRouter catalog returned HTTP ${modelsResponse.status}`)
  const [keyInfo, modelCatalog] = await Promise.all([keyResponse.json(), modelsResponse.json()])
  assert.ok(
    keyInfo.data.limit_remaining == null || keyInfo.data.limit_remaining > 0,
    'OpenRouter key has no remaining spend allowance'
  )

  return MODEL_IDS.map((modelId) => {
    const model = modelCatalog.data.find((entry) => entry.id === modelId)
    assert.ok(model, `${modelId} is unavailable in the current OpenRouter catalog`)
    assert.ok(model.supported_parameters.includes('tools'), `${modelId} supports tools`)
    return {
      id: model.id,
      name: model.name,
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      contextWindow: model.context_length,
      maxTokens: MODEL_OUTPUT_LIMIT,
      cost: {
        input: Number(model.pricing.prompt) * TOKENS_PER_MILLION,
        output: Number(model.pricing.completion) * TOKENS_PER_MILLION,
        cacheRead: 0,
        cacheWrite: 0
      }
    }
  })
}

async function nativeExecutable() {
  return realpath(
    process.env.VENGEANCE_PRIME_EXECUTABLE ||
      join(ROOT, '.engine-staging', 'prime', 'release', executableName('prime-agent'))
  )
}

async function engineDirectory(root, engine, models) {
  return root.folder(`${engine}-agent`, {
    'settings.json': {
      defaultProvider: PROVIDER,
      defaultModel: MODEL_IDS[0],
      defaultThinkingLevel: LIVE_THINKING_LEVEL,
      telemetry: { enabled: false },
      retry: { enabled: false }
    },
    'models.json': {
      providers: {
        [PROVIDER]: {
          api: 'openai-completions',
          baseUrl: API_BASE_URL,
          // Engine versions use different syntax for environment references.
          apiKey: engine === 'prime' ? 'OPENROUTER_API_KEY' : '${OPENROUTER_API_KEY}',
          models
        }
      }
    }
  })
}

async function createFixture(models, executable, apiKey) {
  const root = await tempRoot('vengeance-qa-live-provider-')
  try {
    const piDirectory = await engineDirectory(root, 'pi', models)
    const primeDirectory = await engineDirectory(root, 'prime', models)
    const sessionDirectory = await root.folder('prime-sessions')
    const runtimeTempDirectory = await root.folder('runtime-tmp')
    const workspace = await root.folder('workspace', {
      'README.md': '# Isolated live engine QA\n',
      'AGENTS.md': `Workspace marker: ${CONTEXT_MARKER}. Keep replies brief.\n`
    })
    const foreignPids = (await processTable()).map((entry) => entry.pid)
    const environment = {}
    for (const name of Object.keys(process.env)) {
      if (SECRET_VARIABLE.test(name) || PRIME_VARIABLE.test(name)) {
        environment[name] = undefined
      }
    }
    Object.assign(environment, {
      OPENROUTER_API_KEY: apiKey,
      PRIME_AGENT_CODING_AGENT_DIR: primeDirectory,
      PRIME_AGENT_SESSION_DIR: sessionDirectory,
      PRIME_AGENT_CODING_AGENT_SESSION_DIR: sessionDirectory,
      PRIME_AGENT_KERNEL_VENV: root.path('kernel-venv'),
      PRIME_AGENT_KERNEL_PYTHON: undefined,
      VENGEANCE_PRIME_EXECUTABLE: executable,
      TEMP: runtimeTempDirectory,
      TMP: runtimeTempDirectory,
      TMPDIR: runtimeTempDirectory,
      DO_NOT_TRACK: '1'
    })
    return {
      root,
      primeDirectory,
      sessionDirectory,
      workspace,
      foreignPids,
      launchOptions: {
        agentDir: piDirectory,
        env: environment,
        outDir: SHOTS_DIRECTORY
      }
    }
  } catch (error) {
    await root.cleanup()
    throw error
  }
}

function messageText(message) {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

async function eventCapture(page) {
  const capture = await page.evaluateHandle(() => {
    const events = []
    const unsubscribe = window.vengeance.on('engine:event', ({ agentId, event }) => {
      events.push({
        agentId,
        type: event.type,
        willRetry: event.willRetry,
        aborted: event.aborted
      })
    })
    return { events, unsubscribe }
  })
  return async () => {
    try {
      return await capture.evaluate(({ events, unsubscribe }) => {
        unsubscribe()
        return events
      })
    } finally {
      await capture.dispose()
    }
  }
}

async function tinyTurn(application, engine, modelId, prompt, report) {
  assert.ok(prompt.length <= PROMPT_MAX_CHARACTERS, 'live prompts remain tiny')
  const before = await application.rpc({ type: 'get_messages' })
  const finishCapture = await eventCapture(application.page)
  const record = { engine, model: modelId, prompt }
  report.turns.push(record)
  const started = performance.now()
  try {
    await application.send(prompt)
    await application.waitForSettle({ timeoutMs: TURN_TIMEOUT_MS })
  } catch (error) {
    await application.rpc({ type: 'abort' }).catch(() => undefined)
    throw error
  } finally {
    record.events = await finishCapture()
    if (engine === 'prime') {
      const agentId = await application.activeAgentId()
      const state = await application.invoke('prime:command', agentId, 'get_connection_state', {})
      record.connectionState = {
        isStreaming: state.isStreaming,
        sessionActions: state.sessionActions,
        thinkingLevel: state.thinkingLevel
      }
    }
  }
  const { messages } = await application.rpc({ type: 'get_messages' })
  const replies = messages
    .slice(before.messages.length)
    .filter((message) => message.role === 'assistant')
  const reply = replies.at(-1)
  assert.ok(reply, `${engine}/${modelId} returned an assistant message`)
  const cost = replies.reduce((total, message) => total + (message.usage?.cost?.total ?? 0), 0)
  report.estimatedSpendUsd += cost
  Object.assign(record, {
    reply: messageText(reply).trim(),
    stopReason: reply.stopReason,
    errorMessage: reply.errorMessage,
    inputTokens: replies.reduce((total, message) => total + (message.usage?.input ?? 0), 0),
    outputTokens: replies.reduce((total, message) => total + (message.usage?.output ?? 0), 0),
    estimatedCostUsd: cost,
    seconds: Number(((performance.now() - started) / 1000).toFixed(1))
  })
  assert.equal(reply.stopReason, 'stop', `${engine}/${modelId} completed normally`)
  assert.equal(messageText(reply).trim().toLowerCase(), 'ok')
  assert.equal(reply.provider, PROVIDER)
  assert.equal(reply.model, modelId)
  assert.ok(reply.usage.output > 0, 'the provider reported output usage')
  console.log(`  ✓ ${engine}/${modelId}: ok (${record.seconds}s)`)
  assert.ok(report.estimatedSpendUsd <= SPEND_LIMIT_USD, 'live smoke stayed within its spend cap')
}

async function savedFirstTurn(application, fixture, report) {
  const { agentId } = await application.openWorkspace({
    cwd: fixture.workspace,
    args: {
      engine: 'prime',
      provider: PROVIDER,
      model: MODEL_IDS[0],
      thinking: LIVE_THINKING_LEVEL,
      approve: true,
      name: 'Engine 2 live persistence',
      sessionDir: fixture.sessionDirectory
    }
  })
  await tinyTurn(application, 'prime', MODEL_IDS[0], PROMPT, report)
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.ok(state.sessionFile, 'the first native session has a saved file')
  assert.ok(isInside(fixture.sessionDirectory, state.sessionFile), 'native session is isolated')
  const entries = (await readFile(state.sessionFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(entries.some((entry) => entry.message?.role === 'user'))
  assert.ok(
    entries.some(
      (entry) =>
        entry.message?.role === 'assistant' &&
        messageText(entry.message).trim().toLowerCase() === 'ok'
    ),
    'the first completed native reply is persisted'
  )
  const systemPrompt = await application.invoke('prime:command', agentId, 'get_system_prompt', {})
  assert.ok(JSON.stringify(systemPrompt).includes(CONTEXT_MARKER), 'workspace context is loaded')
  report.firstSessionPersisted = true
  report.workspaceContextLoaded = true
  await application.screenshot('engine2-first-live-turn')
  return { sessionFile: state.sessionFile, sessionId: state.sessionId }
}

async function resumeFirstTurn(application, fixture, saved, report) {
  const { agentId } = await application.openWorkspace({
    cwd: fixture.workspace,
    args: { engine: 'prime', sessionPath: saved.sessionFile, approve: true }
  })
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(resolve(state.sessionFile).toLowerCase(), resolve(saved.sessionFile).toLowerCase())
  assert.equal(state.sessionId, saved.sessionId)
  const { messages } = await application.rpc({ type: 'get_messages' }, agentId)
  assert.ok(messages.some((message) => message.role === 'user' && messageText(message) === PROMPT))
  assert.ok(
    messages.some(
      (message) =>
        message.role === 'assistant' && messageText(message).trim().toLowerCase() === 'ok'
    )
  )
  report.firstSessionReopenedFromDisk = true
  await application.screenshot('engine2-live-session-reopened')
  await tinyTurn(application, 'prime', MODEL_IDS[0], TOOL_PROMPT, report)
  const tools = Object.values((await application.agentState(agentId)).tools)
  const pythonTool = tools.find((tool) => ['ipython', 'python'].includes(tool.toolName))
  assert.ok(pythonTool, 'the live model called the native Python tool')
  assert.equal(pythonTool.status, 'done')
  assert.notEqual(pythonTool.isError, true)
  assert.ok(JSON.stringify(pythonTool.result).includes(TOOL_MARKER), 'native stdout reached the UI')
  report.nativeToolOutputRendered = true
  await application.screenshot('engine2-live-native-tool')
  await application.page.getByRole('button', { name: 'Controls', exact: true }).click()
  await application.page.getByRole('tab', { name: 'Context', exact: true }).click()
  await application.screenshot('engine2-live-context')
  await application.page.keyboard.press('Escape')
}

async function runLiveSmoke(models, executable, apiKey) {
  const started = performance.now()
  const fixture = await createFixture(models, executable, apiKey)
  const report = {
    suite: SUITE_NAME,
    models: models.map((model) => model.id),
    maxOutputTokens: MODEL_OUTPUT_LIMIT,
    estimatedSpendUsd: 0,
    turns: []
  }
  let application
  let failure
  try {
    application = await launchApp(fixture.launchOptions)
    for (const engine of ['pi', 'prime']) {
      const description = await application.invoke('engine:describe', engine)
      assert.equal(description.found, true, `${engine} is installed`)
      assert.equal(description.mock, false, `${engine} uses the real executable`)
    }
    const saved = await savedFirstTurn(application, fixture, report)
    await application.close()
    application = undefined
    // A fresh daemon must read JSONL; reattaching a resident could hide failed disk persistence.
    await shutdownOwnedPrimeDaemons(fixture.primeDirectory, fixture.foreignPids)
    application = await launchApp(fixture.launchOptions)
    await resumeFirstTurn(application, fixture, saved, report)
    for (const modelId of MODEL_IDS.slice(1)) {
      await application.openWorkspace({
        cwd: fixture.workspace,
        args: {
          engine: 'prime',
          provider: PROVIDER,
          model: modelId,
          thinking: LIVE_THINKING_LEVEL,
          noSession: true,
          approve: true,
          name: `Engine 2 live ${modelId}`
        }
      })
      await tinyTurn(application, 'prime', modelId, PROMPT, report)
      await application.screenshot(`engine2-live-${modelId.split('/').at(-1)}`)
    }
    await application.openWorkspace({
      cwd: fixture.workspace,
      args: {
        engine: 'pi',
        provider: PROVIDER,
        model: MODEL_IDS[0],
        thinking: LIVE_THINKING_LEVEL,
        noSession: true,
        approve: true,
        name: 'Engine live provider sanity'
      }
    })
    await tinyTurn(application, 'pi', MODEL_IDS[0], PROMPT, report)
    await application.screenshot('engine1-live-provider')
    application.assertNoErrors()
  } catch (error) {
    failure = error
    report.failure = redact(error.message, apiKey)
    await application?.screenshot('live-provider-failure', { settleMs: 0 }).catch(() => undefined)
  } finally {
    try {
      await application?.close()
    } catch (error) {
      failure ??= error
    }
    try {
      await shutdownOwnedPrimeDaemons(fixture.primeDirectory, fixture.foreignPids)
    } catch (error) {
      failure ??= error
    } finally {
      await fixture.root.cleanup()
    }
    report.passed = !failure
    report.seconds = Number(((performance.now() - started) / 1000).toFixed(1))
    if (failure) report.failure = redact(failure.message, apiKey)
    await mkdir(SHOTS_DIRECTORY, { recursive: true })
    await writeFile(
      join(SHOTS_DIRECTORY, 'live-provider-report.json'),
      `${redact(JSON.stringify(report, null, 2), apiKey)}\n`
    )
  }
  if (failure) throw failure
  console.log(
    `${SUITE_NAME} passed (${report.seconds}s, estimated ` +
      `$${report.estimatedSpendUsd.toFixed(COST_DISPLAY_PRECISION)})`
  )
}

const prepareOnly = process.argv.includes('--prepare')
const optedIn = process.env.VENGEANCE_LIVE_PROVIDER_QA === '1'
if (!prepareOnly && !optedIn) {
  console.log(`${SUITE_NAME} skipped (set VENGEANCE_LIVE_PROVIDER_QA=1 for paid tiny turns)`)
} else {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY must be provided through the environment')
  try {
    assertOutsideRealHome(process.env.QA_TMP_ROOT || '')
    const [models, executable] = await Promise.all([providerModels(apiKey), nativeExecutable()])
    console.log(`${SUITE_NAME}: key accepted; models ${models.map((model) => model.id).join(', ')}`)
    if (prepareOnly) {
      console.log(`Preparation passed: native executable present, max output ${MODEL_OUTPUT_LIMIT}`)
    } else {
      await runLiveSmoke(models, executable, apiKey)
    }
  } catch (error) {
    console.error(redact(error.stack ?? error.message, apiKey))
    process.exitCode = 1
  }
}
