// Session storage: the `sessionDir` setting edited in Settings → Sessions & context (global), where the Engine
// then writes sessions, the sidebar listing and watcher on that folder, file operations there, and a project
// `.pi/settings.json` sessionDir (project-local sessions, trusted folder).
//
//   node scripts/qa/sessions/storage.qa.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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
  assertAllValid,
  assertValidSession,
  listJsonl,
  readSession,
  SessionBuilder,
  sessionName
} from './lib/session-files.mjs'

await runSuite(
  'sessions-storage',
  async ({ server, agentDir, app, step }) => {
    const { check, finish } = createChecks(step, () => app, 'storage')
    const page = app.page
    const customDir = agentDir.path('../custom-sessions')
    const { cwd } = await step('open a workspace with one default-folder session', async () => {
      const opened = await app.openWorkspace()
      server.queue(turn.text('default folder answer'))
      await sendWhenSettled(app, 'default folder prompt')
      await app.waitForSettle()
      return opened
    })

    await check(
      'Settings → Sessions & context → Session directory writes sessionDir to settings.json',
      async () => {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page
          .getByRole('button', { name: /Sessions & context/ })
          .first()
          .click()
        const input = page.locator('#setting-sessionDir input')
        await input.waitFor()
        await app.screenshot('storage-settings-session-dir', { settleMs: 300 })
        await input.fill(customDir)
        await input.press('Enter')
        await waitUntil(
          async () => (await agentDir.readJson('settings.json')).sessionDir === customDir,
          { label: 'sessionDir saved' }
        )
        await page.keyboard.press('Escape')
      }
    )

    let customFile
    let projectAgent
    await check('a new session is written into the custom folder', async () => {
      await page.getByRole('button', { name: 'New session', exact: true }).first().click()
      const second = await waitUntil(
        async () => {
          const list = await app.invoke('engine:list')
          const id = await app.activeAgentId()
          return list.length === 2 && id === list[1].agentId && (await app.agentState(id))?.session
            ? id
            : null
        },
        { label: 'second engine active', timeoutMs: 60_000 }
      )
      server.queue(turn.text('custom folder answer'))
      await sendWhenSettled(app, 'custom folder prompt')
      await app.waitForSettle()
      customFile = (await app.rpc({ type: 'get_state' }, second)).sessionFile
      assert.equal(resolve(dirname(customFile)).toLowerCase(), resolve(customDir).toLowerCase())
      const session = await assertValidSession(customFile)
      assert.equal(session.header.cwd, cwd)
    })

    await check('the sidebar lists the custom folder and watches it', async () => {
      const row = page.locator('[data-session-row]', { hasText: 'custom folder prompt' })
      await row.first().waitFor()
      const builder = new SessionBuilder({ cwd })
      builder.user('fixture dropped into the custom folder')
      builder.assistant('fixture reply')
      await builder.write(customDir)
      await page
        .locator('[data-session-row]', { hasText: 'fixture dropped into the custom folder' })
        .waitFor({ timeout: 10_000 })
      await app.screenshot('storage-custom-list', { settleMs: 200 })
    })

    await check(
      'a closed session in the custom folder can be renamed (file operations allowed there)',
      async () => {
        const row = page
          .locator('[data-session-row]', { hasText: 'fixture dropped into the custom folder' })
          .first()
        await row.click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Rename' }).click()
        const input = page.getByRole('textbox', { name: 'Session name' })
        await input.fill('Renamed in custom folder')
        await input.press('Enter')
        const [fixture] = (await listJsonl(customDir)).filter((path) => path !== customFile)
        await waitUntil(
          async () => sessionName(await readSession(fixture)) === 'Renamed in custom folder',
          { label: 'renamed on disk' }
        )
      }
    )

    await check(
      'project .pi/settings.json sessionDir keeps sessions inside the project',
      async () => {
        const project = await app.createWorkspace({
          'README.md': '# Project\n',
          '.pi/settings.json': { sessionDir: '.project-sessions' }
        })
        const agentId = await app.test('openWorkspace', project, { approve: true })
        await waitUntil(async () => (await app.agentState(agentId))?.session, {
          label: 'project agent',
          timeoutMs: 60_000
        })
        server.queue(turn.text('project answer'))
        await sendWhenSettled(app, 'project local prompt')
        await app.waitForSettle()
        const reported = (await app.rpc({ type: 'get_state' }, agentId)).sessionFile
        const [written] = await listJsonl(join(project, '.project-sessions'))
        assert.ok(written, 'the Engine writes the session inside the project')
        await assertValidSession(written)
        projectAgent = { agentId, project, reported, written }
        await page
          .locator('[data-session-row]', { hasText: 'project local prompt' })
          .first()
          .waitFor()
      }
    )

    // A relative sessionDir makes the Engine report a relative sessionFile; the app must still track the real file.
    await check('the app knows the project-local session file by its real path', async () => {
      const { agentId, project, reported, written } = projectAgent
      const info = (await app.invoke('engine:list')).find((engine) => engine.agentId === agentId)
      const known = (await app.agentState(agentId)).session?.sessionFile ?? info.sessionFile
      await app.screenshot('storage-project-local', { settleMs: 200 })
      const rows = await page
        .locator('[data-session-row]', { hasText: 'project local prompt' })
        .count()
      assert.equal(rows, 1, `one row for the open session (reported path ${reported})`)
      assert.equal(resolve(project, known).toLowerCase(), written.toLowerCase())
      assert.ok(isAbsolute(known), `session path is absolute: ${known}`)
    })

    await check('/export works for the project-local session', async () => {
      const target = agentDir.path('../project-export.jsonl')
      await runComposerCommand(app, `/export ${target}`)
      const outcome = await waitUntil(
        async () =>
          existsSync(target)
            ? 'written'
            : (await page.getByText('Could not export the session').count())
              ? 'error'
              : null,
        { label: 'export outcome', timeoutMs: 10_000 }
      )
      if (outcome === 'error')
        await app.screenshot('storage-project-export-error', { settleMs: 100 })
      assert.equal(outcome, 'written')
      await assertValidSession(target)
    })

    await check('every session file in every folder is valid', async () => {
      await assertAllValid(customDir)
      await assertAllValid(agentDir.path('sessions'))
      assert.ok(existsSync(customDir))
    })

    finish()
  },
  { launch: { outDir: SHOTS_DIR } }
)
