// Extension UI over RPC (rpc-extension-ui.md): every dialog and fire-and-forget method of the QA
// fixture extension, driven from the real composer, answered through the real dialogs, and proven
// on the extension side through its log file.
//
//   node scripts/qa/ext/extension-ui.qa.mjs
import assert from 'node:assert/strict'
import { DOCUMENT_END_KEY } from '../lib/platform.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  bugSteps,
  extLogLength,
  fixtureExtensionFiles,
  readExtLog,
  reportShot,
  submitComposer,
  until,
  waitForExtLog
} from './lib/ext-helpers.mjs'

await runSuite(
  'ext-extension-ui',
  async ({ agentDir, app, step }) => {
    const { page } = app
    const { bugStep, finish } = bugSteps(step)
    const dialog = (name) => page.getByRole('dialog', { name })
    const composer = page.getByRole('textbox', { name: 'Message' })
    const pendingDialogs = async () => (await app.agentState()).ext.dialogs.length
    /** Run a fixture command and return the log offset to wait from. */
    const command = async (text) => {
      const from = extLogLength(agentDir)
      await submitComposer(app, text)
      return from
    }

    await step('fixture loads in RPC mode with its commands', async () => {
      await app.openWorkspace()
      const start = await waitForExtLog(agentDir, 'session_start')
      assert.equal(start.mode, 'rpc')
      assert.equal(start.hasUI, true)
      const names = (await app.agentState()).commands.map((c) => c.name)
      for (const name of ['qa-select', 'qa-confirm', 'qa-input', 'qa-editor', 'qa-notify']) {
        assert.ok(names.includes(name), `${name} listed by get_commands`)
      }
    })

    await step('slash menu lists extension commands with their descriptions', async () => {
      await composer.fill('/qa-sel')
      await page.getByText('QA: select dialog (arg: timeout ms)').waitFor()
      await reportShot(app, 'ext-ui-slash-menu')
      await composer.fill('')
    })

    await step('select: clicking an option returns it to the extension', async () => {
      const from = await command('/qa-select')
      await dialog('QA pick a fruit').waitFor()
      await reportShot(app, 'ext-ui-select')
      await dialog('QA pick a fruit').getByRole('option', { name: 'Banana' }).click()
      const entry = await waitForExtLog(agentDir, 'select', { from })
      assert.equal(entry.value, 'Banana')
      await dialog('QA pick a fruit').waitFor({ state: 'detached' })
      assert.equal(await pendingDialogs(), 0)
    })

    await step('select: number key quick-picks the third option', async () => {
      const from = await command('/qa-select')
      await dialog('QA pick a fruit').waitFor()
      await page.keyboard.press('3')
      assert.equal((await waitForExtLog(agentDir, 'select', { from })).value, 'Cherry')
    })

    await step('select: Escape cancels (extension receives undefined)', async () => {
      const from = await command('/qa-select')
      await dialog('QA pick a fruit').waitFor()
      await page.keyboard.press('Escape')
      assert.equal((await waitForExtLog(agentDir, 'select', { from })).value, null)
      await dialog('QA pick a fruit').waitFor({ state: 'detached' })
    })

    await step('select: long lists get a filter; Enter picks the match', async () => {
      const from = await command('/qa-select-many')
      await dialog('QA pick one of many').waitFor()
      await page.getByPlaceholder('Filter 12 options…').fill('11')
      await page.keyboard.press('Enter')
      assert.equal((await waitForExtLog(agentDir, 'select_many', { from })).value, 'Option 11')
    })

    await step(
      'select with timeout: countdown shows, engine default wins, dialog closes',
      async () => {
        const from = await command('/qa-select 1500')
        await dialog('QA pick a fruit').waitFor()
        await page.getByRole('timer').waitFor()
        await reportShot(app, 'ext-ui-select-timeout')
        const entry = await waitForExtLog(agentDir, 'select', { from })
        assert.equal(entry.value, null, 'timeout resolves undefined')
        await dialog('QA pick a fruit').waitFor({ state: 'detached', timeout: 3000 })
        await page.getByText('Request timed out').first().waitFor()
        assert.equal(await pendingDialogs(), 0)
      }
    )

    await step('confirm: Yes, the n key and Escape map to true / false / false', async () => {
      let from = await command('/qa-confirm')
      await dialog('QA proceed?').waitFor()
      await page.getByText('The fixture wants a').waitFor()
      await reportShot(app, 'ext-ui-confirm')
      await dialog('QA proceed?').getByRole('button', { name: 'Yes' }).click()
      assert.equal((await waitForExtLog(agentDir, 'confirm', { from })).confirmed, true)

      from = await command('/qa-confirm')
      await dialog('QA proceed?').waitFor()
      await page.keyboard.press('n')
      assert.equal((await waitForExtLog(agentDir, 'confirm', { from })).confirmed, false)

      from = await command('/qa-confirm')
      await dialog('QA proceed?').waitFor()
      await page.keyboard.press('Escape')
      assert.equal((await waitForExtLog(agentDir, 'confirm', { from })).confirmed, false)
    })

    await step('confirm with timeout resolves false and closes', async () => {
      const from = await command('/qa-confirm 1200')
      await dialog('QA proceed?').waitFor()
      assert.equal((await waitForExtLog(agentDir, 'confirm', { from })).confirmed, false)
      await dialog('QA proceed?').waitFor({ state: 'detached', timeout: 3000 })
    })

    await step(
      'input: placeholder shown, typed value returned; Cancel returns undefined',
      async () => {
        let from = await command('/qa-input')
        await dialog('QA your codename').waitFor()
        const field = dialog('QA your codename').getByPlaceholder('e.g. falcon')
        await field.fill('falcon')
        await reportShot(app, 'ext-ui-input')
        await field.press('Enter')
        assert.equal((await waitForExtLog(agentDir, 'input_dialog', { from })).value, 'falcon')

        from = await command('/qa-input')
        await dialog('QA your codename').waitFor()
        await dialog('QA your codename').getByRole('button', { name: 'Cancel' }).click()
        assert.equal((await waitForExtLog(agentDir, 'input_dialog', { from })).value, null)
      }
    )

    await step('input with timeout resolves undefined and closes', async () => {
      const from = await command('/qa-input 1200')
      await dialog('QA your codename').waitFor()
      assert.equal((await waitForExtLog(agentDir, 'input_dialog', { from })).value, null)
      await dialog('QA your codename').waitFor({ state: 'detached', timeout: 3000 })
    })

    await step('editor: prefill shown, Ctrl+Enter saves the edited text', async () => {
      const from = await command('/qa-editor')
      await dialog('QA edit the notes').waitFor()
      const area = dialog('QA edit the notes').locator('textarea')
      assert.equal(await area.inputValue(), 'first line\nsecond line')
      await area.press('End')
      await area.press(DOCUMENT_END_KEY)
      await area.pressSequentially('\nthird line')
      await reportShot(app, 'ext-ui-editor')
      await area.press('ControlOrMeta+Enter')
      const entry = await waitForExtLog(agentDir, 'editor', { from })
      assert.equal(entry.value, 'first line\nsecond line\nthird line')
    })

    await step(
      'editor: Escape on unsaved changes asks again, the second Escape cancels',
      async () => {
        const from = await command('/qa-editor')
        await dialog('QA edit the notes').waitFor()
        const area = dialog('QA edit the notes').locator('textarea')
        await area.press(DOCUMENT_END_KEY)
        await area.pressSequentially(' changed')
        await page.keyboard.press('Escape')
        await page.getByText('again to discard changes').waitFor()
        assert.equal(await pendingDialogs(), 1, 'first Escape keeps the editor open')
        await page.keyboard.press('Escape')
        assert.equal((await waitForExtLog(agentDir, 'editor', { from })).value, null)
      }
    )

    await step('notify: info, warning and error toasts', async () => {
      const from = await command('/qa-notify')
      await waitForExtLog(agentDir, 'notify', { from })
      for (const text of ['QA info notice', 'QA warning notice', 'QA error notice']) {
        await page.locator('[data-toaster]').getByText(text).waitFor()
      }
      await page.locator('[data-toaster] [role="alert"]', { hasText: 'QA error notice' }).waitFor()
      await reportShot(app, 'ext-ui-notify')
    })

    await step('setStatus: chip above the composer, cleared by undefined', async () => {
      let from = await command('/qa-status')
      await waitForExtLog(agentDir, 'status', { from })
      await page.getByText('QA status ready').first().waitFor()
      from = await command('/qa-status clear')
      await waitForExtLog(agentDir, 'status', { from })
      await until(async () => (await page.getByText('QA status ready').count()) === 0, {
        label: 'status chip removed'
      })
      assert.deepEqual((await app.agentState()).ext.statuses, {})
    })

    await step('setWidget: above and below the editor, string widgets only, cleared', async () => {
      let from = await command('/qa-widget')
      await waitForExtLog(agentDir, 'widget', { from })
      const above = page.locator('[data-widget="qa-above"]')
      const below = page.locator('[data-widget="qa-below"]')
      await above.getByText('QA widget above line 2').waitFor()
      await below.getByText('QA widget below the editor').waitFor()
      const composerBox = await page.locator('[data-composer]').boundingBox()
      const aboveBox = await above.boundingBox()
      const belowBox = await below.boundingBox()
      assert.ok(aboveBox.y + aboveBox.height <= composerBox.y + 1, 'above widget sits above')
      assert.ok(belowBox.y >= composerBox.y + composerBox.height - 1, 'below widget sits below')
      assert.equal(await page.locator('[data-widget="qa-component"]').count(), 0)
      await reportShot(app, 'ext-ui-status-widgets')
      from = await command('/qa-widget clear')
      await waitForExtLog(agentDir, 'widget', { from })
      await above.waitFor({ state: 'detached' })
      await below.waitFor({ state: 'detached' })
    })

    await step('setTitle: session header and sidebar show the extension title', async () => {
      const from = await command('/qa-title QA Fixture Title')
      await waitForExtLog(agentDir, 'title', { from })
      await page.locator('header, main').getByText('QA Fixture Title').first().waitFor()
      assert.equal((await app.agentState()).ext.title, 'QA Fixture Title')
    })

    await step('set_editor_text and pasteToEditor replace the composer text', async () => {
      let from = await command('/qa-prefill QA prefilled text')
      await waitForExtLog(agentDir, 'prefill', { from })
      await until(async () => (await composer.inputValue()) === 'QA prefilled text', {
        label: 'composer prefilled'
      })
      from = await command('/qa-paste QA pasted text')
      await waitForExtLog(agentDir, 'paste', { from })
      await until(async () => (await composer.inputValue()) === 'QA pasted text', {
        label: 'composer pasted'
      })
      await composer.fill('')
    })

    await step('custom message from sendMessage renders in the transcript', async () => {
      const from = await command('/qa-message')
      await waitForExtLog(agentDir, 'message', { from })
      await page.getByText('QA custom message body').waitFor()
    })

    await step('terminal-only methods degrade as documented (custom → undefined)', async () => {
      const from = await command('/qa-terminal-only')
      const entry = await waitForExtLog(agentDir, 'terminal_only', { from })
      assert.equal(entry.custom, 'undefined')
      assert.equal(entry.editorText, '', 'getEditorText() cannot see the composer in RPC mode')
      assert.equal(entry.setTheme.success, false)
      app.assertNoErrors()
    })

    await step('command arguments reach the handler (no completion menu over RPC)', async () => {
      const from = await command('/qa-complete beta')
      assert.equal((await waitForExtLog(agentDir, 'complete', { from })).args, 'beta')
    })

    await step(
      'dialog from a background session: toast with "Open session", then answer',
      async () => {
        const first = await app.activeAgentId()
        const from = await command('/qa-later 6000')
        // app.openWorkspace() waits for a single composer; a second session mounts another one.
        await app.test('openWorkspace', await app.createWorkspace())
        assert.notEqual(await app.activeAgentId(), first)
        const toast = page.locator('[data-toaster]').getByText('needs your input')
        await toast.waitFor({ timeout: 15_000 })
        await reportShot(app, 'ext-ui-background-dialog')
        await page.locator('[data-toaster]').getByRole('button', { name: 'Open session' }).click()
        assert.equal(await app.activeAgentId(), first)
        await dialog('QA late question').waitFor()
        await dialog('QA late question').getByRole('option', { name: 'Later no' }).click()
        assert.equal((await waitForExtLog(agentDir, 'later', { from })).value, 'Later no')
      }
    )

    await bugStep('a throwing command tells the user it failed', async () => {
      await command('/qa-throw')
      await until(async () => (await app.agentState()).extensionErrors.length > 0, {
        label: 'extension_error event'
      })
      const error = (await app.agentState()).extensionErrors.at(-1)
      assert.equal(error.event, 'command')
      await reportShot(app, 'ext-ui-command-error')
      const visible = await page
        .getByText('QA fixture command exploded')
        .first()
        .isVisible()
        .catch(() => false)
      assert.ok(visible, 'the failure is visible without opening the inspector')
    })

    await bugStep('a dialog withdrawn by its AbortSignal closes in the app', async () => {
      const from = await command('/qa-signal')
      await dialog('QA signal-bound question').waitFor()
      assert.equal((await waitForExtLog(agentDir, 'signal', { from })).confirmed, false)
      await page.waitForTimeout(500)
      await reportShot(app, 'ext-ui-signal-stale-dialog')
      await until(async () => (await pendingDialogs()) === 0, {
        timeoutMs: 3000,
        label: 'the withdrawn dialog to close'
      })
    })

    assert.ok(readExtLog(agentDir).length > 0)
    finish()
  },
  { agentDir: { files: fixtureExtensionFiles() } }
)
