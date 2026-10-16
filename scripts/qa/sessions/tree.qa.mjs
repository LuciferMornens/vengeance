// Branching and the session tree through the inspector's Branches tab: go to a point in place (no summary,
// summary, summary with instructions), checked against the Engine leaf (get_tree), the session file and the
// next request the fake LLM receives; continue in a new session; fork from a message (header and entries of
// the new file); labels add/edit/clear; every tree filter; and the closed-session tree dialog.
//
//   node scripts/qa/sessions/tree.qa.mjs
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  createChecks,
  openBranchesTab,
  sendWhenSettled,
  SHOTS_DIR,
  waitUntil
} from './lib/checks.mjs'
import { assertValidSession, messageText, pathTo, readSession } from './lib/session-files.mjs'

const SUMMARY_TEXT = 'QA branch summary: tried step three.'
const CUSTOM_SUMMARY_TEXT = 'QA custom summary keeping KUMQUAT.'
const isBranchSummaryRequest = (request) =>
  inspectRequest(request).lastUserText.includes('<conversation>')

await runSuite(
  'sessions-tree',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'tree')
    const page = app.page
    const entries = async (agentId) => (await app.rpc({ type: 'get_entries' }, agentId)).entries
    const tree = (agentId) => app.rpc({ type: 'get_tree' }, agentId)
    const byText = (list, role, text) =>
      list.find(
        (e) => e.type === 'message' && e.message.role === role && messageText(e.message) === text
      )
    const node = (id) => page.locator(`[data-tree-node="${id}"]`)
    const selectNode = async (id) => {
      const button = node(id).locator('> button')
      if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    }
    const composer = async () => {
      await waitUntil(
        async () => (await page.locator('textarea[aria-label="Message"]').count()) === 1,
        { label: 'one composer' }
      )
      return page.locator('textarea[aria-label="Message"]')
    }
    const composerText = async () => (await composer()).inputValue()
    const clearComposer = async () => (await composer()).fill('')
    const transcript = (text) => page.locator('[data-session-pane]').getByText(text)

    const { agentId, cwd } = await step('open a workspace', () => app.openWorkspace())
    let file
    let ids = {}

    await step('three turns, the second with a bash tool call', async () => {
      server.queue(turn.text('answer one'))
      await sendWhenSettled(app, 'tree step one')
      await app.waitForSettle()
      server.queue(
        turn.toolCalls([{ id: 'toolu_tree_1', name: 'bash', args: { command: 'echo tree' } }]),
        turn.text('answer two')
      )
      await sendWhenSettled(app, 'tree step two')
      await app.waitForSettle()
      server.queue(turn.text('answer three'))
      await sendWhenSettled(app, 'tree step three')
      await app.waitForSettle()
      file = (await app.rpc({ type: 'get_state' })).sessionFile
      const list = await entries(agentId)
      ids = {
        u1: byText(list, 'user', 'tree step one').id,
        a1: byText(list, 'assistant', 'answer one').id,
        u2: byText(list, 'user', 'tree step two').id,
        a2: byText(list, 'assistant', 'answer two').id,
        u3: byText(list, 'user', 'tree step three').id,
        a3: byText(list, 'assistant', 'answer three').id
      }
      // The tool turn folds into one tree node, keyed by its first assistant entry (the tool call).
      ids.a2node = list.find((e) => e.parentId === ids.u2).id
    })

    await check(
      'Branches tab shows the conversation with the leaf marked "You are here"',
      async () => {
        await openBranchesTab(app)
        for (const id of [ids.u1, ids.a1, ids.u2, ids.a2node, ids.u3, ids.a3])
          await node(id).waitFor()
        assert.match(await node(ids.a3).innerText(), /You are here/)
        assert.match(await node(ids.u2).innerText(), /tree step two/)
        await app.screenshot('tree-linear', { settleMs: 300 })
      }
    )

    await check(
      'go to an assistant point without a summary: leaf, transcript, file and next request',
      async () => {
        await selectNode(ids.a1)
        await node(ids.a1).getByRole('button', { name: 'Go to this point' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText("You're leaving the current branch. Summarize it first?").waitFor()
        assert.equal(
          await dialog.getByRole('radio', { name: /No summary/ }).getAttribute('aria-checked'),
          'true'
        )
        await app.screenshot('tree-navigate-dialog', { settleMs: 200 })
        const requestsBefore = server.requests.length
        await dialog.getByRole('button', { name: 'Go to this point' }).click()
        await waitUntil(async () => (await tree(agentId)).leafId === ids.a1, {
          label: 'engine leaf at answer one'
        })
        assert.equal(server.requests.length, requestsBefore, 'no model call without a summary')
        await waitUntil(async () => (await transcript('answer three').count()) === 0, {
          label: 'transcript rewound'
        })
        assert.equal(await composerText(), '', 'an assistant point leaves the composer empty')
        const from = server.requests.length
        server.queue(turn.text('answer after going back'))
        await sendWhenSettled(app, 'after going back to one')
        await app.waitForSettle()
        const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
        const texts = sent.messages.map((m) => m.text)
        assert.deepEqual(
          texts.filter(
            (t) => t.startsWith('tree step') || t.startsWith('answer') || t.startsWith('after')
          ),
          ['tree step one', 'answer one', 'after going back to one']
        )
        const session = await assertValidSession(file)
        const added = session.entries.find(
          (e) => e.type === 'message' && messageText(e.message) === 'after going back to one'
        )
        assert.equal(added.parentId, ids.a1, 'the new message continues from answer one')
        assert.ok(
          session.entries.some((e) => e.id === ids.a3),
          'the branch that was left stays in the file'
        )
        ids.uBack = added.id
        ids.aBack = (await entries(agentId)).find(
          (e) => e.type === 'message' && messageText(e.message) === 'answer after going back'
        ).id
      }
    )

    await check(
      'go to a user message with a branch summary: summary entry, composer text, context',
      async () => {
        server.queue({ ...turn.text(SUMMARY_TEXT), when: isBranchSummaryRequest })
        await node(ids.u3).waitFor()
        await selectNode(ids.u3)
        await node(ids.u3).getByRole('button', { name: 'Go to this point' }).click()
        const dialog = page.getByRole('dialog')
        await dialog
          .getByText('Your message goes back into the composer to edit and resend.')
          .waitFor()
        await dialog.getByRole('radio', { name: /Summarize the branch/ }).click()
        const from = server.requests.length
        await dialog.getByRole('button', { name: 'Go to this point' }).click()
        const summaryRequest = await server.waitForRequest(isBranchSummaryRequest, {
          from,
          timeoutMs: 20_000
        })
        const summaryPrompt = inspectRequest(summaryRequest).lastUserText
        assert.match(summaryPrompt, /Create a structured summary of this conversation branch/)
        assert.match(
          summaryPrompt,
          /after going back to one/,
          'the summarized branch is the one being left'
        )
        await waitUntil(async () => (await composerText()) === 'tree step three', {
          label: 'message back in the composer'
        })
        const session = await assertValidSession(file)
        const summary = session.entries.filter((e) => e.type === 'branch_summary').at(-1)
        assert.ok(summary, 'a branch_summary entry was written')
        assert.ok(summary.summary.includes(SUMMARY_TEXT), summary.summary)
        assert.equal(
          summary.parentId,
          ids.a2,
          'the summary hangs off the parent of the selected message'
        )
        assert.equal(summary.fromId, ids.aBack, 'fromId is the leaf that was left')
        assert.equal((await tree(agentId)).leafId, summary.id)
        ids.summary = summary.id
        await transcript('Summary of the branch you left').waitFor()
        await app.screenshot('tree-after-summary', { settleMs: 300 })
        const next = server.requests.length
        server.queue(turn.text('resent three'))
        await (await composer()).press('Enter')
        await app.waitForSettle()
        const sent = inspectRequest(await server.waitForRequest(undefined, { from: next }))
        const texts = sent.messages.map((m) => m.text).join('\n')
        assert.ok(texts.includes(SUMMARY_TEXT), 'the branch summary is in the next context')
        assert.ok(texts.includes('answer two'))
        assert.ok(!texts.includes('answer after going back'), 'the left branch itself is not')
        assert.equal(sent.lastUserText, 'tree step three')
      }
    )

    await check('summary with custom instructions sends them to the summarizer', async () => {
      server.queue({ ...turn.text(CUSTOM_SUMMARY_TEXT), when: isBranchSummaryRequest })
      await selectNode(ids.a1)
      await node(ids.a1).getByRole('button', { name: 'Go to this point' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('radio', { name: /Summarize with instructions/ }).click()
      assert.equal(
        await dialog.getByRole('button', { name: 'Go to this point' }).isDisabled(),
        true,
        'needs instructions first'
      )
      await dialog.getByRole('textbox').fill('Keep the word KUMQUAT.')
      await app.screenshot('tree-navigate-custom', { settleMs: 200 })
      const from = server.requests.length
      await dialog.getByRole('button', { name: 'Go to this point' }).click()
      const request = await server.waitForRequest(isBranchSummaryRequest, {
        from,
        timeoutMs: 20_000
      })
      assert.match(
        inspectRequest(request).lastUserText,
        /Additional focus: Keep the word KUMQUAT\./
      )
      await waitUntil(
        async () => {
          const session = await readSession(file)
          return session.entries.some(
            (e) => e.type === 'branch_summary' && e.summary.includes(CUSTOM_SUMMARY_TEXT)
          )
        },
        { label: 'custom summary entry' }
      )
      const leaf = (await tree(agentId)).leafId
      const session = await assertValidSession(file)
      const leafEntry = session.entries.find((e) => e.id === leaf)
      assert.equal(leafEntry.type, 'branch_summary')
      assert.equal(leafEntry.parentId, ids.a1)
    })

    await check('labels: add, edit and clear through the tree land as label entries', async () => {
      await selectNode(ids.u2)
      await node(ids.u2).getByRole('button', { name: 'Add label' }).click()
      let input = page.getByRole('textbox', { name: 'Label' })
      await input.fill('checkpoint-a')
      await input.press('Enter')
      await node(ids.u2).getByText('checkpoint-a').waitFor()
      let labels = (await readSession(file)).entries.filter(
        (e) => e.type === 'label' && e.targetId === ids.u2
      )
      assert.equal(labels.at(-1)?.label, 'checkpoint-a')
      assert.equal(
        (await tree(agentId)).nodes.find((n) => n.entry.id === ids.u2)?.label,
        'checkpoint-a'
      )
      await selectNode(ids.u2)
      await node(ids.u2).getByRole('button', { name: 'Edit label' }).click()
      input = page.getByRole('textbox', { name: 'Label' })
      await input.fill('checkpoint-b')
      await input.press('Enter')
      await node(ids.u2).getByText('checkpoint-b').waitFor()
      await app.screenshot('tree-label', { settleMs: 200 })
      await selectNode(ids.u2)
      await node(ids.u2).getByRole('button', { name: 'Edit label' }).click()
      input = page.getByRole('textbox', { name: 'Label' })
      await input.fill('')
      await input.press('Enter')
      await waitUntil(async () => (await node(ids.u2).getByText('checkpoint-b').count()) === 0, {
        label: 'label cleared in UI'
      })
      labels = (await assertValidSession(file)).entries.filter(
        (e) => e.type === 'label' && e.targetId === ids.u2
      )
      assert.deepEqual(
        labels.map((e) => e.label),
        ['checkpoint-a', 'checkpoint-b', undefined]
      )
      assert.equal((await tree(agentId)).nodes.find((n) => n.entry.id === ids.u2)?.label, undefined)
    })

    await check('filters: Default, No tools, You, Labeled, All show the right nodes', async () => {
      // A label to filter on.
      await selectNode(ids.u1)
      await node(ids.u1).getByRole('button', { name: 'Add label' }).click()
      const input = page.getByRole('textbox', { name: 'Label' })
      await input.fill('start-here')
      await input.press('Enter')
      await node(ids.u1).getByText('start-here').waitFor()
      const chip = (name) =>
        page
          .getByRole('radiogroup', { name: 'Show in tree' })
          .getByRole('radio', { name, exact: true })
      const shown = async () =>
        page
          .locator('[data-tree-node]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-tree-node')))
      const kinds = async () =>
        page
          .locator('[data-tree-node] > button')
          .evaluateAll((els) =>
            els.map((el) => el.querySelector('span.font-medium')?.textContent ?? '')
          )

      await chip('Default').click()
      const defaults = await shown()
      for (const id of [ids.u1, ids.a1, ids.u2, ids.a2node, ids.u3, ids.a3])
        assert.ok(defaults.includes(id), `default shows ${id}`)

      await chip('You').click()
      const userKinds = await kinds()
      const allowed = new Set(['You', 'Session start', 'Branch summary'])
      // The current leaf (a branch summary) always shows.
      assert.ok(
        userKinds.every((kind) => allowed.has(kind)),
        `user-only kinds: ${userKinds.join(', ')}`
      )
      assert.ok((await shown()).includes(ids.u3))
      assert.ok(!(await shown()).includes(ids.a1))

      await chip('Labeled').click()
      const labeled = await shown()
      assert.ok(labeled.includes(ids.u1), 'the labeled node shows')
      assert.ok(!labeled.includes(ids.u2), 'a cleared label no longer counts')
      await app.screenshot('tree-filter-labeled', { settleMs: 200 })

      await chip('All').click()
      const allText = await page.locator('[data-tree-node]').allInnerTexts()
      assert.ok(
        allText.some((t) => /Model · /.test(t)),
        'model_change entries appear under All'
      )
      assert.ok(
        allText.some((t) => /Tool result/.test(t) && /bash/.test(t)),
        'tool results appear under All'
      )
      assert.ok(
        allText.some((t) => /Label · start-here/.test(t)),
        'label entries appear under All'
      )
      await app.screenshot('tree-filter-all', { settleMs: 200 })

      await chip('No tools').click()
      const noTools = await page.locator('[data-tree-node]').allInnerTexts()
      assert.ok(!noTools.some((t) => /\d+ tools?\b/.test(t)), 'no tool counts under No tools')
      await chip('Default').click()
    })

    let continued
    await check(
      'continue in a new session from a point: new file with the path and parentSession',
      async () => {
        const enginesBefore = (await app.invoke('engine:list')).length
        await selectNode(ids.a2node)
        await node(ids.a2node).getByRole('button', { name: 'Continue in a new session' }).click()
        continued = await waitUntil(
          async () => {
            const id = await app.activeAgentId()
            const state = id && id !== agentId ? await app.agentState(id) : null
            return state?.status === 'ready' && state.session ? id : null
          },
          { label: 'continued agent', timeoutMs: 60_000 }
        )
        assert.equal((await app.invoke('engine:list')).length, enginesBefore + 1)
        const newFile = (await app.rpc({ type: 'get_state' }, continued)).sessionFile
        assert.notEqual(newFile, file)
        const copy = await assertValidSession(newFile)
        assert.equal(copy.header.parentSession?.toLowerCase(), file.toLowerCase())
        const original = await readSession(file)
        const expected = pathTo(original, ids.a2)
          .filter((e) => e.type !== 'label')
          .map((e) => e.id)
        const got = copy.entries.filter((e) => e.type !== 'label').map((e) => e.id)
        assert.deepEqual(
          got.slice(0, expected.length),
          expected,
          'the new file holds root → answer two'
        )
        assert.ok(!copy.entries.some((e) => e.id === ids.u3), 'nothing after the point')
        await transcript('answer two').first().waitFor()
      }
    )

    await check(
      'fork from a message (header button): new file ends before it and the text returns',
      async () => {
        // Back on the first session, which is idle: the fork happens in place.
        await page.locator('[data-session-row]', { hasText: 'tree step one' }).first().click()
        await waitUntil(async () => (await app.activeAgentId()) === agentId, {
          label: 'first agent active'
        })
        await clearComposer()
        await page.getByRole('button', { name: 'Fork from a message…' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText('Fork from a message').first().waitFor()
        await app.screenshot('tree-fork-dialog', { settleMs: 200 })
        await dialog.getByRole('button', { name: /tree step two/ }).click()
        const forkFile = await waitUntil(
          async () => {
            const state = await app.rpc({ type: 'get_state' }, agentId)
            return state.sessionFile !== file ? state.sessionFile : null
          },
          { label: 'agent moved to the fork file' }
        )
        await waitUntil(async () => (await composerText()) === 'tree step two', {
          label: 'message in the composer'
        })
        const fork = await assertValidSession(forkFile)
        assert.equal(fork.header.parentSession?.toLowerCase(), file.toLowerCase())
        const original = await readSession(file)
        const expected = pathTo(original, ids.a1)
          .filter((e) => e.type !== 'label')
          .map((e) => e.id)
        assert.deepEqual(
          fork.entries.filter((e) => e.type !== 'label').map((e) => e.id),
          expected,
          'root → answer one, nothing after'
        )
        await clearComposer()
      }
    )

    await check(
      'closed-session tree dialog: browse, label into the file, fork from a message',
      async () => {
        // Close the continued session; its file becomes a history row.
        const continuedFile = (await app.rpc({ type: 'get_state' }, continued)).sessionFile
        const row = page.locator('section[aria-label="Open sessions"] [data-session-row]', {
          hasText: 'tree step one'
        })
        await row.first().waitFor()
        await app.invoke('engine:list')
        // The original file is closed now (the first agent forked away from it).
        const history = page.locator(
          '[data-session-list] section:not([aria-label="Open sessions"]) [data-session-row]',
          {
            hasText: 'tree step one'
          }
        )
        await history.first().click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.locator(`[data-tree-node="${ids.u3}"]`).waitFor()
        assert.match(
          await dialog
            .locator('[data-tree-node]')
            .filter({ hasText: 'Latest' })
            .first()
            .innerText(),
          /Latest/
        )
        await app.screenshot('tree-closed-dialog', { settleMs: 300 })
        // Which file is this row? The one without an engine: the original.
        await dialog.locator(`[data-tree-node="${ids.u3}"] > button`).click()
        await dialog
          .locator(`[data-tree-node="${ids.u3}"]`)
          .getByRole('button', { name: 'Add label' })
          .click()
        const input = dialog.getByRole('textbox', { name: 'Label' })
        await input.fill('closed-label')
        await input.press('Enter')
        await dialog.getByText('closed-label').waitFor()
        const labels = (await assertValidSession(file)).entries.filter(
          (e) => e.type === 'label' && e.targetId === ids.u3
        )
        assert.equal(labels.at(-1)?.label, 'closed-label')
        const enginesBefore = (await app.invoke('engine:list')).length
        await dialog.locator(`[data-tree-node="${ids.u2}"] > button`).click()
        await dialog
          .locator(`[data-tree-node="${ids.u2}"]`)
          .getByRole('button', { name: 'Fork from here' })
          .click()
        const forked = await waitUntil(
          async () => {
            const list = await app.invoke('engine:list')
            return list.length === enginesBefore + 1 ? list.at(-1) : null
          },
          { label: 'fork engine', timeoutMs: 60_000 }
        )
        await waitUntil(async () => (await app.agentState(forked.agentId))?.session, {
          label: 'fork ready',
          timeoutMs: 60_000
        })
        const forkFile = (await app.rpc({ type: 'get_state' }, forked.agentId)).sessionFile
        const fork = await assertValidSession(forkFile)
        assert.equal(fork.header.parentSession?.toLowerCase(), file.toLowerCase())
        assert.ok(
          !fork.entries.some((e) => e.id === ids.u2),
          'the fork ends before the chosen message'
        )
        assert.equal(continuedFile.toLowerCase() === forkFile.toLowerCase(), false)
      }
    )

    await check('every session file is valid against session-format.md', async () => {
      const { assertAllValid } = await import('./lib/session-files.mjs')
      await assertAllValid(agentDir.path('sessions'))
      assert.ok(cwd)
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
