// Export (header button, context menu, /export <path>, closed and ephemeral sessions), import (picked file
// copied into the session folder, missing folder → this workspace, name clash, a non-session file) and the
// share dialog up to the upload. Native save/open dialogs are answered in the main process; the gist upload
// is replaced by a recorder, so nothing ever leaves the machine.
//
//   node scripts/qa/sessions/export-import-share.qa.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  createChecks,
  runComposerCommand,
  sendWhenSettled,
  SHOTS_DIR,
  waitUntil
} from './lib/checks.mjs'
import {
  answerOpenDialog,
  answerSaveDialog,
  saveDialogCalls,
  shareCalls,
  stubShare
} from './lib/main-stubs.mjs'
import {
  assertValidSession,
  messageText,
  readSession,
  SessionBuilder,
  userTexts,
  workspaceSessionDir
} from './lib/session-files.mjs'

await runSuite(
  'sessions-export-import-share',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'export')
    const page = app.page
    const outDir = agentDir.path('../exports')
    await agentDir.writeText('../exports/.keep', '')
    const out = (name) => join(outDir, name)
    const openExportSubmenu = async () => {
      await page.getByRole('menuitem', { name: 'Export' }).hover()
      await page.keyboard.press('ArrowRight')
      await page.getByRole('menuitem', { name: 'Web page (HTML)…' }).waitFor()
      await page.waitForTimeout(250)
    }

    const { agentId, cwd } = await step('open a workspace and run two turns', async () => {
      const opened = await app.openWorkspace()
      server.queue(turn.text('Export answer one.'))
      await sendWhenSettled(app, 'export prompt one')
      await app.waitForSettle()
      server.queue(turn.text('Export answer two.'))
      await sendWhenSettled(app, 'export prompt two')
      await app.waitForSettle()
      return opened
    })
    const state = await app.rpc({ type: 'get_state' })
    const file = state.sessionFile

    await check('header "Export as HTML…" writes an HTML page of the session', async () => {
      await answerSaveDialog(app, out('header.html'))
      await page.getByRole('button', { name: 'Export as HTML…' }).click()
      await waitUntil(() => existsSync(out('header.html')), {
        label: 'html written',
        timeoutMs: 20_000
      })
      const html = await readFile(out('header.html'), 'utf8')
      assert.match(html, /<html/i)
      assert.ok(html.length > 1000)
      const [dialog] = await saveDialogCalls(app)
      assert.match(dialog.defaultPath, /\.html$/)
      assert.deepEqual(
        dialog.filters.map((f) => f.extensions[0]),
        ['html', 'jsonl']
      )
      await page.getByText('Exported as a web page').waitFor()
      await app.screenshot('export-html-toast', { settleMs: 200 })
    })

    await check('the same save dialog writes JSONL when the user picks a .jsonl name', async () => {
      await answerSaveDialog(app, out('header-picked.jsonl'))
      await page.getByRole('button', { name: 'Export as HTML…' }).click()
      await waitUntil(() => existsSync(out('header-picked.jsonl')), { label: 'jsonl written' })
      const exported = await assertValidSession(out('header-picked.jsonl'))
      assert.equal(exported.header.id, state.sessionId)
      assert.deepEqual(userTexts(exported), ['export prompt one', 'export prompt two'])
    })

    await check(
      'context menu Export → Session file (JSONL) of the open session: a linear valid branch',
      async () => {
        await answerSaveDialog(app, out('menu.jsonl'))
        await page
          .locator('[data-session-row]', { hasText: 'export prompt one' })
          .first()
          .click({ button: 'right' })
        await openExportSubmenu()
        await page.getByRole('menuitem', { name: 'Session file (JSONL)…' }).click()
        await waitUntil(() => existsSync(out('menu.jsonl')), { label: 'jsonl written' })
        const exported = await assertValidSession(out('menu.jsonl'))
        const original = await readSession(file)
        assert.equal(exported.header.cwd, cwd)
        assert.equal(exported.entries.length, original.entries.length)
        exported.entries.forEach((entry, index) =>
          assert.equal(entry.parentId, index === 0 ? null : exported.entries[index - 1].id)
        )
      }
    )

    await check(
      '/export out.jsonl (relative) writes next to the workspace and parses',
      async () => {
        await runComposerCommand(app, '/export composer-export.jsonl')
        const target = join(cwd, 'composer-export.jsonl')
        await waitUntil(() => existsSync(target), { label: '/export jsonl', timeoutMs: 20_000 })
        const exported = await assertValidSession(target)
        assert.deepEqual(userTexts(exported), ['export prompt one', 'export prompt two'])
        await page.getByText('Session exported').first().waitFor()
        assert.equal(
          server.requests.filter((r) => JSON.stringify(r.body).includes('/export')).length,
          0,
          '/export never reaches the model'
        )
      }
    )

    await check('/export <absolute>.html writes HTML', async () => {
      await runComposerCommand(app, `/export ${out('composer.html')}`)
      await waitUntil(() => existsSync(out('composer.html')), {
        label: '/export html',
        timeoutMs: 20_000
      })
      assert.match(await readFile(out('composer.html'), 'utf8'), /<html/i)
    })

    await check(
      'a closed session exports HTML (engine CLI) and JSONL from the history list',
      async () => {
        await page.getByRole('button', { name: 'New session', exact: true }).first().click()
        await waitUntil(
          async () => {
            const id = await app.activeAgentId()
            return id && id !== agentId && (await app.agentState(id))?.session
          },
          { label: 'second agent', timeoutMs: 60_000 }
        )
        const row = page.locator('section[aria-label="Open sessions"] [data-session-row]', {
          hasText: 'export prompt one'
        })
        await row.hover()
        await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
        const history = page.locator('section[aria-label="Today"] [data-session-row]', {
          hasText: 'export prompt one'
        })
        await history.waitFor()
        await answerSaveDialog(app, out('closed.html'))
        await history.click({ button: 'right' })
        await openExportSubmenu()
        await page.getByRole('menuitem', { name: 'Web page (HTML)…' }).click()
        await waitUntil(() => existsSync(out('closed.html')), {
          label: 'closed html',
          timeoutMs: 60_000
        })
        assert.match(await readFile(out('closed.html'), 'utf8'), /<html/i)
        await answerSaveDialog(app, out('closed.jsonl'))
        await history.click({ button: 'right' })
        await openExportSubmenu()
        await page.getByRole('menuitem', { name: 'Session file (JSONL)…' }).click()
        await waitUntil(() => existsSync(out('closed.jsonl')), {
          label: 'closed jsonl',
          timeoutMs: 20_000
        })
        const exported = await assertValidSession(out('closed.jsonl'))
        assert.deepEqual(userTexts(exported), ['export prompt one', 'export prompt two'])
      }
    )

    await check('an ephemeral session exports JSONL from the live engine', async () => {
      await page.getByRole('button', { name: 'More ways to start' }).click()
      await page.getByRole('menuitem', { name: 'New ephemeral session' }).click()
      await waitUntil(
        async () =>
          (await app.agentState())?.info.args.noSession && (await app.agentState())?.session,
        {
          label: 'ephemeral agent',
          timeoutMs: 60_000
        }
      )
      server.queue(turn.text('Ephemeral export answer.'))
      await sendWhenSettled(app, 'ephemeral export prompt')
      await app.waitForSettle()
      await runComposerCommand(app, `/export ${out('ephemeral.jsonl')}`)
      await waitUntil(() => existsSync(out('ephemeral.jsonl')), {
        label: 'ephemeral jsonl',
        timeoutMs: 20_000
      })
      const exported = await assertValidSession(out('ephemeral.jsonl'))
      assert.deepEqual(userTexts(exported), ['ephemeral export prompt'])
      assert.ok(exported.header.cwd, 'the export names the folder')
    })

    // ─── Import ───────────────────────────────────────────────────────────
    const importSource = async (name, { cwd: headerCwd, sessionName, prompt }) => {
      const builder = new SessionBuilder({ cwd: headerCwd })
      builder.modelChange()
      builder.user(prompt)
      builder.assistant(`Imported reply for ${prompt}.`)
      if (sessionName) builder.name(sessionName)
      return builder.write(agentDir.path('../imports'), name)
    }

    await check(
      'import a session file: reviewed, copied into the session folder, opened; original untouched',
      async () => {
        const source = await importSource('imported-one.jsonl', {
          cwd,
          sessionName: 'Imported session one',
          prompt: 'imported prompt one'
        })
        const originalText = await readFile(source, 'utf8')
        await answerOpenDialog(app, source)
        await page.getByRole('button', { name: 'More ways to start' }).click()
        await page.getByRole('menuitem', { name: 'Import session…' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText('Imported session one').waitFor()
        await dialog.getByText('2 messages').waitFor()
        await app.screenshot('import-review', { settleMs: 200 })
        await dialog.getByRole('button', { name: 'Import and open' }).click()
        await page
          .locator('[data-session-pane]')
          .getByText('Imported reply for imported prompt one.')
          .waitFor({ timeout: 60_000 })
        const copy = join(workspaceSessionDir(agentDir, cwd), 'imported-one.jsonl')
        assert.ok(existsSync(copy), 'copied into the workspace session folder')
        const state = await app.rpc({ type: 'get_state' })
        assert.equal(state.sessionFile.toLowerCase(), copy.toLowerCase())
        assert.equal(state.sessionName, 'Imported session one')
        assert.equal(await readFile(source, 'utf8'), originalText, 'the picked file is unchanged')
        await page.getByText('Session imported').first().waitFor()
        // The imported session continues normally.
        server.queue(turn.text('Continuing the import.'))
        await sendWhenSettled(app, 'continue imported')
        await app.waitForSettle()
        await assertValidSession(copy)
      }
    )

    await check(
      'import a file whose folder is gone: warning, continues in this workspace, header rewritten',
      async () => {
        const missing = 'C:\\qa-missing-folder\\nowhere'
        const source = await importSource('imported-moved.jsonl', {
          cwd: missing,
          prompt: 'imported prompt moved'
        })
        await answerOpenDialog(app, source)
        await page.getByRole('button', { name: 'More ways to start' }).click()
        await page.getByRole('menuitem', { name: 'Import session…' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText("doesn't exist on this computer", { exact: false }).waitFor()
        await app.screenshot('import-missing-folder', { settleMs: 200 })
        await dialog.getByRole('button', { name: 'Import and open' }).click()
        await page
          .locator('[data-session-pane]')
          .getByText('Imported reply for imported prompt moved.')
          .waitFor({ timeout: 60_000 })
        const state = await app.rpc({ type: 'get_state' })
        const copy = await assertValidSession(state.sessionFile)
        assert.equal(copy.header.cwd.toLowerCase(), cwd.toLowerCase())
        assert.equal((await readSession(source)).header.cwd, missing)
      }
    )

    await check('importing the same file name again gets a -1 suffix', async () => {
      const source = await importSource('imported-one.jsonl', {
        cwd,
        prompt: 'imported prompt again'
      })
      await answerOpenDialog(app, source)
      await page.getByRole('button', { name: 'More ways to start' }).click()
      await page.getByRole('menuitem', { name: 'Import session…' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Import and open' }).click()
      const copy = join(workspaceSessionDir(agentDir, cwd), 'imported-one-1.jsonl')
      await waitUntil(() => existsSync(copy), { label: 'suffixed copy' })
      const first = await readSession(
        join(workspaceSessionDir(agentDir, cwd), 'imported-one.jsonl')
      )
      assert.ok(
        first.entries.some(
          (e) => e.type === 'message' && messageText(e.message) === 'continue imported'
        ),
        'the first copy is not overwritten'
      )
    })

    await check('a file that is not a session is refused with a readable error', async () => {
      await writeFile(agentDir.path('../imports/not-a-session.jsonl'), '{"hello":"world"}\n')
      await answerOpenDialog(app, agentDir.path('../imports/not-a-session.jsonl'))
      await page.getByRole('button', { name: 'More ways to start' }).click()
      await page.getByRole('menuitem', { name: 'Import session…' }).click()
      await page.getByText('Could not read that file').waitFor()
      await page.getByText('This file is not a session file').waitFor()
      app.allowError(/not a session file/)
    })

    // ─── Share ────────────────────────────────────────────────────────────
    await check(
      'share: GitHub CLI signed out → setup steps, Create link disabled, nothing uploaded',
      async () => {
        await stubShare(app, {
          ready: false,
          reason: 'signed-out',
          detail: 'You are not logged into any GitHub hosts.'
        })
        await runComposerCommand(app, '/share')
        const dialog = page.getByRole('dialog')
        await dialog.getByText('Share this session').waitFor()
        await dialog
          .getByText('The GitHub CLI is installed but not signed in', { exact: false })
          .waitFor()
        await dialog.getByText('gh auth login').waitFor()
        assert.equal(await dialog.getByRole('button', { name: 'Create link' }).isDisabled(), true)
        await app.screenshot('share-signed-out', { settleMs: 200 })
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        assert.equal((await shareCalls(app)).uploads.length, 0)
      }
    )

    await check('share: GitHub CLI missing → install step', async () => {
      await stubShare(app, { ready: false, reason: 'missing-gh' })
      await page.getByRole('button', { name: /^Search or run a command/ }).click()
      await page.keyboard.type('Share session')
      await page.getByRole('option', { name: /Share session/ }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Install the GitHub CLI').waitFor()
      await app.screenshot('share-missing-gh', { settleMs: 200 })
      await page.keyboard.press('Escape')
      assert.equal((await shareCalls(app)).uploads.length, 0)
    })

    await check(
      'share: ready → review list; opening or cancelling never uploads; Create link uploads once',
      async () => {
        await stubShare(app, { ready: true })
        await runComposerCommand(app, '/share')
        const dialog = page.getByRole('dialog')
        await dialog.getByText('Every message on the current branch').waitFor()
        const create = dialog.getByRole('button', { name: 'Create link' })
        await waitUntil(async () => !(await create.isDisabled()), { label: 'Create link enabled' })
        await app.screenshot('share-ready', { settleMs: 200 })
        await page.waitForTimeout(500)
        assert.equal((await shareCalls(app)).uploads.length, 0, 'no upload before the click')
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        assert.equal((await shareCalls(app)).uploads.length, 0, 'no upload after cancel')
        await runComposerCommand(app, '/share')
        await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click()
        await page.getByRole('dialog').getByText('Link copied').waitFor()
        const { uploads } = await shareCalls(app)
        assert.equal(uploads.length, 1)
        assert.ok(
          uploads[0][0].sessionPath || uploads[0][0].agentId,
          'the upload names the session'
        )
        await app.screenshot('share-result', { settleMs: 200 })
        await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
      }
    )

    await check('exported files are valid against session-format.md', async () => {
      for (const name of ['header-picked.jsonl', 'menu.jsonl', 'closed.jsonl', 'ephemeral.jsonl'])
        await assertValidSession(out(name))
      assert.ok(basename(file))
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
