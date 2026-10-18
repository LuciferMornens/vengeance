// Historical resident attachment and explicit upgrade through public app/native operations.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { makePng, pickModelInFooter, until } from '../chat/helpers.mjs'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { executableName } from '../lib/platform.mjs'
import { isAlive, processIdentity } from '../lib/processes.mjs'
import {
  createEngineFixture,
  executableHash,
  PRIME_MODELS,
  PRIME_PROVIDER
} from './integration-fixture.mjs'

const SUITE_NAME = 'engine2-resident-upgrade'
const OBSERVE = process.argv.includes('--observe')
const BASELINE_VISION_SWITCH = process.env.QA_PRIME_BASELINE_VISION_SWITCH ?? 'stale'
assert.ok(
  ['working', 'stale'].includes(BASELINE_VISION_SWITCH),
  'QA_PRIME_BASELINE_VISION_SWITCH must be working or stale'
)
const VISION_PROVIDER = 'openai-codex'
const VISION_MODEL = 'gpt-6.1-sol'
const MODEL_INFO_PREFIX = 'QA_MODEL_INFO='
const SAVED_SESSION_NAME = 'Resident vision upgrade'
const STARTUP_SESSION_NAME = 'Older vision startup'
const HISTORY_ANSWER = 'This saved history survives the explicit Engine 2 upgrade.'
const OUTPUT_DIRECTORY = reportShotsDir(SUITE_NAME)
const IMAGE_DIMENSION = 24
const TOOL_IMAGE = makePng(IMAGE_DIMENSION, IMAGE_DIMENSION, [40, 120, 220])
const OAUTH_VALIDITY_MS = 86_400_000
const KERNEL_TIMEOUT_MS = 120_000
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 }
// Electron enforces the app's 880px minimum width; 200% zoom gives a 440px CSS viewport.
const MINIMUM_WINDOW_SIZE = { width: 880, height: 700 }
const LARGE_TEXT_ZOOM = 2
const ACCOUNT_ID = 'qa-resident-upgrade'
const encodeTokenPart = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const ACCESS_TOKEN = `${encodeTokenPart({ alg: 'none' })}.${encodeTokenPart({
  'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID }
})}.qa-signature`

function samePath(actual, expected) {
  return (
    typeof actual === 'string' &&
    typeof expected === 'string' &&
    resolve(actual).toLowerCase() === resolve(expected).toLowerCase()
  )
}

function capabilityLine(systemPrompt) {
  return systemPrompt.split('\n').find((line) => line.startsWith('Image input:'))
}

function readModelInfo(result) {
  const line = result.text.split('\n').find((value) => value.startsWith(MODEL_INFO_PREFIX))
  assert.ok(line, `The native ipython result has no ${MODEL_INFO_PREFIX} line`)
  return JSON.parse(line.slice(MODEL_INFO_PREFIX.length))
}

async function packageIdentity(executable) {
  const path = await realpath(executable)
  const metadata = JSON.parse(await readFile(join(dirname(path), 'package.json'), 'utf8'))
  return { executablePath: path, version: metadata.version, sha256: await executableHash(path) }
}

async function configureModels(fixture) {
  const modelsPath = join(fixture.primeDirectory, 'models.json')
  const configured = JSON.parse(await readFile(modelsPath, 'utf8'))
  const customText = configured.providers[PRIME_PROVIDER].models[0]
  // The same ID and vision-looking name must not override this exact provider's text-only input.
  configured.providers[PRIME_PROVIDER].models.push({
    ...customText,
    id: VISION_MODEL,
    name: 'GPT 6.1 Sol custom text only'
  })
  configured.providers[VISION_PROVIDER] = { baseUrl: fixture.primeServer.openaiBaseUrl }
  await writeFile(modelsPath, `${JSON.stringify(configured, null, 2)}\n`)
  await writeFile(
    join(fixture.primeDirectory, 'auth.json'),
    `${JSON.stringify({
      [VISION_PROVIDER]: {
        type: 'oauth',
        access: ACCESS_TOKEN,
        refresh: 'qa-resident-refresh',
        expires: Date.now() + OAUTH_VALIDITY_MS,
        accountId: ACCOUNT_ID
      }
    })}\n`
  )
  fixture.primeServer.setAccountModels([VISION_MODEL])
}

