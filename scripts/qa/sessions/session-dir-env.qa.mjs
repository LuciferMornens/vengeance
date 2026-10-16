// `PI_CODING_AGENT_SESSION_DIR` (environment-variables.md) overrides the sessionDir setting: sessions are written
// there, the sidebar lists that folder, and Settings shows the setting as overridden by the environment.
//
//   node scripts/qa/sessions/session-dir-env.qa.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import { createChecks, sendWhenSettled, SHOTS_DIR } from './lib/checks.mjs'
import { assertAllValid, assertValidSession, SessionBuilder } from './lib/session-files.mjs'

const envDir = await mkdtemp(join(tmpdir(), 'vengeance-qa-env-sessions-'))
const UNUSED_DIR = join(envDir, '..', `${basename(envDir)}-unused`)

try {
  await runSuite(
    'sessions-session-dir-env',
    async ({ server, app, step }) => {
      const { check, finish } = createChecks(step, () => app, 'session-dir-env')
      const page = app.page
      const { cwd } = await step(
        'open a workspace (settings.json sessionDir points elsewhere)',
        () => app.openWorkspace()
      )

      await check(
        'a new session is written into the env folder, not the settings folder',
        async () => {
          server.queue(turn.text('env folder answer'))
          await sendWhenSettled(app, 'env folder prompt')
          await app.waitForSettle()
          const file = (await app.rpc({ type: 'get_state' })).sessionFile
          assert.equal(resolve(dirname(file)).toLowerCase(), resolve(envDir).toLowerCase())
          await assertValidSession(file)
        }
      )

      await check('the sidebar lists and watches the env folder', async () => {
        const builder = new SessionBuilder({ cwd })
        builder.user('fixture in the env folder')
        builder.assistant('fixture reply')
        await builder.write(envDir)
        await page
          .locator('[data-session-row]', { hasText: 'fixture in the env folder' })
          .waitFor({ timeout: 10_000 })
      })

      // sessions-9: the row shows the folder the environment sets (not the settings.json value) and is locked.
      await check(
        'Settings shows the session directory as overridden by the environment',
        async () => {
          await page.getByRole('button', { name: 'Settings', exact: true }).click()
          await page
            .getByRole('button', { name: /Sessions & context/ })
            .first()
            .click()
          const row = page.locator('#setting-sessionDir')
          await row.waitFor()
          await app.screenshot('session-dir-env-settings', { settleMs: 300 })
          const text = await row.innerText()
          const shown = await row.locator('input').inputValue()
          const locked = await row.locator('input').isDisabled()
          await page.keyboard.press('Escape')
          assert.ok(locked, 'the field is locked while the environment sets it')
          // The static description mentions "An environment variable can override it"; ask for the actual state.
          assert.ok(
            shown === envDir || /overridden|PI_CODING_AGENT_SESSION_DIR/i.test(text),
            `row shows ${shown} with no override note`
          )
        }
      )

      await check('every session file is valid and the settings folder stays unused', async () => {
        await assertAllValid(envDir)
        assert.ok(!existsSync(UNUSED_DIR), 'settings sessionDir not created')
      })

      finish()
    },
    {
      launch: { outDir: SHOTS_DIR, env: { PI_CODING_AGENT_SESSION_DIR: envDir } },
      agentDir: { settings: { sessionDir: UNUSED_DIR } }
    }
  )
} finally {
  await rm(envDir, { recursive: true, force: true })
}
