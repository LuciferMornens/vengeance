// Several agents at once: two workspaces stream against the fake LLM at the same time; switching between them
// keeps each transcript; the background one shows as working in the titlebar and "Finished" in the sidebar;
// each file gets only its own turns. Then the "All workspaces" list groups history by workspace. A workspace lists only
// its own open sessions (sessions/workspace-focus.qa.mjs), so juggling both runs under All workspaces.
//
//   node scripts/qa/sessions/concurrency.qa.mjs
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { createChecks, sendWhenSettled, SHOTS_DIR, waitUntil } from './lib/checks.mjs'
import { assertValidSession, messageText, userTexts } from './lib/session-files.mjs'

const long = (word) => `${`${word} streaming chunk. `.repeat(22)}End of ${word}.`
const ALPHA = long('Alpha')
const BRAVO = long('Bravo')
const forPrompt = (text) => (request) => inspectRequest(request).lastUserText === text

await runSuite(
  'sessions-concurrency',
  async ({ server, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'concurrency')
    const page = app.page
    const row = (text) =>
      page
        .locator('section[aria-label="Open sessions"] [data-session-row]', { hasText: text })
        .first()
    const assistantText = async (agentId) =>
      (await app.agentState(agentId)).entries
        .filter((e) => e.message.role === 'assistant')
        .map((e) => e.message.content.map((c) => (c.type === 'text' ? c.text : '')).join(''))
        .join('\n')

    const a = await step('open workspace A', () =>
      app.openWorkspace({ files: { 'README.md': '# A\n' } })
    )
    server.queue(turn.text('ready a'))
    await sendWhenSettled(app, 'hello from A')
    await app.waitForSettle()
    // The harness openWorkspace() waits on an ambiguous composer locator while the old pane fades out.
    const b = await step('open workspace B', async () => {
      const cwd = await app.createWorkspace({ 'README.md': '# B\n' })
      return { agentId: await app.test('openWorkspace', cwd, {}), cwd }
    })
    server.queue(turn.text('ready b'))
    await sendWhenSettled(app, 'hello from B')
    await app.waitForSettle()
    await step('list every workspace’s open sessions (All workspaces)', async () => {
      await page.getByRole('button', { name: 'Switch workspace' }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /All workspaces/ })
        .click()
      await row('hello from A').waitFor()
    })

    await check('both workspaces stream at the same time', async () => {
      server.queue(
        { ...turn.text(BRAVO, { chunkSize: 4, delayMs: 30 }), when: forPrompt('stream bravo') },
        { ...turn.text(ALPHA, { chunkSize: 4, delayMs: 30 }), when: forPrompt('stream alpha') }
      )
      await sendWhenSettled(app, 'stream bravo')
      await row('hello from A').click()
      await waitUntil(async () => (await app.activeAgentId()) === a.agentId, { label: 'A active' })
      assert.equal(
        (await app.appState()).prefs.activeWorkspace,
        a.cwd,
        'activating A switches the workspace too'
      )
      await sendWhenSettled(app, 'stream alpha')
      await waitUntil(() => server.requests.filter((r) => r.outcome === 'streaming').length === 2, {
        label: 'two requests streaming at once',
        timeoutMs: 5000,
        intervalMs: 20
      })
      await page.getByRole('button', { name: '1 working' }).waitFor()
      await app.screenshot('concurrency-both-streaming', { settleMs: 100 })
    })

    await check('switching mid-stream keeps each agent streaming its own text', async () => {
      await row('hello from B').click()
      await waitUntil(async () => (await app.activeAgentId()) === b.agentId, { label: 'B active' })
      await page.waitForTimeout(300)
      await row('hello from A').click()
      await waitUntil(async () => (await app.activeAgentId()) === a.agentId, {
        label: 'A active again'
      })
      await app.waitForSettle()
      await waitUntil(async () => (await app.agentState(b.agentId)).phase === 'idle', {
        label: 'B idle',
        timeoutMs: 30_000
      })
      assert.ok((await assistantText(a.agentId)).includes('End of Alpha.'))
      assert.ok(!(await assistantText(a.agentId)).includes('Bravo'))
      assert.ok((await assistantText(b.agentId)).includes('End of Bravo.'))
      assert.ok(!(await assistantText(b.agentId)).includes('Alpha'))
    })

    await check(
      'the agent that finished in the background reads "Finished" until opened',
      async () => {
        await row('hello from B').filter({ hasText: 'Finished' }).waitFor({ timeout: 10_000 })
        assert.match(await row('hello from A').innerText(), /messages/)
        await app.screenshot('concurrency-background-finished', { settleMs: 200 })
        await row('hello from B').click()
        await waitUntil(async () => !/Finished/.test(await row('hello from B').innerText()), {
          label: 'unread cleared'
        })
        await page.locator('[data-session-pane]').getByText('End of Bravo.').waitFor()
      }
    )

    await check('each session file holds only its own turns', async () => {
      const fileA = (await app.rpc({ type: 'get_state' }, a.agentId)).sessionFile
      const fileB = (await app.rpc({ type: 'get_state' }, b.agentId)).sessionFile
      const sessionA = await assertValidSession(fileA)
      const sessionB = await assertValidSession(fileB)
      assert.deepEqual(userTexts(sessionA), ['hello from A', 'stream alpha'])
      assert.deepEqual(userTexts(sessionB), ['hello from B', 'stream bravo'])
      assert.equal(sessionA.header.cwd, a.cwd)
      assert.equal(sessionB.header.cwd, b.cwd)
      const lastB = sessionB.entries
        .filter((e) => e.type === 'message' && e.message.role === 'assistant')
        .at(-1)
      assert.equal(messageText(lastB.message), BRAVO)
    })

    await check('"All workspaces" groups closed sessions by workspace', async () => {
      for (const title of ['hello from A', 'hello from B']) {
        await row(title).hover()
        await row(title).locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
        await waitUntil(async () => (await row(title).count()) === 0, { label: `${title} closed` })
      }
      // Back to workspace B (the last one in front): its history lists the closed session.
      assert.equal((await app.appState()).prefs.activeWorkspace, b.cwd)
      await page.getByRole('button', { name: 'Switch workspace' }).click()
      await page
        .locator('[data-workspace-choice]', { hasText: b.cwd.split(/[\/]/).pop() })
        .first()
        .click()
      await page.locator('section[aria-label="Today"]').getByText('hello from B').waitFor()
      await app.screenshot('concurrency-closed-workspace-list', { settleMs: 200 })
      await page.getByRole('button', { name: 'Switch workspace' }).click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /All workspaces/ })
        .click()
      const groups = page.locator('section[aria-label="Sessions by workspace"]')
      await groups.waitFor()
      const text = await groups.innerText()
      for (const cwd of [a.cwd, b.cwd])
        assert.ok(text.includes(cwd.split(/[\\/]/).pop()), `group for ${cwd}`)
      await groups.getByText('hello from A').waitFor()
      await groups.getByText('hello from B').waitFor()
      await app.screenshot('concurrency-all-workspaces', { settleMs: 300 })
      assert.equal((await app.appState()).prefs.features.sessions.scope, 'all')
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
