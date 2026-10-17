// Sessions lifecycle through the real sidebar and header: new session, the file on disk, switching, rename
// (open and closed → session_info), date grouping, search, pin, delete (Recycle Bin), continue a recent
// session from the empty state, the list watcher for outside changes, and ephemeral sessions.
//
//   node scripts/qa/sessions/lifecycle.qa.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { appendFile, rm, utimes } from 'node:fs/promises'
import { turn } from '../lib/fake-llm.mjs'
import { TRASH_NAME } from '../lib/platform.mjs'
import { runSuite } from '../lib/suite.mjs'
import { createChecks, sendWhenSettled, SHOTS_DIR, waitUntil } from './lib/checks.mjs'
import { recordTrash, trashCalls } from './lib/main-stubs.mjs'
import {
  assertAllValid,
  assertValidSession,
  listJsonl,
  readSession,
  SessionBuilder,
  sessionName,
  userTexts,
  workspaceSessionDir
} from './lib/session-files.mjs'

const FIXTURE_NOON_HOUR = 12

await runSuite(
  'sessions-lifecycle',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'lifecycle')
    const page = app.page
    const sidebarRow = (text) => page.locator('[data-session-row]', { hasText: text }).first()
    const section = (label) => page.locator(`section[aria-label="${label}"]`)
    const fileOf = async (agentId) => (await app.rpc({ type: 'get_state' }, agentId)).sessionFile
    const closeOpenRow = async (title) => {
      const engines = (await app.invoke('engine:list')).length
      const row = section('Open sessions').locator('[data-session-row]', { hasText: title }).first()
      await row.hover()
      await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
      await waitUntil(async () => (await app.invoke('engine:list')).length === engines - 1, {
        label: `${title} closed`
      })
    }

    const { agentId: first, cwd } = await step('open a workspace (first session)', () =>
      app.openWorkspace()
    )
    const dir = workspaceSessionDir(agentDir, cwd)
    let firstFile
    let secondFile
    let second

    await check('the new session is listed under Open as an empty "New session"', async () => {
      const row = section('Open sessions').locator('[data-session-row]')
      await row.first().waitFor()
      assert.equal(await row.count(), 1)
      assert.match(await row.first().innerText(), /New session[\s\S]*Empty/)
    })

    await check('first prompt writes a valid v3 session file for this workspace', async () => {
      server.queue(turn.text('Alpha answer about the parser.'))
      await sendWhenSettled(app, 'first prompt alpha')
      await app.waitForSettle()
      firstFile = await fileOf(first)
      assert.ok(firstFile?.startsWith(dir), `session file ${firstFile} in ${dir}`)
      const session = await assertValidSession(firstFile)
      assert.equal(session.header.cwd, cwd)
      assert.deepEqual(userTexts(session), ['first prompt alpha'])
      assert.ok(session.entries.some((e) => e.type === 'message' && e.message.role === 'assistant'))
      await sidebarRow('first prompt alpha').waitFor()
    })

    await check('"New session" button starts a second engine; both stay open', async () => {
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      second = await waitUntil(
        async () => {
          const id = await app.activeAgentId()
          const state = id && id !== first ? await app.agentState(id) : null
          return state?.status === 'ready' && state.session ? id : null
        },
        { label: 'second agent ready', timeoutMs: 60_000 }
      )
      server.queue(turn.text('Bravo reply mentions zeppelin.'))
      await sendWhenSettled(app, 'second prompt bravo')
      await app.waitForSettle()
      secondFile = await fileOf(second)
      assert.notEqual(secondFile, firstFile)
      await assertValidSession(secondFile)
      assert.equal(await section('Open sessions').locator('[data-session-row]').count(), 2)
    })

    await check('switching rows swaps the active agent and its transcript', async () => {
      await sidebarRow('first prompt alpha').click()
      await waitUntil(async () => (await app.activeAgentId()) === first, { label: 'first active' })
      await page.getByText('Alpha answer about the parser.').waitFor()
      // The previous pane fades out first (AnimatePresence); then only the active transcript is mounted.
      await waitUntil(
        async () => (await page.getByText('Bravo reply mentions zeppelin.').count()) === 0,
        {
          label: 'second transcript unmounted'
        }
      )
      await sidebarRow('second prompt bravo').click()
      await waitUntil(async () => (await app.activeAgentId()) === second, {
        label: 'second active'
      })
      await page.getByText('Bravo reply mentions zeppelin.').waitFor()
      await app.screenshot('lifecycle-two-open', { settleMs: 300 })
    })

    await check('header rename of an open session lands in the file as session_info', async () => {
      await page.getByRole('button', { name: 'Rename session' }).click()
      const input = page.getByRole('textbox', { name: 'Session name' })
      await input.fill('Bravo renamed in header')
      await input.press('Enter')
      await waitUntil(
        async () =>
          (await app.rpc({ type: 'get_state' }, second)).sessionName === 'Bravo renamed in header',
        {
          label: 'engine sessionName'
        }
      )
      const session = await assertValidSession(secondFile)
      assert.equal(sessionName(session), 'Bravo renamed in header')
      await sidebarRow('Bravo renamed in header').waitFor()
    })

    await check('closing an idle session moves it from Open to Today', async () => {
      await closeOpenRow('Bravo renamed in header')
      await waitUntil(async () => !(await app.agentState(second)), { label: 'agent disposed' })
      await section('Today')
        .locator('[data-session-row]', { hasText: 'Bravo renamed in header' })
        .waitFor()
    })

    await check(
      'context-menu rename of a closed session appends session_info to its file',
      async () => {
        await section('Today')
          .locator('[data-session-row]', { hasText: 'Bravo renamed in header' })
          .click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Rename' }).click()
        const input = page.getByRole('textbox', { name: 'Session name' })
        await input.fill('Bravo closed rename')
        await input.press('Enter')
        await waitUntil(
          async () => sessionName(await readSession(secondFile)) === 'Bravo closed rename',
          { label: 'session_info on disk' }
        )
        await assertValidSession(secondFile)
        await section('Today')
          .locator('[data-session-row]', { hasText: 'Bravo closed rename' })
          .waitFor()
        assert.equal(
          (await app.invoke('engine:list')).length,
          1,
          'renaming a closed session starts no engine'
        )
      }
    )

    await check('search matches a closed session by its transcript text', async () => {
      const search = page.getByRole('textbox', { name: 'Search sessions' })
      await search.fill('zeppelin')
      await sidebarRow('Bravo closed rename').waitFor()
      await waitUntil(
        async () => (await page.locator('[data-session-list] [data-session-row]').count()) === 1,
        {
          label: 'only the zeppelin match'
        }
      )
      await search.fill('')
    })

    await check('search matches an open session by its transcript text too', async () => {
      const search = page.getByRole('textbox', { name: 'Search sessions' })
      await search.fill('parser')
      await page.waitForTimeout(300)
      const rows = page.locator('[data-session-list] [data-session-row]', {
        hasText: 'first prompt alpha'
      })
      const found = await rows.count()
      await app.screenshot('lifecycle-search-open-session', { settleMs: 100 })
      await search.fill('')
      assert.equal(found, 1, 'the open session whose reply says "parser" is listed')
    })

    await check(
      'double-click rename of a closed session does not resume it in an engine',
      async () => {
        const engines = (await app.invoke('engine:list')).length
        await section('Today')
          .locator('[data-session-row]', { hasText: 'Bravo closed rename' })
          .dblclick()
        const input = page.getByRole('textbox', { name: 'Session name' })
        await input.waitFor()
        await input.press('Escape')
        await page.waitForTimeout(1500)
        const after = await app.invoke('engine:list')
        const onFile = after.filter(
          (a) => a.sessionFile?.toLowerCase() === secondFile.toLowerCase()
        )
        const known = await Promise.all(onFile.map((engine) => app.agentState(engine.agentId)))
        await app.screenshot('lifecycle-double-click-two-engines', { settleMs: 200 })
        const openRows = await section('Open sessions')
          .locator('[data-session-row]', { hasText: 'Bravo closed rename' })
          .count()
        // Put the list back the way the next checks expect it (Bravo closed): every engine on the file.
        for (const [index, engine] of onFile.entries()) {
          if (known[index]) await closeOpenRow('Bravo closed rename').catch(() => undefined)
          else await app.invoke('engine:dispose', engine.agentId)
        }
        assert.equal(
          after.length,
          engines,
          `engines before/after the double-click; ${onFile.length} engines on the same file, ${known.filter(Boolean).length} known to the renderer, ${openRows} open row(s)`
        )
      }
    )

    // Fixture sessions dated yesterday, 3 days ago and 20 days ago, written while the app runs (watcher).
    const now = new Date()
    const dated = {}
    await step('write dated fixture sessions into the workspace folder', async () => {
      for (const [key, daysAgo, text] of [
        ['yesterday', 1, 'fixture yesterday kiwi'],
        ['week', 3, 'fixture this week mango'],
        ['older', 20, 'fixture older papaya']
      ]) {
        const at = new Date(now)
        at.setDate(now.getDate() - daysAgo)
        at.setHours(FIXTURE_NOON_HOUR, 0, 0, 0)
        const builder = new SessionBuilder({ cwd, startedAt: at.getTime() })
        builder.modelChange()
        builder.user(text)
        builder.assistant(`reply for ${key}`)
        dated[key] = await builder.write(dir)
        await utimes(dated[key], at, at)
      }
    })

    await check('the list watcher picks up new files and groups them by date', async () => {
      await section('Yesterday')
        .locator('[data-session-row]', { hasText: 'fixture yesterday kiwi' })
        .waitFor({ timeout: 10_000 })
      await section('This week')
        .locator('[data-session-row]', { hasText: 'fixture this week mango' })
        .waitFor()
      await section('Older')
        .locator('[data-session-row]', { hasText: 'fixture older papaya' })
        .waitFor()
      await app.screenshot('lifecycle-date-groups', { settleMs: 300 })
    })

    await check('search filters fixtures by transcript text, with a no-match hint', async () => {
      const search = page.getByRole('textbox', { name: 'Search sessions' })
      await search.fill('papaya')
      await section('Older')
        .locator('[data-session-row]', { hasText: 'fixture older papaya' })
        .waitFor()
      await search.fill('nothing-matches-this')
      await page.getByText('No matching sessions').waitFor()
      await search.press('Escape')
      assert.equal(await search.inputValue(), '')
    })

    await check(
      'pin moves a session to Pinned and persists in prefs; unpin moves it back',
      async () => {
        const row = sidebarRow('fixture this week mango')
        await row.hover()
        await row.locator('xpath=..').getByRole('button', { name: 'Pin', exact: true }).click()
        await section('Pinned sessions')
          .locator('[data-session-row]', { hasText: 'fixture this week mango' })
          .waitFor()
        const { prefs } = await app.appState()
        assert.ok(
          prefs.features.sessions.pinned.some((p) => p.toLowerCase() === dated.week.toLowerCase())
        )
        await sidebarRow('fixture this week mango').hover()
        await sidebarRow('fixture this week mango')
          .locator('xpath=..')
          .getByRole('button', { name: 'Unpin' })
          .click()
        await section('This week')
          .locator('[data-session-row]', { hasText: 'fixture this week mango' })
          .waitFor()
      }
    )

    await check(
      'delete from the context menu trashes the file (Recycle Bin) and drops the row',
      async () => {
        await recordTrash(app)
        await sidebarRow('fixture older papaya').click({ button: 'right' })
        await page.getByRole('menuitem', { name: /Delete/ }).click()
        await page.getByRole('dialog').getByText('Delete this session?').waitFor()
        await app.screenshot('lifecycle-delete-confirm', { settleMs: 200 })
        await page.getByRole('button', { name: `Move to ${TRASH_NAME}` }).click()
        await waitUntil(() => !existsSync(dated.older), { label: 'file gone' })
        const trashed = await trashCalls(app)
        assert.equal(trashed.length, 1)
        assert.equal(trashed[0].toLowerCase(), dated.older.toLowerCase())
        await page.getByText(`Moved to the ${TRASH_NAME}`).waitFor()
        await waitUntil(async () => (await sidebarRow('fixture older papaya').count()) === 0, {
          label: 'row removed'
        })
      }
    )

    await check(
      'outside append (session_info) and delete update the list without a reload',
      async () => {
        const session = await readSession(dated.yesterday)
        const leaf = session.entries.at(-1)
        await appendFile(
          dated.yesterday,
          `${JSON.stringify({ type: 'session_info', id: 'aa11bb22', parentId: leaf.id, timestamp: new Date().toISOString(), name: 'Renamed outside' })}\n`
        )
        await sidebarRow('Renamed outside').waitFor({ timeout: 10_000 })
        await rm(dated.week)
        await waitUntil(async () => (await sidebarRow('fixture this week mango').count()) === 0, {
          label: 'deleted file leaves the list',
          timeoutMs: 10_000
        })
      }
    )

    await check(
      'continue a recent session from the empty state (in place, no extra engine)',
      async () => {
        await page.getByRole('button', { name: 'New session', exact: true }).first().click()
        const fresh = await waitUntil(
          async () => {
            const id = await app.activeAgentId()
            const state = id && id !== first ? await app.agentState(id) : null
            return state?.status === 'ready' && state.session ? id : null
          },
          { label: 'fresh agent', timeoutMs: 60_000 }
        )
        const recent = page
          .locator('[data-session-pane]')
          .getByRole('button', { name: /Bravo closed rename/ })
        await recent.waitFor()
        await app.screenshot('lifecycle-empty-state-recent', { settleMs: 300 })
        const enginesBefore = (await app.invoke('engine:list')).length
        await recent.click()
        await page.getByText('Bravo reply mentions zeppelin.').waitFor()
        const state = await app.rpc({ type: 'get_state' }, fresh)
        assert.equal(state.sessionFile.toLowerCase(), secondFile.toLowerCase())
        assert.equal(state.sessionName, 'Bravo closed rename')
        assert.equal((await app.invoke('engine:list')).length, enginesBefore)
        // The continued session takes the next prompt into the same file.
        server.queue(turn.text('Continued reply.'))
        await sendWhenSettled(app, 'third prompt continues bravo')
        await app.waitForSettle()
        const session = await assertValidSession(secondFile)
        assert.deepEqual(userTexts(session), [
          'second prompt bravo',
          'third prompt continues bravo'
        ])
      }
    )

    await check('ephemeral session writes no file and says "not saved"', async () => {
      const before = await listJsonl(agentDir.path('sessions'))
      await page.getByRole('button', { name: 'More ways to start' }).click()
      await page.getByRole('menuitem', { name: 'New ephemeral session' }).click()
      const ephemeral = await waitUntil(
        async () => {
          const id = await app.activeAgentId()
          const state = id ? await app.agentState(id) : null
          return state?.status === 'ready' && state.info.args.noSession ? id : null
        },
        { label: 'ephemeral agent', timeoutMs: 60_000 }
      )
      server.queue(turn.text('Ephemeral reply.'))
      await sendWhenSettled(app, 'ephemeral prompt')
      await app.waitForSettle()
      const state = await app.rpc({ type: 'get_state' }, ephemeral)
      assert.equal(state.sessionFile, undefined)
      assert.deepEqual(await listJsonl(agentDir.path('sessions')), before)
      await section('Open sessions')
        .locator('[data-session-row]', { hasText: 'ephemeral prompt' })
        .filter({ hasText: 'not saved' })
        .waitFor()
      await app.screenshot('lifecycle-ephemeral', { settleMs: 300 })
    })

    await check('every session file is valid against session-format.md', async () => {
      const sessions = await assertAllValid(agentDir.path('sessions'))
      assert.ok(sessions.length >= 3)
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
