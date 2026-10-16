// Resume after an app restart: one session set up through the UI (model, thinking level, name, two turns),
// the app quits, then relaunches on the SAME profile and engine dir. The session must come back with its
// transcript, model, thinking level and name, and the next request must carry the old context.
//
//   node scripts/qa/sessions/restart.qa.mjs
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createAgentDir, FAKE_MODELS } from '../lib/agent-dir.mjs'
import { launchApp } from '../lib/app.mjs'
import { inspectRequest, startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { createChecks, sendWhenSettled, SHOTS_DIR, waitUntil } from './lib/checks.mjs'
import { keepProfileAcrossLaunches } from './lib/kept-profile.mjs'
import {
  assertValidSession,
  listJsonl,
  sessionName,
  userTexts,
  workspaceSessionDir
} from './lib/session-files.mjs'

const NAME = 'Walrus resume check'

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

console.log('▶ sessions-restart (fake)')
const profile = keepProfileAcrossLaunches()
const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })
let app = null
const { check, finish } = createChecks(step, () => app, 'restart')
let failed = null

try {
  const page = () => app.page
  let cwd
  let sessionFile
  let before

  app = await launchApp({ agentDir: agentDir.dir, outDir: SHOTS_DIR })
  // A workspace that outlives the first app (the harness deletes its own workspaces on close).
  cwd = agentDir.path('../workspace-restart')
  await agentDir.writeText('../workspace-restart/README.md', '# Restart workspace\n')
  await step('first launch: open a workspace', () => app.openWorkspace({ cwd }))

  await step('first launch: pick QA OpenAI and thinking High in the composer', async () => {
    await page()
      .getByRole('button', { name: /^Model:/ })
      .click()
    await page()
      .getByRole('option', { name: /QA OpenAI/ })
      .click()
    await waitUntil(
      async () => (await app.rpc({ type: 'get_state' })).model?.id === FAKE_MODELS.openai,
      { label: 'model set' }
    )
    await page()
      .getByRole('button', { name: /^Thinking level:/ })
      .click()
    await page().getByRole('menuitemradio', { name: /^High/ }).click()
    await waitUntil(async () => (await app.rpc({ type: 'get_state' })).thinkingLevel === 'high', {
      label: 'thinking set'
    })
  })

  await step('first launch: two turns and a name', async () => {
    server.queue(turn.text('Noted: the secret word is walrus.'))
    await sendWhenSettled(app, 'Remember the secret word walrus')
    await app.waitForSettle()
    server.queue(turn.text('Second answer before the restart.'))
    await sendWhenSettled(app, 'Second message before restart')
    await app.waitForSettle()
    await page().getByRole('button', { name: 'Rename session' }).click()
    const input = page().getByRole('textbox', { name: 'Session name' })
    await input.fill(NAME)
    await input.press('Enter')
    await waitUntil(async () => (await app.rpc({ type: 'get_state' })).sessionName === NAME, {
      label: 'named'
    })
    before = await app.rpc({ type: 'get_state' })
    sessionFile = before.sessionFile
    const session = await assertValidSession(sessionFile)
    assert.equal(sessionName(session), NAME)
    await app.screenshot('restart-before', { settleMs: 300 })
  })

  await step('quit the app', async () => {
    await app.close()
    app = null
  })

  app = await launchApp({ agentDir: agentDir.dir, outDir: SHOTS_DIR })

  await check('relaunch restores the profile: workspace is still the active one', async () => {
    const { prefs } = await app.appState()
    assert.equal(prefs.activeWorkspace?.toLowerCase(), cwd.toLowerCase())
    assert.ok(prefs.workspaces.some((w) => w.path.toLowerCase() === cwd.toLowerCase()))
  })

  // SPEC §2.3 persists "open tabs": the session in front resumes on relaunch.
  await check(
    'relaunch reopens the session that was open when the app quit (SPEC §2.3 open tabs)',
    async () => {
      await page().waitForTimeout(1500)
      const engines = await app.invoke('engine:list')
      const { prefs } = await app.appState()
      await app.screenshot('restart-after-relaunch', { settleMs: 300 })
      assert.ok(
        engines.some((engine) => engine.sessionFile?.toLowerCase() === sessionFile.toLowerCase()),
        `no engine on the previous session after relaunch (prefs keys: ${Object.keys(prefs).join(', ')})`
      )
    }
  )

  await check('the session is listed in the sidebar under its name', async () => {
    await page().locator('[data-session-row]', { hasText: NAME }).waitFor({ timeout: 15_000 })
  })

  await check('opening it restores transcript, model, thinking level and name', async () => {
    const open = await app.invoke('engine:list')
    if (!open.some((engine) => engine.sessionFile?.toLowerCase() === sessionFile.toLowerCase())) {
      await page().locator('[data-session-row]', { hasText: NAME }).click()
    }
    await page().getByText('Noted: the secret word is walrus.').waitFor({ timeout: 30_000 })
    await page().getByText('Second answer before the restart.').waitFor()
    const state = await app.rpc({ type: 'get_state' })
    assert.equal(state.sessionFile.toLowerCase(), sessionFile.toLowerCase())
    assert.equal(state.model?.id, FAKE_MODELS.openai)
    assert.equal(state.thinkingLevel, 'high')
    assert.equal(state.sessionName, NAME)
    assert.equal(state.messageCount, before.messageCount)
    await page().getByRole('button', { name: 'Model: QA OpenAI' }).waitFor()
    await page().getByRole('button', { name: 'Thinking level: High' }).waitFor()
    assert.equal(await page().getByRole('button', { name: 'Rename session' }).innerText(), NAME)
    await app.screenshot('restart-resumed', { settleMs: 300 })
  })

  await check(
    'the next request goes to QA OpenAI at high effort with the old turns as context',
    async () => {
      const from = server.requests.length
      server.queue(turn.text('The word was walrus.'))
      await sendWhenSettled(app, 'What was the secret word?')
      await app.waitForSettle()
      const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
      assert.equal(sent.model, FAKE_MODELS.openai)
      assert.equal(sent.reasoningEffort, 'high')
      const texts = sent.messages.map((m) => m.text)
      assert.ok(texts.includes('Remember the secret word walrus'), JSON.stringify(texts))
      assert.ok(texts.includes('Noted: the secret word is walrus.'))
      assert.equal(sent.lastUserText, 'What was the secret word?')
      const session = await assertValidSession(sessionFile)
      assert.deepEqual(userTexts(session), [
        'Remember the secret word walrus',
        'Second message before restart',
        'What was the secret word?'
      ])
    }
  )

  const openSection = () => page().locator('section[aria-label="Open sessions"]')
  const sessionsDir = workspaceSessionDir(agentDir, cwd)
  let filesBefore
  await step('open two more sessions, then bring the first one back to the front', async () => {
    for (const word of ['heron', 'otter']) {
      const previous = await app.activeAgentId()
      await page().getByRole('button', { name: 'New session', exact: true }).first().click()
      await waitUntil(
        async () => {
          const id = await app.activeAgentId()
          const state = id && id !== previous ? await app.agentState(id) : null
          return state?.status === 'ready' && state.session
        },
        { label: `${word} session ready`, timeoutMs: 60_000 }
      )
      server.queue(turn.text(`Noted: ${word}.`))
      await sendWhenSettled(app, `Remember the ${word}`)
      await app.waitForSettle()
    }
    await openSection().locator('[data-session-row]', { hasText: NAME }).click()
    await page().getByText('The word was walrus.').waitFor()
    filesBefore = await waitUntil(
      async () => {
        const files = await listJsonl(sessionsDir)
        return files.length === 3 ? files : null
      },
      { label: `three session files in ${sessionsDir}` }
    )
    await page().waitForTimeout(500)
    await app.close()
    app = null
  })

  app = await launchApp({ agentDir: agentDir.dir, outDir: SHOTS_DIR })

  await check('relaunch with three open sessions: only the one in front starts an engine', async () => {
    await waitUntil(async () => (await app.invoke('engine:list')).length === 1, {
      label: 'one engine',
      timeoutMs: 60_000
    })
    await page().waitForTimeout(1500)
    const engines = await app.invoke('engine:list')
    assert.equal(engines.length, 1, 'one engine after the relaunch')
    assert.equal(engines[0].sessionFile?.toLowerCase(), sessionFile.toLowerCase())
    await openSection().locator('[data-session-row]', { hasText: 'Remember the heron' }).waitFor()
    await openSection().locator('[data-session-row]', { hasText: 'Remember the otter' }).waitFor()
    assert.equal(await openSection().locator('[data-session-row]').count(), 3)
    await app.screenshot('restart-dormant-rows', { settleMs: 300 })
  })

  await check('clicking a dormant row resumes it with its transcript; no extra session', async () => {
    await openSection().locator('[data-session-row]', { hasText: 'Remember the otter' }).click()
    await page().getByText('Noted: otter.').waitFor({ timeout: 60_000 })
    const engines = await app.invoke('engine:list')
    assert.equal(engines.length, 2)
    const known = filesBefore.map((file) => file.toLowerCase())
    assert.ok(engines.every((engine) => known.includes(engine.sessionFile?.toLowerCase())))
    assert.equal(await openSection().locator('[data-session-row]').count(), 3)
    assert.deepEqual(await listJsonl(sessionsDir), filesBefore, 'no new session file')
    await app.screenshot('restart-dormant-resumed', { settleMs: 300 })
  })

  finish()
} catch (error) {
  failed = error
  await app?.screenshot('restart-FAILED', { settleMs: 0 }).catch(() => undefined)
} finally {
  await app?.close().catch((error) => (failed ??= error))
  await server.close()
  await agentDir.cleanup()
  profile.release()
}
if (failed) {
  console.error(`  ✗ ${failed.stack ?? failed}`)
  console.error('✗ sessions-restart failed')
  process.exitCode = 1
} else {
  console.log('✓ sessions-restart passed')
}
