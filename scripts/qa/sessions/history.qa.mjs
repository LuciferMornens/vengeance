// How history that the context no longer carries stays reachable: a compacted session (manual /compact with
// instructions against the fake LLM) in the transcript, after a reopen, and through the tree (going back to a
// pre-compaction point restores the original messages as context); and subagent child sessions written like
// pi-subagents writes them (named `subagent-<agent>-<run id>-<n>`, `parentSession` header, nested run folder).
//
//   node scripts/qa/sessions/history.qa.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { FAKE_MODELS } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  createChecks,
  openBranchesTab,
  runComposerCommand,
  sendWhenSettled,
  SHOTS_DIR,
  waitUntil
} from './lib/checks.mjs'
import {
  assertValidSession,
  messageText,
  SessionBuilder,
  workspaceSessionDir
} from './lib/session-files.mjs'

const SUMMARY = 'QA COMPACTION SUMMARY: the user asked about quince jam.'
const isSummaryRequest = (request) =>
  inspectRequest(request).lastUserText.includes('<conversation>')

await runSuite(
  'sessions-history',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'history')
    const page = app.page
    const pane = () => page.locator('[data-session-pane]')
    // The transcript alone: the pane's header shows the session title (its first message).
    const transcript = () => pane().locator('[data-transcript-scroll]')
    const node = (id) => page.locator(`[data-tree-node="${id}"]`)

    const { agentId, cwd } = await step('open a workspace on QA Small', () =>
      app.openWorkspace({ args: { model: `qa/${FAKE_MODELS.small}`, thinking: 'off' } })
    )
    await step('three turns', async () => {
      for (const n of ['one', 'two', 'three']) {
        server.queue(turn.text(`compaction answer ${n}`))
        await sendWhenSettled(app, `compaction step ${n}`)
        await app.waitForSettle()
      }
    })
    const file = (await app.rpc({ type: 'get_state' })).sessionFile
    const before = (await app.rpc({ type: 'get_entries' })).entries
    const u1 = before.find(
      (e) => e.type === 'message' && messageText(e.message) === 'compaction step one'
    )
    const a1 = before.find(
      (e) => e.type === 'message' && messageText(e.message) === 'compaction answer one'
    )

    await check(
      '/compact with instructions: summarizer gets them, file gets a compaction entry',
      async () => {
        server.queue({ ...turn.text(SUMMARY), when: isSummaryRequest })
        const from = server.requests.length
        await runComposerCommand(app, '/compact Keep the word QUINCE')
        const request = await server.waitForRequest(isSummaryRequest, { from, timeoutMs: 20_000 })
        assert.match(inspectRequest(request).lastUserText, /Additional focus: Keep the word QUINCE/)
        await waitUntil(async () => (await app.agentState()).lastCompaction, {
          label: 'compaction result',
          timeoutMs: 20_000
        })
        const session = await assertValidSession(file)
        const compaction = session.entries.find((e) => e.type === 'compaction')
        assert.ok(compaction, 'compaction entry written')
        assert.ok(compaction.summary.includes(SUMMARY))
        await pane()
          .getByText(/Context compacted/)
          .waitFor()
        await app.screenshot('history-compacted-live', { settleMs: 300 })
      }
    )

    await check('the next request carries the summary instead of the early turns', async () => {
      const from = server.requests.length
      server.queue(turn.text('after compaction answer'))
      await sendWhenSettled(app, 'after compaction question')
      await app.waitForSettle()
      const sent = inspectRequest(
        await server.waitForRequest((r) => !isSummaryRequest(r), { from })
      )
      const texts = sent.messages.map((m) => m.text).join('\n')
      assert.ok(texts.includes(SUMMARY), 'summary in context')
      assert.ok(!texts.includes('compaction answer one'), 'the summarized turns are not')
    })

    let titleBefore
    await check('after a reopen the transcript says where the earlier messages went', async () => {
      titleBefore = await page.getByRole('button', { name: 'Rename session' }).innerText()
      const row = page
        .locator('section[aria-label="Open sessions"] [data-session-row]', {
          hasText: 'compaction step one'
        })
        .first()
      await row.hover()
      await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
      await page
        .locator('section[aria-label="Today"] [data-session-row]', {
          hasText: 'compaction step one'
        })
        .click()
      await pane().getByText('after compaction answer').waitFor({ timeout: 60_000 })
      await pane()
        .getByText(/Context compacted/)
        .waitFor()
      await app.screenshot('history-compacted-reopened', { settleMs: 300 })
      const earlyVisible = await transcript()
        .getByText('compaction step one', { exact: true })
        .count()
      const pointer = await transcript()
        .getByText(/session tree|Branches|earlier messages|full history/i)
        .count()
      assert.ok(
        earlyVisible > 0 || pointer > 0,
        'pre-compaction messages are shown, or the divider points to where they are'
      )
    })

    // After a reopen the context starts at the compaction summary, past the session's first user message.
    await check('the session keeps its title after compaction and a reopen', async () => {
      const header = await page.getByRole('button', { name: 'Rename session' }).innerText()
      const sidebar = await page
        .locator('section[aria-label="Open sessions"] [data-session-row]')
        .first()
        .innerText()
      assert.equal(header, titleBefore, 'header title')
      assert.ok(sidebar.startsWith(titleBefore), `sidebar row: ${sidebar.split(/\n/)[0]}`)
    })

    await check(
      'pre-compaction history is in the Branches tree and going back restores it as context',
      async () => {
        const reopened = await app.activeAgentId()
        await openBranchesTab(app)
        await node(u1.id).waitFor()
        const compactionNode = page.locator('[data-tree-node]', { hasText: 'Compaction' }).first()
        await compactionNode.waitFor()
        await app.screenshot('history-compaction-tree', { settleMs: 300 })
        await node(a1.id).locator('> button').click()
        await node(a1.id).getByRole('button', { name: 'Go to this point' }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Go to this point' }).click()
        await waitUntil(
          async () => (await app.rpc({ type: 'get_tree' }, reopened)).leafId === a1.id,
          { label: 'leaf before compaction' }
        )
        const from = server.requests.length
        server.queue(turn.text('back before compaction'))
        await sendWhenSettled(app, 'question before compaction')
        await app.waitForSettle()
        const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
        const texts = sent.messages.map((m) => m.text)
        assert.ok(texts.includes('compaction answer one'), 'the original turn is context again')
        assert.ok(!texts.join('\n').includes(SUMMARY), 'the summary is not on this branch')
        assert.ok(agentId)
      }
    )

    // ─── Subagent child sessions ─────────────────────────────────────────
    const runId = randomUUID()
    const childName = `subagent-worker-${runId}-1`
    const sessionsDir = workspaceSessionDir(agentDir, cwd)
    let parentPath
    await step(
      'write a parent session and child sessions shaped like pi-subagents output',
      async () => {
        const parent = new SessionBuilder({ cwd })
        parent.modelChange()
        parent.user('Delegate lane B to a worker')
        parent.assistant('Started a worker.', {
          toolCalls: [
            { id: 'toolu_sub_1', name: 'subagent', args: { agent: 'worker', task: 'Fix lane B' } }
          ]
        })
        parent.toolResult('toolu_sub_1', 'subagent', `Started async run ${runId}`)
        parent.customMessage(
          'subagent-notify',
          `Background task completed: **worker**\n\nworker:\nLane B fixed and tested.\n\nFull output: ${join(sessionsDir, 'out', `${runId}.md`)} (2.1 KB, 40 lines)`,
          { runId }
        )
        parent.assistant('The worker finished lane B.')
        parent.name('Parent with a worker')
        parentPath = await parent.write(sessionsDir)
        const childFor = () => {
          const child = new SessionBuilder({ cwd, parentSession: parentPath })
          child.modelChange()
          child.name(childName)
          child.user(
            'Task: Fix lane B. The session tree jumps to the top after a fork; keep the forked node selected.'
          )
          child.assistant('Lane B fixed and tested.')
          return child
        }
        // pi-subagents' default layout: <sessions>/<parent file name>/<run id>/run-0/<file>.jsonl
        await childFor().write(join(sessionsDir, basename(parentPath, '.jsonl'), runId, 'run-0'))
        // A child that lives directly in the workspace folder (default storage).
        await childFor().write(sessionsDir)
      }
    )

    await check(
      'a top-level child session reads "Worker subagent · <task>", raw name only as a tooltip',
      async () => {
        const row = page.locator('[data-session-row]', { hasText: 'Worker subagent' }).first()
        await row.waitFor({ timeout: 15_000 })
        const text = await row.innerText()
        assert.match(text, /Worker subagent · Fix lane B/)
        assert.ok(!text.includes(runId), 'no run id in the row')
        await row.locator('span.truncate').first().hover()
        await page.getByRole('tooltip').getByText(childName).waitFor()
        await app.screenshot('history-child-row', { settleMs: 200 })
      }
    )

    await check('opening a child session titles the header the same way', async () => {
      await page.locator('[data-session-row]', { hasText: 'Worker subagent' }).first().click()
      await pane().getByText('Lane B fixed and tested.').waitFor({ timeout: 60_000 })
      await waitUntil(
        async () => (await page.getByRole('button', { name: 'Rename session' }).count()) === 1,
        { label: 'one pane' }
      )
      const title = await page.getByRole('button', { name: 'Rename session' }).innerText()
      assert.match(title, /^Worker subagent · Fix lane B/)
      assert.ok(!title.includes(runId))
    })

    await check(
      'the parent tree shows the subagent notice as a readable event (no ids, no paths)',
      async () => {
        await page
          .locator('[data-session-row]', { hasText: 'Parent with a worker' })
          .first()
          .click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
        const dialog = page.getByRole('dialog')
        const notice = dialog.locator('[data-tree-node]', { hasText: 'Subagent' }).first()
        await notice.waitFor()
        const text = await notice.innerText()
        assert.match(text, /worker finished · Lane B fixed and tested\./)
        assert.ok(!text.includes(runId) && !/[A-Za-z]:\\/.test(text), `readable: ${text}`)
        await app.screenshot('history-parent-tree', { settleMs: 200 })
        await page.keyboard.press('Escape')
      }
    )

    // The Engine's SessionManager.list is not recursive; the app lists the nested run-0 child itself.
    await check('the nested pi-subagents child session is reachable from its parent', async () => {
      const listing = await app.invoke('sessions:list', { cwd })
      const nested = listing.sessions.filter((s) => s.path.includes(`${runId}`))
      assert.equal(nested.length, 1, `nested child listed: ${nested.length}`)
      assert.equal(nested[0].subagentRun?.parentPath.toLowerCase(), parentPath.toLowerCase())
      assert.equal(nested[0].subagentRun?.runId, runId)

      // Sidebar: grouped under the parent row, collapsed by default.
      const toggle = page.getByRole('button', { name: '1 subagent session' })
      await toggle.waitFor()
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      await toggle.click()
      const childRows = page.locator('section[aria-label="Today"] [data-session-row]', {
        hasText: 'Worker subagent · Fix lane B'
      })
      await waitUntil(async () => (await childRows.count()) === 1, {
        label: 'child row under the parent'
      })
      await app.screenshot('history-nested-child-row', { settleMs: 300 })
      await toggle.click()

      // Parent tree: the subagent notice opens the child session.
      await page
        .locator('[data-session-row]', { hasText: 'Parent with a worker' })
        .first()
        .click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
      const dialog = page.getByRole('dialog')
      await dialog
        .locator('[data-tree-node]', { hasText: 'Subagent' })
        .first()
        .locator('> button')
        .click()
      await app.screenshot('history-parent-tree-open-child', { settleMs: 300 })
      await dialog.getByRole('button', { name: 'Open child session' }).click()
      await waitUntil(
        async () =>
          (await app.invoke('engine:list')).some(
            (engine) => engine.sessionFile?.toLowerCase() === nested[0].path.toLowerCase()
          ),
        { label: 'an engine on the nested child session', timeoutMs: 60_000 }
      )
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR }, agentDir: { settings: { compaction: { keepRecentTokens: 1 } } } }
)
