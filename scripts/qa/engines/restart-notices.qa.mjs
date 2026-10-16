import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, ROOT } from '../lib/app.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { isAlive } from '../lib/processes.mjs'
import { dismissToasts, pickModel, waitFor } from '../settings/settings-ui.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const OBSERVE = process.argv.includes('--observe')
const REPORT_NAME = process.env.QA_UX_REPORT ?? (OBSERVE ? 'baseline' : 'regression')
const OUTPUT_DIRECTORY = join(ROOT, '.shots', 'qa', 'engine-ux', REPORT_NAME)
const WATCHER_SETTLE_MS = 2000
const STREAM_DELAY_MS = 35
const STREAM_CHUNK_SIZE = 1
const RAPID_CYCLES = 4
const THINKING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}
const OAUTH_PROVIDER = 'qa-oauth-refresh'
const OAUTH_EXPIRY_MS = 60_000
const fixture = await createEngineFixture()
const report = { mode: REPORT_NAME, startedAt: new Date().toISOString(), engines: [], checks: [] }
let application
let failure

async function recordPublicEvents() {
  await application.page.evaluate(() => {
    const recording = { changes: [], notices: [] }
    window.__engineUxRecording = recording
    const unsubscribe = window.vengeance.on('settings:changed', (event) => {
      recording.changes.push({ at: Date.now(), ...event })
    })
    const captureNotices = () => {
      for (const element of document.querySelectorAll('[role=status],[role=alert]')) {
        const text = element.textContent ?? ''
        if (!/Restart|Could not|failed|not saved/i.test(text)) continue
        if (recording.notices.at(-1)?.text === text) continue
        recording.notices.push({ at: Date.now(), text })
      }
    }
    const observer = new MutationObserver(captureNotices)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    window.__engineUxStopRecording = () => {
      unsubscribe()
      observer.disconnect()
    }
    captureNotices()
  })
}

async function clearRecording() {
  await dismissToasts(application)
  await application.page.evaluate(() => {
    window.__engineUxRecording.changes.length = 0
    window.__engineUxRecording.notices.length = 0
  })
}

async function engineIdentity(agentId) {
  const descriptor = (await application.invoke('engine:list')).find(
    (entry) => entry.agentId === agentId
  )
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.ok(descriptor?.pid && isAlive(descriptor.pid), 'native worker is alive')
  const settingsDirectory =
    descriptor.engine === 'prime' ? fixture.primeDirectory : fixture.piDirectory.dir
  return {
    pid: descriptor.pid,
    nativeAgentId: descriptor.nativeAgentId,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
    model: state.model?.id,
    thinkingLevel: state.thinkingLevel,
    messageCount: state.messageCount,
    settings: JSON.parse(await readFile(join(settingsDirectory, 'settings.json'), 'utf8'))
  }
}

async function check(label, agentId, action, { requiresRestart = false } = {}) {
  console.log(`  • ${label}`)
  await clearRecording()
  const before = await engineIdentity(agentId)
  let actionError
  try {
    await action()
  } catch (error) {
    actionError = error
    await application.page.keyboard.press('Escape')
  }
  await application.page.waitForTimeout(WATCHER_SETTLE_MS)
  const after = await engineIdentity(agentId)
  const recording = await application.page.evaluate(() => window.__engineUxRecording)
  const restartNotices = recording.notices.filter((notice) => /Restart to apply/.test(notice.text))
  const passed =
    !actionError &&
    !recording.notices.some((notice) => /Could not|failed|not saved/i.test(notice.text)) &&
    before.pid === after.pid &&
    before.nativeAgentId === after.nativeAgentId &&
    before.sessionId === after.sessionId &&
    (requiresRestart ? restartNotices.length > 0 : restartNotices.length === 0)
  const screenshot = await application.screenshot(`${report.checks.length + 1}-${label}`)
  report.checks.push({
    label,
    passed,
    requiresRestart,
    error: actionError?.stack,
    before,
    after,
    ...recording,
    screenshot
  })
  console.log(
    `    ${passed ? '✓' : '✗'} pid ${before.pid} → ${after.pid}; notices ${restartNotices.length}`
  )
  if (!OBSERVE) {
    assert.ok(passed, `${label}: ${actionError?.message ?? JSON.stringify(recording)}`)
  }
}