async function captureImageProbe(application, server, agentId, toolCallId, imagePath) {
  const code = [
    'import json',
    'from rlm import host_request',
    `print(${JSON.stringify(MODEL_INFO_PREFIX)} + json.dumps(await host_request("model.info")))`,
    `print(await attach_image(${JSON.stringify(imagePath)}))`
  ].join('\n')
  const from = server.requests.length
  server.queue(
    turn.toolCalls([{ id: toolCallId, name: 'ipython', args: { code } }]),
    turn.text(`The ${toolCallId} image probe settled.`)
  )
  await application.send(`Run the ${toolCallId} image probe.`)
  const resultRequest = await server.waitForRequest(
    (request) =>
      inspectRequest(request).toolResults.some((result) => result.toolCallId === toolCallId),
    { from, timeoutMs: KERNEL_TIMEOUT_MS }
  )
  await application.waitForSettle({ timeoutMs: KERNEL_TIMEOUT_MS })
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
  return {
    modelInfo: readModelInfo(result),
    firstPrompt: capabilityLine(inspectRequest(firstRequest).system),
    resultPrompt: capabilityLine(inspected.system),
    images: result.images,
    nativeResult,
    resultText: result.text,
    providerInput: resultRequest.body.input
  }
}

function assertVisionProbe(probe, toolCallId) {
  assert.deepEqual(probe.modelInfo, {
    id: VISION_MODEL,
    provider: VISION_PROVIDER,
    input: ['text', 'image']
  })
  assert.match(probe.firstPrompt, /can see images/)
  assert.match(probe.resultPrompt, /can see images/)
  assert.equal(probe.nativeResult.details.status, 'ok', probe.resultText)
  assert.equal(probe.images, 1)
  const output = probe.providerInput.find(
    (item) => item.type === 'function_call_output' && item.call_id === toolCallId
  ).output
  const image = output.find((block) => block.type === 'input_image')
  assert.equal(image.image_url, `data:image/png;base64,${TOOL_IMAGE.toString('base64')}`)
  assert.equal(probe.nativeResult.content.filter((block) => block.type === 'image').length, 1)
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
    { base64: TOOL_IMAGE.toString('base64'), fileName: name }
  )
  await until(async () => (await application.page.locator('[data-composer] img').count()) === 1, {
    label: 'resident image prepared'
  })
}

async function closeTab(application, name, agentId) {
  const row = application.page.locator('section[aria-label="Open sessions"] [data-session-row]', {
    hasText: name
  })
  await row.hover()
  // Qualification also runs against the app build with backend-specific tab-close labels.
  await row
    .locator('xpath=..')
    .getByRole('button', { name: /^(Close tab|Detach session|Close session)$/ })
    .click()
  await until(async () => !(await application.agentState(agentId)), {
    label: 'resident tab closed'
  })
}

async function selectExecutable(application, executable) {
  await application.invoke('app:set-state', { engineOverridePaths: { prime: executable } })
  const descriptor = await application.invoke('engine:describe', 'prime')
  assert.equal(descriptor.source, 'override')
  assert.ok(samePath(descriptor.cliPath, executable))
  return descriptor
}

function messageHistory({ messages }) {
  return messages.map((message) => {
    if (message.role !== 'assistant') return message
    // Native JSON persistence can round decimal USD costs, but not history content or tokens.
    const usage = { ...message.usage }
    delete usage.cost
    return { ...message, usage }
  })
}

async function residentIdentity(application, agentId) {
  const info = (await application.invoke('engine:list')).find((agent) => agent.agentId === agentId)
  const worker = await processIdentity(info?.pid)
  const daemon = await processIdentity(worker.parentPid)
  const state = await application.rpc({ type: 'get_state' }, agentId)
  return { info, worker, daemon, state }
}

async function recordSnapshots(application) {
  await application.page.evaluate(() => {
    window.__residentUpgradeSnapshots = []
    window.vengeance.on('engine:event', ({ agentId, event }) => {
      if (event.type === 'engine_native_event' && event.name === 'session_snapshot') {
        window.__residentUpgradeSnapshots.push({ agentId, state: event.data.state })
      }
    })
  })
}

async function assertSelectedMetadata(application, agentId, provider, modelId) {
  const catalog = await application.invoke('prime:command', agentId, 'get_model_catalog', {})
  const target = catalog.models.find((model) => model.provider === provider && model.id === modelId)
  assert.ok(target, 'The exact selected provider/model exists in the resident native catalog')
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.model.provider, provider)
  assert.equal(state.model.id, modelId)
  for (const field of ['input', 'cost', 'thinkingLevelMap', 'contextWindow', 'maxTokens']) {
    assert.deepEqual(state.model[field], target[field], `Resident-native selected ${field}`)
  }
  assert.equal(state.model.headers, undefined, 'Configured native headers do not reach state IPC')
  assert.equal(
    state.model.compat,
    undefined,
    'Configured native compatibility stays out of state IPC'
  )
  return { selected: state.model, catalog: target }
}

