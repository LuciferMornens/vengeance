// settings.json edited outside Vengeance while it runs, invalid JSON on disk, and the Raw JSON editor
// (validation, diff review, save). The app must follow the file, never crash and never overwrite a file
// it cannot parse.
//
//   node scripts/qa/settings/external-raw.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  closeSettings,
  dismissToasts,
  LAUNCH,
  newSessionIn,
  openSettings,
  readJsonOrNull,
  restartFromEngineSection,
  setScope,
  setSwitch,
  settingRow,
  softSteps,
  toastWith,
  waitFor
} from './settings-ui.mjs'

const BASE = { defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODELS.reasoning }
const BROKEN = '{\n  "defaultProvider": "qa",\n  "steeringMode": "all",\n'

const checkedRadio = (app, key) => settingRow(app, key).locator('[role=radio][aria-checked=true]')

await runSuite(
  'settings-external-raw',
  async (context) => {
    const { agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-external-raw')
    const settingsPath = agentDir.path('settings.json')
    const writeExternal = (data) =>
      writeFile(
        settingsPath,
        typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`
      )
    let agentId
    let cwd

    await step('open a session and Settings → Agent behavior', async () => {
      ;({ agentId, cwd } = await app.openWorkspace())
      await openSettings(app, 'Agent behavior')
      assert.equal(await checkedRadio(app, 'steeringMode').innerText(), 'One at a time')
    })

    await step('an external edit shows up in the open sheet without reopening it', async () => {
      await writeExternal({ ...BASE, steeringMode: 'all', retry: { maxRetries: 7 } })
      await waitFor(
        async () => (await checkedRadio(app, 'steeringMode').innerText()) === 'All at once',
        'steering radio follows the file'
      )
      await waitFor(
        async () =>
          (await settingRow(app, 'retry.maxRetries').locator('input').inputValue()) === '7',
        'max retries follows the file'
      )
    })

    await step(
      'a live setting edited on disk reaches the open engine (or a restart is offered)',
      async () => {
        await app.page.waitForTimeout(1500)
        const live = (await app.rpc({ type: 'get_state' })).steeringMode
        const offered = await toastWith(app, 'Restart').isVisible()
        // settings-4: an outside edit applies live settings to open engines and offers a restart for the rest.
        assert.ok(live === 'all' || offered, `engine steeringMode=${live}, no restart offered`)
      }
    )

    await step(
      '"Restart engines" (Engine section) applies the edited file to the open session',
      async () => {
        await restartFromEngineSection(app, agentId)
        assert.equal((await app.rpc({ type: 'get_state' }, agentId)).steeringMode, 'all')
      }
    )

    await step(
      'an external edit right after a Vengeance write still reaches the sheet',
      async () => {
        await openSettings(app, 'Agent behavior')
        await setSwitch(app, 'branchSummary.skipPrompt', true)
        await waitFor(
          async () => (await readJsonOrNull(settingsPath))?.branchSummary?.skipPrompt === true,
          'own write'
        )
        await app.page.waitForTimeout(400)
        const current = await readJsonOrNull(settingsPath)
        await writeExternal({ ...current, retry: { maxRetries: 9 } })
        await app.page.waitForTimeout(3000)
        // settings-8: inside the watcher's self-write window, content that differs from Vengeance's own
        // write still counts as an outside edit.
        assert.equal(await settingRow(app, 'retry.maxRetries').locator('input').inputValue(), '9')
      }
    )

    await step('invalid JSON on disk: the sheet warns, nothing crashes', async () => {
      await writeExternal(BROKEN)
      await openSettings(app, 'Agent behavior')
      await app.page.waitForTimeout(1200)
      await app.screenshot('settings-invalid-json-section')
      // settings-5: the sheet says settings.json is broken instead of silently showing defaults.
      await app.page
        .getByText(/settings\.json.*(invalid|not valid|could not)/i)
        .first()
        .waitFor({ timeout: 3000 })
    })

    await step(
      'invalid JSON on disk: a UI change is refused and the file is left byte-for-byte',
      async () => {
        await dismissToasts(app)
        await openSettings(app, 'Agent behavior')
        await settingRow(app, 'compaction.enabled').getByRole('switch').click()
        const refused = toastWith(app, 'Setting not saved')
        await refused.waitFor()
        assert.match(await refused.innerText(), /Fix it in Raw JSON first/)
        assert.equal(await readFile(settingsPath, 'utf8'), BROKEN)
        await waitFor(
          async () =>
            (await settingRow(app, 'compaction.enabled')
              .getByRole('switch')
              .getAttribute('aria-checked')) === 'true',
          'switch snaps back to the file value'
        )
      }
    )

    await step(
      'invalid JSON on disk: a new session still starts (Engine falls back to defaults)',
      async () => {
        await closeSettings(app)
        const fresh = await newSessionIn(app, cwd)
        const state = await app.rpc({ type: 'get_state' }, fresh)
        assert.equal(state.steeringMode, 'one-at-a-time')
        assert.equal(
          await readFile(settingsPath, 'utf8'),
          BROKEN,
          'the Engine did not rewrite it either'
        )
      }
    )

    await step(
      'Raw JSON shows the broken text with its parse error and blocks saving',
      async () => {
        await openSettings(app, 'Raw JSON')
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        assert.equal(await editor.inputValue(), BROKEN)
        await app.page.getByText(/error.*fix before saving/).waitFor()
        assert.equal(
          await app.page.getByRole('button', { name: 'Review & save' }).isDisabled(),
          true
        )
        await app.screenshot('settings-raw-invalid')
      }
    )

    await step(
      'Raw JSON validation: a wrong type is an error, an unknown key is info only',
      async () => {
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        await editor.fill(
          JSON.stringify({ ...BASE, retry: { maxRetries: 'x' }, qaUnknownKey: 1 }, null, 2)
        )
        await app.page.getByText('retry.maxRetries must be a number.').waitFor()
        await app.page
          .getByText('qaUnknownKey is not a known engine setting; it will be preserved.')
          .waitFor()
        assert.equal(
          await app.page.getByRole('button', { name: 'Review & save' }).isDisabled(),
          true
        )
      }
    )

    await step(
      'Raw JSON fixes the broken file: Review & save writes the reviewed JSON',
      async () => {
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        const next = { ...BASE, steeringMode: 'all', retry: { maxRetries: 2 }, qaUnknownKey: 1 }
        await editor.fill(JSON.stringify(next, null, 2))
        await app.page.getByText('Unsaved changes.').waitFor()
        await dismissToasts(app)
        await app.page.getByRole('button', { name: 'Review & save' }).click()
        const dialog = app.page.getByRole('dialog', { name: 'Review changes' })
        await dialog.getByText('"qaUnknownKey"').first().waitFor()
        await app.screenshot('settings-raw-diff')
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        const outcome = toastWith(app, /settings\.json saved|^Not saved/)
        await outcome.first().waitFor()
        const text = await outcome.first().innerText()
        await app.screenshot('settings-raw-save-over-broken')
        if (await dialog.isVisible())
          await dialog.getByRole('button', { name: 'Keep editing' }).click()
        // settings-7: Raw JSON saves its validated text even over a file that no longer parses.
        assert.match(text, /settings\.json saved/, text)
        assert.deepEqual(await readJsonOrNull(settingsPath), next)
      }
    )

    await step(
      'Raw JSON over a valid file: the diff is reviewed and exactly that JSON is written',
      async () => {
        await writeExternal(BASE)
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        await waitFor(
          async () => (await editor.inputValue()).includes('qa-reasoning'),
          'editor shows the file'
        )
        await app.page
          .getByRole('button', { name: 'Revert' })
          .click()
          .catch(() => undefined)
        const next = { ...BASE, steeringMode: 'all', retry: { maxRetries: 2 }, qaUnknownKey: 1 }
        await editor.fill(JSON.stringify(next, null, 2))
        await dismissToasts(app)
        await app.page.getByRole('button', { name: 'Review & save' }).click()
        const dialog = app.page.getByRole('dialog', { name: 'Review changes' })
        await dialog.getByText('"qaUnknownKey"').first().waitFor()
        await dialog.getByRole('button', { name: 'Save', exact: true }).click()
        await toastWith(app, 'settings.json saved').waitFor()
        await dialog.waitFor({ state: 'detached' })
        assert.equal(
          await readFile(settingsPath, 'utf8'),
          `${JSON.stringify(next, null, 2)}
`
        )
        await toastWith(app, 'Restart to apply').waitFor()
      }
    )

    await step(
      'Raw JSON (project scope) warns that a global-only key is ignored there',
      async () => {
        await setScope(app, 'project')
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        await editor.fill(JSON.stringify({ defaultProjectTrust: 'always' }, null, 2))
        await app.page
          .getByText(
            'defaultProjectTrust is only read from global settings; the project value is ignored.'
          )
          .waitFor()
        await app.page.getByRole('button', { name: 'Revert' }).click()
        await setScope(app, 'global')
      }
    )

    await step(
      'an external edit while Raw JSON has unsaved edits keeps the user’s buffer',
      async () => {
        const editor = app.page.getByRole('textbox', { name: 'settings.json' })
        const typed = JSON.stringify({ ...BASE, steeringMode: 'all', qaTyping: 'unsaved' }, null, 2)
        // Past the watcher's 1.5 s self-write mute window of the previous save.
        await app.page.waitForTimeout(2000)
        await editor.fill(typed)
        await app.page.getByText('Unsaved changes.').waitFor()
        await writeExternal({ ...BASE, followUpMode: 'all' })
        await app.page.waitForTimeout(2000)
        await app.screenshot('settings-raw-external-while-dirty')
        // settings-6: unsaved typing survives an outside edit; Raw JSON offers Reload / Keep mine.
        await app.page.getByText('Changed on disk').waitFor()
        assert.equal(await editor.inputValue(), typed)
      }
    )

    finish()
  },
  { launch: LAUNCH }
)