async function selectThinking(agentId, level) {
  await application.page.getByRole('button', { name: /^Thinking level:/ }).click()
  await application.page
    .getByRole('menuitemradio', { name: new RegExp(`^${THINKING_LABELS[level]}\\b`) })
    .click()
  await waitFor(
    async () => (await application.rpc({ type: 'get_state' }, agentId)).thinkingLevel === level,
    `thinking level ${level}`
  )
}

async function selectModel(agentId, model, label) {
  const trigger = application.page.getByRole('button', { name: /^Model:/ })
  await pickModel(application, trigger, label)
  await waitFor(
    async () => (await application.rpc({ type: 'get_state' }, agentId)).model?.id === model,
    `model ${model}`
  )
}

async function sendAndCheckRequest(server, agentId, prompt, model, thinking) {
  const from = server.requests.length
  server.queue(turn.text('Local answer completed.'))
  await application.send(prompt)
  await application.waitForSettle()
  const request = await server.waitForRequest(undefined, { from })
  assert.equal(await server.waitForOutcome(request), 'completed')
  assert.equal(inspectRequest(request).model, model)
  const inspected = inspectRequest(request)
  if (request.api === 'anthropic-messages') {
    assert.equal(inspected.thinking?.type, 'enabled')
  } else {
    assert.equal(inspected.reasoningEffort, thinking)
  }
  const state = await application.rpc({ type: 'get_state' }, agentId)
  assert.equal(state.thinkingLevel, thinking)
}

async function runEngine(engine, workspace) {
  const prime = engine === 'prime'
  const provider = prime ? PRIME_PROVIDER : FAKE_PROVIDER
  const server = prime ? fixture.primeServer : fixture.piServer
  const firstModel = prime ? PRIME_MODELS.reasoning : FAKE_MODELS.reasoning
  const secondModel = prime ? PRIME_MODELS.small : FAKE_MODELS.openai
  const firstLabel = prime ? 'Engine2 QA Reasoning' : 'QA Reasoning'
  const secondLabel = prime ? 'Engine2 QA Small' : 'QA OpenAI'
  const opened = await application.openWorkspace({
    cwd: workspace,
    args: {
      engine,
      model: `${provider}/${firstModel}`,
      thinking: 'off',
      name: `${prime ? 'Engine 2' : 'Engine'} UX probe`
    }
  })
  const agentId = opened.agentId
  await waitFor(async () => (await application.agentState(agentId))?.status === 'ready', 'ready')
  await application.page.waitForTimeout(WATCHER_SETTLE_MS)
  report.engines.push({ engine, describe: await application.invoke('engine:describe', engine) })

  await check(`${engine}-idle-reasoning`, agentId, () => selectThinking(agentId, 'low'))
  await check(`${engine}-idle-model`, agentId, () => selectModel(agentId, secondModel, secondLabel))
  await check(`${engine}-answer-after-controls`, agentId, () =>
    sendAndCheckRequest(server, agentId, 'Reply briefly.', secondModel, 'low')
  )

  await check(`${engine}-reasoning-during-stream`, agentId, async () => {
    const from = server.requests.length
    server.queue(
      turn.text('A slow local stream confirms the controls remain usable during an answer.', {
        chunkSize: STREAM_CHUNK_SIZE,
        delayMs: STREAM_DELAY_MS
      })
    )
    await application.send('Stream a short answer.')
    const request = await server.waitForRequest(undefined, { from })
    await selectThinking(agentId, 'medium')
    assert.equal(await server.waitForOutcome(request), 'completed')
    await application.waitForSettle()
  })
  await check(`${engine}-model-during-stream`, agentId, async () => {
    const from = server.requests.length
    server.queue(
      turn.text('A second slow stream confirms model switching does not discard the answer.', {
        chunkSize: STREAM_CHUNK_SIZE,
        delayMs: STREAM_DELAY_MS
      })
    )
    await application.send('Stream another short answer.')
    const request = await server.waitForRequest(undefined, { from })
    await selectModel(agentId, firstModel, firstLabel)
    assert.equal(await server.waitForOutcome(request), 'completed')
    await application.waitForSettle()
  })
  await check(`${engine}-reasoning-after-answer`, agentId, () => selectThinking(agentId, 'high'))
  await check(`${engine}-next-answer-keeps-controls`, agentId, () =>
    sendAndCheckRequest(server, agentId, 'Reply once more.', firstModel, 'high')
  )
  await check(`${engine}-prompt-immediately-after-model`, agentId, async () => {
    const trigger = application.page.getByRole('button', { name: /^Model:/ })
    await pickModel(application, trigger, secondLabel)
    await sendAndCheckRequest(server, agentId, 'Reply after choosing a model.', secondModel, 'high')
    await selectModel(agentId, firstModel, firstLabel)
  })
  await check(`${engine}-allowed-levels-after-answer`, agentId, async () => {
    const available = await application.rpc({ type: 'get_available_thinking_levels' }, agentId)
    await application.page.getByRole('button', { name: /^Thinking level:/ }).click()
    const levels = await application.page.getByRole('menuitemradio').allTextContents()
    assert.equal(levels.length, available.levels.length)
    for (const level of available.levels) {
      const expected = THINKING_LABELS[level]
      assert.ok(expected, `native thinking level ${level} has a label`)
      assert.ok(levels.some((text) => text.startsWith(expected)))
    }
    await application.page.keyboard.press('Escape')
  })
  await check(`${engine}-rapid-thinking-cycles`, agentId, async () => {
    const before = await application.rpc({ type: 'get_state' }, agentId)
    const available = await application.rpc({ type: 'get_available_thinking_levels' }, agentId)
    const composer = await application.composer()
    await composer.focus()
    for (let index = 0; index < RAPID_CYCLES; index++) {
      await application.page.keyboard.press('Shift+Tab')
    }
    const expected =
      available.levels[
        (available.levels.indexOf(before.thinkingLevel) + RAPID_CYCLES) % available.levels.length
      ]
    await waitFor(
      async () =>
        (await application.rpc({ type: 'get_state' }, agentId)).thinkingLevel === expected,
      'rapid cycles reach their native final state'
    )
    await waitFor(
      async () => (await application.agentState(agentId)).thinkingLevel === expected,
      'renderer agrees with native final thinking level'
    )
  })

  const directory = prime ? fixture.primeDirectory : fixture.piDirectory.dir
  await check(`${engine}-identical-settings-rewrite`, agentId, async () => {
    const path = join(directory, 'settings.json')
    await writeFile(path, await readFile(path, 'utf8'), 'utf8')
  })
  if (prime) {
    await check('prime-recent-models-only', agentId, async () => {
      const path = join(directory, 'settings.json')
      const settings = JSON.parse(await readFile(path, 'utf8'))
      settings.recentModels = [`${provider}/${secondModel}`, `${provider}/${firstModel}`]
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    })
  }
  await check(
    `${engine}-external-startup-setting`,
    agentId,
    async () => {
      const path = join(directory, 'settings.json')
      const settings = JSON.parse(await readFile(path, 'utf8'))
      settings.shellCommandPrefix = 'echo isolated-startup-probe'
      await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    },
    { requiresRestart: true }
  )
  await checkAuthChanges(engine, agentId, directory)
}

