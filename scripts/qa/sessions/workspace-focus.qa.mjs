// Workspace focus: in a workspace the sidebar lists only that workspace's open sessions; "All workspaces" lists every
// one with its workspace. Work elsewhere stays reachable (titlebar pill, switcher badge, palette) and bringing a session
// to the front brings its workspace with it. The switcher holds still while agents write their session files (a
// background workspace re-scan never flips it to loading), yet a new workspace still shows up. Closing a workspace's
// last session stays in that workspace.
//
//   node scripts/qa/sessions/workspace-focus.qa.mjs
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { createChecks, sendWhenSettled, sleep, waitUntil } from './lib/checks.mjs'
import { SessionBuilder, workspaceSessionDir } from './lib/session-files.mjs'

const SLOW = `${'Bravo streaming chunk. '.repeat(70)}End of bravo.`
const forPrompt = (text) => (request) => inspectRequest(request).lastUserText === text

await runSuite('sessions-workspace-focus', async ({ server, agentDir, app, step }) => {
  const { check, finish } = createChecks(step, () => app, 'workspace-focus')
  const page = app.page
  const openRows = () => page.locator('section[aria-label="Open sessions"] [data-session-row]')
  const openRow = (text) => openRows().filter({ hasText: text })
  const activeWorkspace = async () => (await app.appState()).prefs.activeWorkspace
  const switcher = () => page.getByRole('button', { name: 'Switch workspace' })
  async function switchTo(cwd) {
    await switcher().click()
    await page
      .locator('[data-workspace-choice]', { hasText: basename(cwd) })
      .first()
      .click()
    await waitUntil(async () => (await activeWorkspace()) === cwd, {
      label: `workspace ${basename(cwd)}`
    })
    await page.waitForTimeout(300)
  }

  const a = await step('open workspace A with a session', () =>
    app.openWorkspace({ files: { 'README.md': '# A\n' } })
  )
  server.queue(turn.text('ready a'))
  await sendWhenSettled(app, 'hello from A')
  await app.waitForSettle()
  const b = await step('open workspace B with a session', async () => {
    const cwd = await app.createWorkspace({ 'README.md': '# B\n' })
    return { agentId: await app.test('openWorkspace', cwd, {}), cwd }
  })
  server.queue(turn.text('ready b'))
  await sendWhenSettled(app, 'hello from B')
  await app.waitForSettle()

  await check('in workspace B the Open list holds only B’s session', async () => {
    await openRow('hello from B').waitFor()
    await waitUntil(async () => (await openRows().count()) === 1, {
      label: 'one open row',
      timeoutMs: 3000
    })
    assert.equal(await openRow('hello from A').count(), 0, 'A’s session is not listed in B')
    await app.screenshot('workspace-focus-open-list', { settleMs: 200 })
  })

  await check('All workspaces lists every open session with its workspace', async () => {
    await switcher().click()
    await page.getByRole('button', { name: 'All workspaces' }).click()
    await openRow('hello from A').waitFor()
    assert.equal(await openRows().count(), 2)
    assert.match(await openRow('hello from A').innerText(), new RegExp(basename(a.cwd)))
    await switchTo(b.cwd)
    await waitUntil(async () => (await openRows().count()) === 1, {
      label: 'back to one row',
      timeoutMs: 3000
    })
  })

  await check(
    'work in another workspace stays reachable and brings its workspace along',
    async () => {
      server.queue({
        ...turn.text(SLOW, { chunkSize: 4, delayMs: 30 }),
        when: forPrompt('stream bravo')
      })
      await sendWhenSettled(app, 'stream bravo')
      await switchTo(a.cwd)
      assert.equal(await openRow('hello from B').count(), 0, 'B is not listed in A')
      await switcher().click()
      await page
        .locator('[data-workspace-choice]', { hasText: basename(b.cwd) })
        .first()
        .waitFor()
      await page.getByLabel('1 working').first().waitFor()
      await app.screenshot('workspace-focus-switcher-badge', { settleMs: 200 })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '1 working' }).click()
      await waitUntil(async () => (await app.activeAgentId()) === b.agentId, { label: 'B active' })
      assert.equal(await activeWorkspace(), b.cwd, 'the workspace followed the session')
      await openRow('hello from B').waitFor()
      await app.waitForSettle({ timeoutMs: 30_000 })
    }
  )

  await check(
    'the palette switches to a session in another workspace, workspace included',
    async () => {
      await app.test('setPalette', true)
      await page
        .getByRole('option', { name: /hello from A/ })
        .first()
        .click()
      await waitUntil(async () => (await app.activeAgentId()) === a.agentId, { label: 'A active' })
      await waitUntil(async () => (await activeWorkspace()) === a.cwd, {
        label: 'workspace A',
        timeoutMs: 3000
      })
      await openRow('hello from A').waitFor()
      assert.equal(await openRow('hello from B').count(), 0)
    }
  )

  await check('the workspace switcher holds still while session files are written', async () => {
    await switcher().click()
    await page.locator('[data-workspace-list]').waitFor()
    await page.evaluate(() => {
      const list = document.querySelector('[data-workspace-list]')
      const panel = list.parentElement
      const flips = { busy: 0, hint: 0 }
      window.__qaSwitcherFlips = flips
      new MutationObserver(() => flips.busy++).observe(list, {
        attributes: true,
        attributeFilter: ['aria-busy']
      })
      new MutationObserver(() => {
        if (panel.textContent.includes('Checking saved workspaces')) flips.hint++
      }).observe(panel, { childList: true, subtree: true, characterData: true })
    })
    // A session that keeps growing, like an agent at work (the watcher debounces 350 ms).
    const fixture = new SessionBuilder({ cwd: a.cwd })
    fixture.modelChange()
    const dir = workspaceSessionDir(agentDir, a.cwd)
    for (let i = 0; i < 12; i++) {
      fixture.user(`growing fixture ${i}`)
      await fixture.write(dir)
      await sleep(500)
    }
    await sleep(800)
    const flips = await page.evaluate(() => window.__qaSwitcherFlips)
    await page.keyboard.press('Escape')
    assert.deepEqual(flips, { busy: 0, hint: 0 }, 'no loading state while sessions are written')
  })

  await check('a session in a new folder still adds that workspace', async () => {
    const fresh = await app.createWorkspace({ 'README.md': '# C\n' })
    const session = new SessionBuilder({ cwd: fresh })
    session.modelChange()
    session.user('from the terminal')
    await session.write(workspaceSessionDir(agentDir, fresh))
    await waitUntil(
      async () =>
        (await app.appState()).prefs.workspaces.some(
          (w) => w.path.toLowerCase() === fresh.toLowerCase()
        ),
      { label: 'the new workspace is discovered', timeoutMs: 30_000 }
    )
  })

  await check('closing a workspace’s last session stays in that workspace', async () => {
    await openRow('hello from A').hover()
    await openRow('hello from A')
      .locator('xpath=..')
      .getByRole('button', { name: 'Close tab' })
      .click()
    await page.getByText('No session open').waitFor()
    assert.equal(await activeWorkspace(), a.cwd, 'still in workspace A')
    assert.equal(await app.activeAgentId(), null)
    assert.equal(await openRows().count(), 0)
    const engines = await app.invoke('engine:list')
    assert.ok(
      engines.some((engine) => engine.agentId === b.agentId),
      'B keeps running'
    )
    await app.screenshot('workspace-focus-closed-last', { settleMs: 200 })
  })

  finish()
})