async function assertUpgradeNotice(application, agentId, baseline, selected) {
  const info = (await application.invoke('engine:list')).find((agent) => agent.agentId === agentId)
  assert.deepEqual(info.runtime, {
    version: baseline.version,
    selectedVersion: selected.version
  })
  const notice = application.page.locator('[data-engine-upgrade]')
  assert.equal(await notice.count(), 1, 'A persistent session-scoped upgrade notice is visible')
  assert.equal(await notice.getAttribute('role'), 'status')
  const text = await notice.innerText()
  assert.ok(text.includes(baseline.version), 'The notice reports the running resident version')
  assert.ok(text.includes(selected.version), 'The notice reports the selected install version')
  assert.equal(
    await notice.getByRole('button', { name: 'Restart session', exact: true }).count(),
    1
  )
}

async function main() {
  const baselineExecutable = process.env.QA_PRIME_BASELINE_EXECUTABLE
  const baselineHash = process.env.QA_PRIME_BASELINE_SHA256?.toLowerCase()
  if (baselineExecutable === undefined && baselineHash === undefined) {
    console.log(`SKIP ${SUITE_NAME}: set reviewed QA_PRIME_BASELINE_EXECUTABLE and SHA256`)
    return
  }
  assert.ok(baselineExecutable && isAbsolute(baselineExecutable))
  assert.match(baselineHash ?? '', /^[a-f0-9]{64}$/)
  const baseline = await packageIdentity(baselineExecutable)
  assert.equal(baseline.sha256, baselineHash, 'The reviewed older executable hash matches')
  const fixture = await createEngineFixture()
  const report = {
    startedAt: new Date().toISOString(),
    baselineVisionSwitch: BASELINE_VISION_SWITCH,
    checks: [],
    observations: {}
  }
  let application
  let failure

  async function check(label, action) {
    console.log(`  • ${label}`)
    try {
      await action()
      report.checks.push({ label, passed: true, screenshot: await application.screenshot(label) })
      console.log(`    ✓ ${label}`)
    } catch (error) {
      const screenshot = await application.screenshot(`FAIL-${label}`).catch(() => undefined)
      report.checks.push({ label, passed: false, error: error.stack, screenshot })
      console.error(`    ✗ ${label}: ${error.message}`)
      if (!OBSERVE) throw error
    }
  }

  try {
    const selected = await packageIdentity(
      fixture.candidate?.executablePath ??
        join(ROOT, '.engine-staging', 'bundled', 'prime', executableName('prime-agent'))
    )
    assert.notEqual(selected.sha256, baseline.sha256)
    assert.notEqual(selected.version, baseline.version)
    report.packages = { baseline, selected }
    await configureModels(fixture)
    const workspace = await fixture.root.folder('resident-workspace', {
      'README.md': '# Isolated older resident image and upgrade QA\n'
    })
    const imagePath = join(workspace, 'resident-image.png')
    await writeFile(imagePath, TOOL_IMAGE)
    application = await launchApp({
      exe: process.env.QA_PACKAGED_EXE,
      agentDir: fixture.piDirectory.dir,
      env: fixture.environment,
      outDir: OUTPUT_DIRECTORY
    })
    await selectExecutable(application, baseline.executablePath)
    const startup = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: VISION_PROVIDER,
        model: VISION_MODEL,
        thinking: 'low',
        noSession: true,
        name: STARTUP_SESSION_NAME
      }
    })
    const startupIdentity = await residentIdentity(application, startup.agentId)
    assert.ok(samePath(startupIdentity.worker.executablePath, baseline.executablePath))
    report.observations.startupIdentity = startupIdentity
    report.observations.startupNativeState = await application.invoke(
      'prime:command',
      startup.agentId,
      'get_connection_state',
      {}
    )
    const startupProbe = await captureImageProbe(
      application,
      fixture.primeServer,
      startup.agentId,
      'old-startup-image',
      imagePath
    )
    report.observations.startupProbe = startupProbe
    await check('older fresh Sol startup has a working native image binding', async () => {
      assertVisionProbe(startupProbe, 'old-startup-image')
    })
    await closeTab(application, STARTUP_SESSION_NAME, startup.agentId)
    await until(() => !isAlive(startupIdentity.worker.pid), { label: 'temporary resident stopped' })

    const opened = await application.openWorkspace({
      cwd: workspace,
      args: {
        engine: 'prime',
        provider: PRIME_PROVIDER,
        model: PRIME_MODELS.reasoning,
        thinking: 'off',
        name: SAVED_SESSION_NAME
      }
    })
    let agentId = opened.agentId
    fixture.primeServer.queue(turn.text(HISTORY_ANSWER))
    await application.send('Remember this brief history before upgrading the resident.')
    await application.waitForSettle()
    const textProbe = await captureImageProbe(
      application,
      fixture.primeServer,
      agentId,
      'old-text-image',
      imagePath
    )
    assert.deepEqual(textProbe.modelInfo.input, ['text'])
    assert.equal(textProbe.nativeResult.details.status, 'error')

    await pickModelInFooter(application, PRIME_PROVIDER, VISION_MODEL)
    await check(
      'same model ID under a custom provider stays authoritatively text only',
      async () => {
        report.observations.customText = await assertSelectedMetadata(
          application,
          agentId,
          PRIME_PROVIDER,
          VISION_MODEL
        )
        assert.deepEqual(report.observations.customText.selected.input, ['text'])
        await pasteImage(application, 'custom-text.png')
        assert.equal(await application.page.getByText(/can.t read images/).count(), 1)
        await application.page.getByRole('button', { name: 'Remove custom-text.png' }).click()
      }
    )
    await pickModelInFooter(application, VISION_PROVIDER, VISION_MODEL)
    const oldProbe = await captureImageProbe(
      application,
      fixture.primeServer,
      agentId,
      'old-switched-image',
      imagePath
    )
    report.observations.oldLiveSwitch = oldProbe
    await check(
      BASELINE_VISION_SWITCH === 'working'
        ? 'older live switch refreshes its native image binding and selected controls'
        : 'older live switch has the known stale native prompt and kernel binding',
      async () => {
        if (BASELINE_VISION_SWITCH === 'working') {
          assertVisionProbe(oldProbe, 'old-switched-image')
          await assertSelectedMetadata(application, agentId, VISION_PROVIDER, VISION_MODEL)
          const selected = (await application.agentState(agentId)).model
          assert.equal(selected.provider, VISION_PROVIDER)
          assert.equal(selected.id, VISION_MODEL)
          assert.deepEqual(selected.input, ['text', 'image'])
          return
        }
        assert.match(oldProbe.firstPrompt, /cannot see images/)
        assert.deepEqual(oldProbe.modelInfo.input, ['text'])
        assert.equal(oldProbe.nativeResult.details.status, 'error')
        assert.match(oldProbe.resultText, /does not support vision/)
        assert.equal(oldProbe.images, 0)
      }
    )
    const before = await residentIdentity(application, agentId)
    const beforeMessages = await application.rpc({ type: 'get_messages' }, agentId)
    const savedFile = await readFile(before.state.sessionFile)
    report.before = { ...before, messages: beforeMessages }
    assert.ok(samePath(before.worker.executablePath, baseline.executablePath))
    assert.ok(samePath(before.daemon.executablePath, baseline.executablePath))
    assert.ok(before.state.sessionFile)
    await selectExecutable(application, selected.executablePath)
    await closeTab(application, SAVED_SESSION_NAME, agentId)
    assert.equal(isAlive(before.worker.pid), true, 'Detaching leaves the older resident alive')
    await recordSnapshots(application)
    const reopened = await application.openWorkspace({
      cwd: workspace,
      args: { engine: 'prime', sessionPath: before.state.sessionFile }
    })
    agentId = reopened.agentId
    const attached = await residentIdentity(application, agentId)
    report.attached = attached
    assert.equal(attached.worker.pid, before.worker.pid, 'Resume attaches, it does not upgrade')
    assert.equal(attached.info.nativeAgentId, before.info.nativeAgentId)
    await check(
      'reopened resident state uses its exact native catalog modalities and limits',
      async () => {
        report.observations.attachedModel = await assertSelectedMetadata(
          application,
          agentId,
          VISION_PROVIDER,
          VISION_MODEL
        )
        assert.equal(report.observations.attachedModel.selected.baseUrl, '')
        const snapshots = await application.page.evaluate(() => window.__residentUpgradeSnapshots)
        const snapshot = snapshots.findLast((entry) => entry.agentId === agentId)
        assert.ok(snapshot, 'A public native attach snapshot was delivered')
        assert.deepEqual(snapshot.state.model.input, ['text', 'image'])
      }
    )
    await check('reopened older resident visibly distinguishes running and selected versions', () =>
      assertUpgradeNotice(application, agentId, baseline, selected)
    )
    await pasteImage(application, 'resident-before-restart.png')
    await check('reopened Sol image draft has no false unsupported warning', async () => {
      assert.equal(await application.page.getByText(/can.t read images/).count(), 0)
    })
    await application.page
      .getByRole('button', { name: 'Remove resident-before-restart.png' })
      .click()

    application = await application.relaunch()
    const resumed = await until(
      async () => {
        const active = await application.agentState()
        return active?.status === 'ready' &&
          samePath(active.session?.sessionFile, before.state.sessionFile)
          ? active
          : undefined
      },
      { label: 'older resident reattached after an app relaunch', timeoutMs: KERNEL_TIMEOUT_MS }
    )
    agentId = resumed.id
    report.relaunched = await residentIdentity(application, agentId)
    assert.equal(report.relaunched.worker.pid, before.worker.pid)
    assert.equal(report.relaunched.info.nativeAgentId, before.info.nativeAgentId)
    await check('app relaunch keeps the older resident and its upgrade notice', () =>
      assertUpgradeNotice(application, agentId, baseline, selected)
    )
    await check('app relaunch restores authoritative native Sol image support', async () => {
      await assertSelectedMetadata(application, agentId, VISION_PROVIDER, VISION_MODEL)
      assert.deepEqual((await application.agentState(agentId)).model.input, ['text', 'image'])
    })

    await check('upgrade notice fits Bone at minimum width and large text', async () => {
      await application.test('setPrefs', { theme: 'light' })
      await application.page.keyboard.press('ControlOrMeta+b')
      await application.app.evaluate(
        ({ BrowserWindow }, { size, zoom }) => {
          const browserWindow = BrowserWindow.getAllWindows()[0]
          browserWindow.setContentSize(size.width, size.height)
          browserWindow.webContents.setZoomFactor(zoom)
        },
        { size: MINIMUM_WINDOW_SIZE, zoom: LARGE_TEXT_ZOOM }
      )
      try {
        const notice = application.page.locator('[data-engine-upgrade]')
        assert.equal(await notice.count(), 1)
        await application.screenshot('resident-upgrade-Bone-minimum-width-200-percent')
        // Native capture uses device pixels when Electron zoom exceeds the CSS screenshot size.
        const nativeImage = await application.app.evaluate(async ({ BrowserWindow }) => {
          const browserWindow = BrowserWindow.getAllWindows()[0]
          const image = await browserWindow.webContents.capturePage()
          return image.toPNG().toString('base64')
        })
        const nativeScreenshot = join(
          OUTPUT_DIRECTORY,
          'resident-upgrade-Bone-minimum-width-200-percent-native.png'
        )
        await writeFile(nativeScreenshot, Buffer.from(nativeImage, 'base64'))
        report.observations.minimumWidthNativeScreenshot = nativeScreenshot
        report.observations.minimumWidthNotice = await notice.evaluate((element) =>
          [element, ...element.querySelectorAll('p,button')].map((item) => ({
            tag: item.tagName,
            text: item.textContent,
            clientWidth: item.clientWidth,
            scrollWidth: item.scrollWidth,
            bounds: item.getBoundingClientRect().toJSON()
          }))
        )
        const viewport = await application.page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          bodyWidth: document.body.clientWidth,
          bodyScrollWidth: document.body.scrollWidth
        }))
        report.observations.minimumWidthViewport = viewport
        const bounds = await notice.boundingBox()
        const button = notice.getByRole('button', { name: 'Restart session', exact: true })
        const buttonBounds = await button.boundingBox()
        assert.ok(bounds && buttonBounds, 'The notice and restart action remain visible')
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width)
        assert.ok(buttonBounds.x >= bounds.x)
        assert.ok(buttonBounds.x + buttonBounds.width <= bounds.x + bounds.width)
        const actionHit = await button.evaluate((element) => {
          const buttonBounds = element.getBoundingClientRect()
          const x = buttonBounds.x + buttonBounds.width / 2
          const y = buttonBounds.y + buttonBounds.height / 2
          const hit = document.elementFromPoint(x, y)
          return {
            x,
            y,
            hitTag: hit?.tagName,
            hitText: hit?.textContent,
            visible: !!hit && element.contains(hit)
          }
        })
        report.observations.minimumWidthActionHit = actionHit
        assert.equal(
          actionHit.visible,
          true,
          'The restart action is not covered by another surface'
        )
        const clipped = report.observations.minimumWidthNotice.some(
          (item) => item.scrollWidth > item.clientWidth + 1
        )
        assert.equal(clipped, false, 'Notice text and action do not clip')
      } finally {
        await application.app.evaluate(({ BrowserWindow }, size) => {
          const browserWindow = BrowserWindow.getAllWindows()[0]
          browserWindow.webContents.setZoomFactor(1)
          browserWindow.setContentSize(size.width, size.height)
        }, DEFAULT_WINDOW_SIZE)
        await application.test('setPrefs', { theme: 'dark' })
        await application.page.keyboard.press('ControlOrMeta+b')
      }
    })

    const restartButton = application.page
      .locator('[data-engine-upgrade]')
      .getByRole('button', { name: 'Restart session', exact: true })
    if (await restartButton.count()) {
      await restartButton.click()
    } else {
      assert.ok(OBSERVE, 'The explicit session upgrade action must be available')
      // Observation mode can qualify app builds without the session upgrade button.
      await application.invoke('engine:restart', agentId, undefined)
    }
    await until(
      async () => {
        const info = (await application.invoke('engine:list')).find(
          (agent) => agent.agentId === agentId
        )
        return info?.status === 'ready' && info.pid !== before.worker.pid
      },
      { label: 'selected resident worker restored', timeoutMs: KERNEL_TIMEOUT_MS }
    )
    const after = await residentIdentity(application, agentId)
    const afterMessages = await application.rpc({ type: 'get_messages' }, agentId)
    report.after = { ...after, messages: afterMessages }
    await check('explicit restart preserves history and changes actual executable', async () => {
      assert.ok(samePath(after.worker.executablePath, selected.executablePath))
      assert.ok(samePath(after.daemon.executablePath, selected.executablePath))
      assert.equal(isAlive(before.worker.pid), false)
      assert.equal(isAlive(before.daemon.pid), false)
      assert.equal(after.info.nativeAgentId, before.info.nativeAgentId)
      assert.equal(after.state.sessionId, before.state.sessionId)
      assert.equal(after.state.sessionFile, before.state.sessionFile)
      assert.equal(after.state.model.provider, VISION_PROVIDER)
      assert.equal(after.state.model.id, VISION_MODEL)
      assert.equal(after.state.thinkingLevel, before.state.thinkingLevel)
      assert.deepEqual(messageHistory(afterMessages), messageHistory(beforeMessages))
      const restoredFile = await readFile(before.state.sessionFile)
      assert.deepEqual(restoredFile.subarray(0, savedFile.length), savedFile)
      assert.deepEqual(after.info.runtime, {
        version: selected.version,
        selectedVersion: selected.version
      })
      assert.equal(await application.page.locator('[data-engine-upgrade]').count(), 0)
      await assertSelectedMetadata(application, agentId, VISION_PROVIDER, VISION_MODEL)
    })
    const upgradedProbe = await captureImageProbe(
      application,
      fixture.primeServer,
      agentId,
      'upgraded-vision-image',
      imagePath
    )
    report.observations.upgradedProbe = upgradedProbe
    await check(
      'explicit upgrade refreshes native prompt and model.info and sends image bytes',
      async () => {
        assertVisionProbe(upgradedProbe, 'upgraded-vision-image')
        assert.ok(JSON.stringify(upgradedProbe.providerInput).includes(HISTORY_ANSWER))
        await pasteImage(application, 'resident-after-restart.png')
        assert.equal(await application.page.getByText(/can.t read images/).count(), 0)
        await application.page
          .getByRole('button', { name: 'Remove resident-after-restart.png' })
          .click()
      }
    )
    assert.equal(await executableHash(baseline.executablePath), baseline.sha256)
    assert.equal(await executableHash(selected.executablePath), selected.sha256)
    application.assertNoErrors()
    const failed = report.checks.filter((entry) => !entry.passed)
    if (failed.length) throw new Error(`${failed.length} older resident upgrade checks failed`)
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
  if (failure) throw failure
  console.log(`✓ Native resident upgrade: ${report.checks.length} checks passed`)
}

await main().catch((error) => {
  console.error(error.stack ?? error)
  process.exitCode = 1
})
