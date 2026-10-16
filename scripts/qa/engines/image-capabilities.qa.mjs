// Native image capability after a live footer model switch; no provider calls leave localhost.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makePng, pickModelInFooter, until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import {
  createEngineFixture,
  executableHash,
  PRIME_MODELS,
  PRIME_PROVIDER
} from './integration-fixture.mjs'

const SUITE_NAME = 'engine2-image-capabilities'
const VISION_PROVIDER = 'openai-codex'
const VISION_MODEL = 'gpt-6.1-sol'
const TEXT_ONLY_BUILTIN = 'gpt-5.3-codex-spark'
const MODEL_INFO_PREFIX = 'QA_MODEL_INFO='
const IMAGE_DIMENSION = 24
const TOOL_IMAGE = makePng(IMAGE_DIMENSION, IMAGE_DIMENSION, [40, 120, 220])
const PASTED_IMAGE = makePng(IMAGE_DIMENSION, IMAGE_DIMENSION, [180, 60, 100])
const OAUTH_VALIDITY_MS = 86_400_000
const KERNEL_TURN_TIMEOUT_MS = 120_000
const OUTPUT_DIRECTORY = reportShotsDir(SUITE_NAME)
const ACCOUNT_ID = 'qa-image-capabilities'
const encodeTokenPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const ACCESS_TOKEN = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID }
})}.qa-signature`

function capabilityLine(systemPrompt) {
  return systemPrompt.split('\n').find((line) => line.startsWith('Image input:'))
}

function assertPromptCapability(systemPrompt, vision) {
  assert.match(capabilityLine(systemPrompt) ?? '', vision ? /can see images/ : /cannot see images/)
}

function readModelInfo(text) {
  const line = text.split('\n').find((value) => value.startsWith(MODEL_INFO_PREFIX))
  assert.ok(line, `The native ipython result has no ${MODEL_INFO_PREFIX} line`)
  return JSON.parse(line.slice(MODEL_INFO_PREFIX.length))
}

async function configureBuiltinVisionProvider(fixture) {
  const modelsPath = join(fixture.primeDirectory, 'models.json')
  const configured = JSON.parse(await readFile(modelsPath, 'utf8'))
  // A provider URL override keeps the built-in model's modalities and reasoning map authoritative.
  configured.providers[VISION_PROVIDER] = { baseUrl: fixture.primeServer.openaiBaseUrl }
  await writeFile(modelsPath, `${JSON.stringify(configured, null, 2)}\n`)
  await writeFile(
    join(fixture.primeDirectory, 'auth.json'),
    `${JSON.stringify({
      [VISION_PROVIDER]: {
        type: 'oauth',
        access: ACCESS_TOKEN,
        refresh: 'qa-image-refresh',
        expires: Date.now() + OAUTH_VALIDITY_MS,
        accountId: ACCOUNT_ID
      }
    })}\n`
  )
  fixture.primeServer.setAccountModels([VISION_MODEL])
}

async function captureImageCell(application, server, agentId, toolCallId, imagePath) {
  const prompt = `Run the ${toolCallId} image capability probe.`
  const code = [
    'import json',
    'from rlm import host_request',
    `print(${JSON.stringify(MODEL_INFO_PREFIX)} + json.dumps(await host_request("model.info")))`,
    `print(await attach_image(${JSON.stringify(imagePath)}))`
  ].join('\n')
  const from = server.requests.length
  server.queue(
    turn.toolCalls([{ id: toolCallId, name: 'ipython', args: { code } }]),
    turn.text(`The ${toolCallId} probe settled.`)
  )
  await application.send(prompt)
  const resultRequest = await server.waitForRequest(
    (request) =>
      inspectRequest(request).toolResults.some((result) => result.toolCallId === toolCallId),
    { from, timeoutMs: KERNEL_TURN_TIMEOUT_MS }
  )
  await application.waitForSettle({ timeoutMs: KERNEL_TURN_TIMEOUT_MS })
  const firstRequest = server.requests
    .slice(from)
    .find((request) => request.api && request.method === 'POST')
  const inspected = inspectRequest(resultRequest)
  const result = inspected.toolResults.find((item) => item.toolCallId === toolCallId)
  const { messages } = await application.rpc({ type: 'get_messages' }, agentId)
  const nativeResult = messages.findLast(
    (message) => message.role === 'toolResult' && message.toolCallId.split('|')[0] === toolCallId
  )
  assert.ok(nativeResult, 'The public transcript contains the native ipython result')
  return { firstRequest, resultRequest, inspected, result, nativeResult }
}

async function pasteImage(application, name) {
  await application.page.evaluate(
    ({ base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const file = new File([bytes], fileName, { type: 'image/png' })
      const clipboard = new DataTransfer()
      clipboard.items.add(file)
      const textarea = document.querySelector('textarea[aria-label="Message"]')
      textarea.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true
        })
      )
    },
    { base64: PASTED_IMAGE.toString('base64'), fileName: name }
  )
  await until(async () => (await application.page.locator('[data-composer] img').count()) === 1, {
    label: 'pasted image prepared'
  })
}

async function screenshotModelPicker(application, provider, model, name, vision) {
  await application.page.getByRole('button', { name: /^Model:/ }).click()
  const search = application.page.getByPlaceholder('Search models…')
  await search.fill(model)
  const row = application.page.locator(`[cmdk-item][data-value="${provider}/${model}"]`)
  await row.waitFor()
  assert.equal(await row.locator('[aria-label="Image input"]').count(), vision ? 1 : 0)
  await application.screenshot(name)
  await application.page.keyboard.press('Escape')
}

console.log(`▶ ${SUITE_NAME} (native staged package, built-in vision model, local provider)`)
const fixture = await createEngineFixture()
const report = { startedAt: new Date().toISOString(), checks: [], observations: {} }
let application
let failure

async function check(label, action) {
  console.log(`  • ${label}`)
  try {
    await action()
    report.checks.push({ label, passed: true })
    console.log(`    ✓ ${label}`)
  } catch (error) {
    const screenshot = await application
      ?.screenshot(`FAIL-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`)
      .catch(() => undefined)
    report.checks.push({ label, passed: false, error: error.stack, screenshot })
    console.error(`    ✗ ${label}: ${error.message}`)
    await application?.page.keyboard.press('Escape').catch(() => undefined)
  }
}

try {
  await configureBuiltinVisionProvider(fixture)
  const workspace = await fixture.root.folder('workspace', {
    'README.md': '# Isolated Engine 2 image capability QA\n'
  })
  const imagePath = join(workspace, 'tool-image.png')
  await writeFile(imagePath, TOOL_IMAGE)
  application = await launchApp({
    exe: process.env.QA_PACKAGED_EXE,
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  const { agentId } = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: PRIME_PROVIDER,
      model: PRIME_MODELS.reasoning,
      thinking: 'off',
      name: 'Image capability switch'
    }
  })
  const descriptor = await application.invoke('engine:describe', 'prime')
  report.engine = { ...descriptor, sha256: await executableHash(descriptor.cliPath) }
  report.candidate = await fixture.verifyPrimeExecutable(application, agentId)
  const initialState = await application.rpc({ type: 'get_state' }, agentId)
  const initialWorker = (await application.invoke('engine:list')).find(
    (agent) => agent.agentId === agentId
  )
  const initialPrompt = await application.invoke('prime:command', agentId, 'get_system_prompt', {})
  assert.deepEqual(initialState.model.input, ['text'])
  assertPromptCapability(initialPrompt.systemPrompt, false)
  report.observations.initialPrompt = capabilityLine(initialPrompt.systemPrompt)

  const initialCell = await captureImageCell(
    application,
    fixture.primeServer,
    agentId,
    'initial-text-image',
    imagePath
  )
  await check('initial text-only model rejects attach_image', async () => {
    assert.deepEqual(readModelInfo(initialCell.result.text), {
      id: PRIME_MODELS.reasoning,
      provider: PRIME_PROVIDER,
      input: ['text']
    })
    assert.equal(initialCell.nativeResult.details.status, 'error')
    assert.equal(initialCell.nativeResult.details.error.ename, 'RuntimeError')
    assert.match(initialCell.result.text, /does not support vision/)
    assert.equal(initialCell.inspected.imageCount, 0)
  })

  await check('built-in GPT 6.1 Sol catalog and picker identify image input', async () => {
    const { models } = await application.rpc({ type: 'get_available_models' }, agentId)
    const target = models.find(
      (model) => model.provider === VISION_PROVIDER && model.id === VISION_MODEL
    )
    assert.ok(target, 'The native built-in model is available with isolated OAuth')
    assert.equal(target.api, 'openai-codex-responses')
    assert.equal(target.baseUrl, fixture.primeServer.openaiBaseUrl)
    assert.deepEqual(target.input, ['text', 'image'])
    const catalog = await application.invoke('prime:command', agentId, 'get_model_catalog', {})
    const catalogTarget = catalog.models.find(
      (model) => model.provider === VISION_PROVIDER && model.id === VISION_MODEL
    )
    const textOnly = catalog.models.find(
      (model) => model.provider === VISION_PROVIDER && model.id === TEXT_ONLY_BUILTIN
    )
    assert.deepEqual(catalogTarget.input, target.input)
    assert.deepEqual(textOnly.input, ['text'])
    report.observations.targetModel = target
    await screenshotModelPicker(
      application,
      VISION_PROVIDER,
      VISION_MODEL,
      'engine2-vision-model-picker',
      true
    )
  })
  await pickModelInFooter(application, VISION_PROVIDER, VISION_MODEL)
  await until(
    async () => {
      const state = await application.rpc({ type: 'get_state' }, agentId)
      return state.model.id === VISION_MODEL && state.model.provider === VISION_PROVIDER
    },
    { label: 'native built-in vision model selection' }
  )
  const switchedState = await application.rpc({ type: 'get_state' }, agentId)
  report.observations.switchedModel = switchedState.model
  await check('live vision state keeps the native input modalities', async () => {
    assert.deepEqual(switchedState.model.input, ['text', 'image'])
  })
  const switchedPrompt = await application.invoke('prime:command', agentId, 'get_system_prompt', {})
  report.observations.switchedPrompt = capabilityLine(switchedPrompt.systemPrompt)
  await check('live vision switch refreshes the public system prompt', async () => {
    assertPromptCapability(switchedPrompt.systemPrompt, true)
  })

  const visionCell = await captureImageCell(
    application,
    fixture.primeServer,
    agentId,
    'vision-attach-image',
    imagePath
  )
  report.observations.visionModelInfo = readModelInfo(visionCell.result.text)
  report.observations.visionResultImages = visionCell.result.images
  report.observations.visionToolText = visionCell.result.text
  report.observations.visionProviderPrompt = capabilityLine(
    inspectRequest(visionCell.firstRequest).system
  )
  await check('vision provider request advertises image input', async () => {
    assert.equal(visionCell.firstRequest.body.model, VISION_MODEL)
    assert.equal(visionCell.firstRequest.path, '/v1/codex/responses')
    assertPromptCapability(inspectRequest(visionCell.firstRequest).system, true)
    assertPromptCapability(visionCell.inspected.system, true)
  })
  await check('live vision switch rebinds model.info in the native Python kernel', async () => {
    assert.deepEqual(report.observations.visionModelInfo, {
      id: VISION_MODEL,
      provider: VISION_PROVIDER,
      input: ['text', 'image']
    })
  })
  await check('attach_image sends actual image bytes in the native tool result', async () => {
    assert.equal(visionCell.nativeResult.details.status, 'ok', visionCell.result.text)
    assert.equal(visionCell.result.images, 1)
    const output = visionCell.resultRequest.body.input.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'vision-attach-image'
    ).output
    const attachment = output.find((block) => block.type === 'input_image')
    assert.equal(attachment.image_url, `data:image/png;base64,${TOOL_IMAGE.toString('base64')}`)
    assert.equal(
      visionCell.nativeResult.content.filter((block) => block.type === 'image').length,
      1
    )
    await application.screenshot('engine2-vision-tool-image')
  })

  await pasteImage(application, 'pasted-vision.png')
  await check('pasted vision image has no unsupported warning', async () => {
    await application.screenshot('engine2-vision-pasted-image')
    assert.equal(await application.page.getByText(/can.t read images/).count(), 0)
  })
  await check('pasted image reaches the vision provider', async () => {
    try {
      const from = fixture.primeServer.requests.length
      fixture.primeServer.queue(turn.text('The pasted image arrived.'))
      await application.send('Inspect the pasted image.')
      const request = await fixture.primeServer.waitForRequest((item) => item.method === 'POST', {
        from
      })
      await application.waitForSettle()
      const user = request.body.input.findLast((item) => item.role === 'user')
      const image = user.content.find((block) => block.type === 'input_image')
      assert.equal(image.image_url, `data:image/png;base64,${PASTED_IMAGE.toString('base64')}`)
      assert.equal(await application.page.locator('[data-composer] img').count(), 0)
    } finally {
      const remove = application.page.getByRole('button', { name: 'Remove pasted-vision.png' })
      if (await remove.count()) await remove.click()
    }
  })

  await pickModelInFooter(application, PRIME_PROVIDER, PRIME_MODELS.reasoning)
  await until(
    async () => {
      const state = await application.rpc({ type: 'get_state' }, agentId)
      return state.model.id === PRIME_MODELS.reasoning && state.model.provider === PRIME_PROVIDER
    },
    { label: 'native text-only model selection' }
  )
  const restoredPrompt = await application.invoke('prime:command', agentId, 'get_system_prompt', {})
  report.observations.restoredPrompt = capabilityLine(restoredPrompt.systemPrompt)
  await check('switching back restores the text-only prompt and picker', async () => {
    assertPromptCapability(restoredPrompt.systemPrompt, false)
    await screenshotModelPicker(
      application,
      PRIME_PROVIDER,
      PRIME_MODELS.reasoning,
      'engine2-text-model-picker',
      false
    )
  })
  const textCell = await captureImageCell(
    application,
    fixture.primeServer,
    agentId,
    'restored-text-image',
    imagePath
  )
  report.observations.restoredModelInfo = readModelInfo(textCell.result.text)
  await check('text-only switch rejects attach_image without leaking image input', async () => {
    assert.deepEqual(report.observations.restoredModelInfo, {
      id: PRIME_MODELS.reasoning,
      provider: PRIME_PROVIDER,
      input: ['text']
    })
    assert.equal(textCell.nativeResult.details.status, 'error')
    assert.equal(textCell.nativeResult.details.error.ename, 'RuntimeError')
    assert.match(textCell.result.text, /does not support vision/)
    assert.equal(textCell.inspected.imageCount, 0)
    assert.equal(textCell.nativeResult.content.filter((block) => block.type === 'image').length, 0)
    assertPromptCapability(inspectRequest(textCell.firstRequest).system, false)
  })
  await check('text-only pasted image warns without changing session identity', async () => {
    await pasteImage(application, 'pasted-text-only.png')
    await application.page.getByText(/can.t read images/).waitFor()
    await application.screenshot('engine2-text-image-warning')
    await application.page.getByRole('button', { name: 'Remove pasted-text-only.png' }).click()
    const state = await application.rpc({ type: 'get_state' }, agentId)
    const worker = (await application.invoke('engine:list')).find(
      (agent) => agent.agentId === agentId
    )
    assert.equal(state.sessionId, initialState.sessionId)
    assert.equal(state.sessionFile, initialState.sessionFile)
    assert.equal(worker.pid, initialWorker.pid, 'The regression must exercise a live switch')
  })
  await application.openWorkspace({
    cwd: workspace,
    args: {
      engine: 'prime',
      provider: VISION_PROVIDER,
      model: VISION_MODEL,
      thinking: 'low',
      noSession: true,
      name: 'Vision startup'
    }
  })
  const startupAgentId = await application.activeAgentId()
  const startupState = await application.rpc({ type: 'get_state' }, startupAgentId)
  report.observations.startupModel = startupState.model
  await check('a new built-in vision session exposes image input in public state', async () => {
    assert.deepEqual(startupState.model.input, ['text', 'image'])
  })
  const startupPrompt = await application.invoke(
    'prime:command',
    startupAgentId,
    'get_system_prompt',
    {}
  )
  const startupCell = await captureImageCell(
    application,
    fixture.primeServer,
    startupAgentId,
    'startup-vision-image',
    imagePath
  )
  report.observations.startupModelInfo = readModelInfo(startupCell.result.text)
  report.observations.startupToolText = startupCell.result.text
  report.observations.startupResultImages = startupCell.result.images
  report.observations.startupNativeResult = startupCell.nativeResult
  report.observations.startupProviderInput = startupCell.resultRequest.body.input
  await check('a new built-in vision session starts with working image capability', async () => {
    assertPromptCapability(startupPrompt.systemPrompt, true)
    assertPromptCapability(inspectRequest(startupCell.firstRequest).system, true)
    assert.deepEqual(readModelInfo(startupCell.result.text), {
      id: VISION_MODEL,
      provider: VISION_PROVIDER,
      input: ['text', 'image']
    })
    assert.equal(startupCell.nativeResult.details.status, 'ok', startupCell.result.text)
    assert.equal(startupCell.result.images, 1, startupCell.result.text)
    const output = startupCell.resultRequest.body.input.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'startup-vision-image'
    ).output
    assert.equal(
      output.find((block) => block.type === 'input_image').image_url,
      `data:image/png;base64,${TOOL_IMAGE.toString('base64')}`
    )
    await application.screenshot('engine2-vision-startup')
  })
  application.assertNoErrors()
  const failed = report.checks.filter((entry) => !entry.passed)
  if (failed.length) throw new Error(`${failed.length} image capability checks failed`)
} catch (error) {
  failure = error
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    failure ??= error
  })
  await fixture.cleanup().catch((error) => {
    failure ??= error
  })
  report.failure = failure?.stack
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(join(OUTPUT_DIRECTORY, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log(`✓ Native image capability: ${report.checks.length} checks passed`)
}