async function checkAuthChanges(engine, agentId, directory) {
  const path = join(directory, 'auth.json')
  const credentials = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'))
  const writeCredentials = () => writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`)
  await check(
    `${engine}-oauth-provider-add`,
    agentId,
    async () => {
      credentials[OAUTH_PROVIDER] = {
        type: 'oauth',
        access: 'qa-access-first',
        refresh: 'qa-refresh-first',
        expires: Date.now() + OAUTH_EXPIRY_MS
      }
      await writeCredentials()
    },
    { requiresRestart: true }
  )
  await check(`${engine}-oauth-token-refresh`, agentId, async () => {
    credentials[OAUTH_PROVIDER] = {
      ...credentials[OAUTH_PROVIDER],
      access: 'qa-access-refreshed',
      refresh: 'qa-refresh-refreshed',
      expires: Date.now() + OAUTH_EXPIRY_MS
    }
    await writeCredentials()
  })
  await check(
    `${engine}-oauth-provider-remove`,
    agentId,
    async () => {
      delete credentials[OAUTH_PROVIDER]
      await writeCredentials()
    },
    { requiresRestart: true }
  )
}

try {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  await recordPublicEvents()
  const workspace = await fixture.root.folder('workspace', { 'README.md': '# Isolated UX QA\n' })
  await runEngine('pi', workspace)
  await runEngine('prime', workspace)
  application.assertNoErrors()
} catch (error) {
  failure = error
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await application?.page.evaluate(() => window.__engineUxStopRecording?.()).catch(() => undefined)
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
  const failed = report.checks.filter((entry) => !entry.passed).length
  console.log(`✓ ${REPORT_NAME}: ${report.checks.length} checks, ${failed} observed regressions`)
}
