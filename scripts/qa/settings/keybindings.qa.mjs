// Settings → Terminal keys (keybindings.json): key capture writes the exact file, the Engine's own
// loader (KeybindingsManager.create) resolves the same keys, conflicts are surfaced, external edits
// and legacy names are handled, and an unreadable file blocks writes without being overwritten.
//
//   node scripts/qa/settings/keybindings.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { runSuite } from '../lib/suite.mjs'
import { importEngine } from './engine-sdk.mjs'
import {
  dismissToasts,
  LAUNCH,
  openSettings,
  readJsonOrNull,
  settingRow,
  settingsOpen,
  softSteps,
  toastWith,
  waitFor
} from './settings-ui.mjs'

const { KeybindingsManager, KEYBINDINGS } = await importEngine('core/keybindings.js')

const NEW_SESSION = 'app.session.new'
const TREE = 'app.session.tree'
const FORK = 'app.session.fork'
const MODEL_SELECT = 'app.model.select'
const RESUME = 'app.session.resume'
const DEQUEUE = 'app.message.dequeue'
const MODEL_SELECT_DEFAULT = KEYBINDINGS[MODEL_SELECT].defaultKeys

const keyRow = (app, id) => settingRow(app, `keybinding.${id}`)

/** Click "+" on an action row and press `chord` (Playwright syntax) into the key capture. */
async function captureKey(app, id, chord) {
  const description = KEYBINDINGS[id].description
  await keyRow(app, id)
    .getByRole('button', { name: `Add a key for ${description}` })
    .click()
  const capture = keyRow(app, id).getByRole('textbox', { name: 'Press a key combination' })
  await capture.waitFor()
  await app.page.keyboard.press(chord)
  await capture.waitFor({ state: 'detached' })
}

/** Wait until keybindings.json maps action `id` (ids contain dots, so no dotted-path lookup). */
function waitForBinding(file, id, expected) {
  const want = JSON.stringify(expected)
  return waitFor(
    async () => JSON.stringify(((await readJsonOrNull(file)) ?? {})[id]) === want,
    `keybindings.json ${id} = ${want}`
  )
}

/** An edit from outside the app, a moment after the last Vengeance write. */
async function writeExternally(app, file, text) {
  await app.page.waitForTimeout(2000)
  await writeFile(file, text)
}

/** The Engine's view of the temp agent dir's keybindings.json. */
const engineKeys = (agentDir) => KeybindingsManager.create(agentDir.dir)

await runSuite(
  'settings-keybindings',
  async (context) => {
    const { agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-keybindings')
    const file = agentDir.path('keybindings.json')
    const readFileJson = () => readJsonOrNull(file)

    await step('Terminal keys lists every Engine action with its defaults', async () => {
      await app.openWorkspace()
      await openSettings(app, 'Terminal keys')
      await app.page.getByText('All defaults').waitFor()
      const rows = await app.page.locator('[id^="setting-keybinding."]').count()
      assert.equal(rows, Object.keys(KEYBINDINGS).length)
      await keyRow(app, NEW_SESSION).getByText('Unassigned').waitFor()
      await keyRow(app, MODEL_SELECT).getByTitle(MODEL_SELECT_DEFAULT).waitFor()
      assert.equal(await readFileJson(), null, 'nothing written before a change')
    })

    await step('capturing Alt+Shift+N writes one string and the Engine resolves it', async () => {
      await captureKey(app, NEW_SESSION, 'Alt+Shift+KeyN')
      await waitForBinding(file, NEW_SESSION, 'shift+alt+n')
      assert.deepEqual(await readFileJson(), { [NEW_SESSION]: 'shift+alt+n' })
      await keyRow(app, NEW_SESSION).getByText('Custom', { exact: true }).waitFor()
      await app.page.getByText('1 customized').waitFor()
      assert.deepEqual(engineKeys(agentDir).getKeys(NEW_SESSION), ['shift+alt+n'])
    })

    await step('a second key turns the value into a list', async () => {
      await captureKey(app, NEW_SESSION, 'Alt+Shift+KeyM')
      await waitForBinding(file, NEW_SESSION, ['shift+alt+n', 'shift+alt+m'])
      assert.deepEqual(engineKeys(agentDir).getKeys(NEW_SESSION), ['shift+alt+n', 'shift+alt+m'])
    })

    await step('Escape cancels the capture without writing', async () => {
      const before = await readFile(file, 'utf8')
      await keyRow(app, FORK)
        .getByRole('button', { name: /^Add a key for / })
        .click()
      await app.page.keyboard.press('Escape')
      await keyRow(app, FORK).getByRole('textbox').waitFor({ state: 'detached' })
      await app.page.waitForTimeout(300)
      assert.equal(await readFile(file, 'utf8'), before)
      const sheetOpen = await settingsOpen(app)
      if (!sheetOpen) await openSettings(app, 'Terminal keys')
      // settings-11: Escape belongs to the capture ("Esc cancels"); the Settings sheet stays open.
      assert.ok(sheetOpen, 'Escape in the key capture closed Settings')
    })

    await step('removing the only default key disables the action ([] on disk)', async () => {
      await keyRow(app, MODEL_SELECT)
        .getByRole('button', { name: `Remove ${MODEL_SELECT_DEFAULT}` })
        .click()
      await waitForBinding(file, MODEL_SELECT, [])
      await keyRow(app, MODEL_SELECT).getByText('Disabled', { exact: true }).waitFor()
      assert.deepEqual(engineKeys(agentDir).getKeys(MODEL_SELECT), [])
    })

    await step(
      'Restore default keys drops the entry and the Engine falls back to the default',
      async () => {
        await keyRow(app, MODEL_SELECT)
          .getByRole('button', { name: 'Restore default keys' })
          .click()
        await waitFor(
          async () => !((await readFileJson()) ?? {})[MODEL_SELECT] && true,
          'entry removed'
        )
        assert.deepEqual(await readFileJson(), { [NEW_SESSION]: ['shift+alt+n', 'shift+alt+m'] })
        assert.deepEqual(engineKeys(agentDir).getKeys(MODEL_SELECT), [MODEL_SELECT_DEFAULT])
      }
    )

    await step('conflict: a key already bound to another action is flagged in the UI', async () => {
      await captureKey(app, TREE, 'Alt+Shift+KeyN')
      await waitForBinding(file, TREE, 'shift+alt+n')
      // The Engine detects it (KeybindingsManager.getConflicts) ...
      assert.deepEqual(engineKeys(agentDir).getConflicts(), [
        { key: 'shift+alt+n', keybindings: [NEW_SESSION, TREE] }
      ])
      await app.page.waitForTimeout(500)
      await app.screenshot('settings-keybindings-conflict')
      // ... settings-10: and Vengeance flags it on both rows.
      const warning = app.page.getByText(
        /conflict|already (used|bound|assigned)|also (used|bound)/i
      )
      assert.ok((await warning.count()) > 0, 'no conflict warning for shift+alt+n on two actions')
    })

    await step(
      'conflict with another action’s default key (Alt+Q) is flagged in the UI',
      async () => {
        await captureKey(app, FORK, 'Alt+KeyQ')
        await waitForBinding(file, FORK, 'alt+q')
        assert.deepEqual(engineKeys(agentDir).getKeys(FORK), ['alt+q'])
        assert.deepEqual(engineKeys(agentDir).getKeys(DEQUEUE), ['alt+q'], 'both actions claim it')
        const warning = keyRow(app, FORK).getByText(/conflict|already (used|bound|assigned)|also/i)
        assert.ok((await warning.count()) > 0, 'no warning that alt+q is the dequeue default')
      }
    )

    await step('Ctrl+L (a Vengeance shortcut) can be captured for a terminal action', async () => {
      const description = KEYBINDINGS[RESUME].description
      await keyRow(app, RESUME)
        .getByRole('button', { name: `Add a key for ${description}` })
        .click()
      await keyRow(app, RESUME).getByRole('textbox', { name: 'Press a key combination' }).waitFor()
      await app.page.keyboard.press('ControlOrMeta+KeyL')
      await app.page.waitForTimeout(500)
      const picker = app.page.getByPlaceholder(/^Search models/)
      const pickerOpened = await picker.isVisible().catch(() => false)
      if (pickerOpened) await app.screenshot('settings-keybindings-ctrl-l-capture')
      if (pickerOpened) await app.page.keyboard.press('Escape')
      if (!(await settingsOpen(app))) await openSettings(app, 'Terminal keys')
      // settings-12: Vengeance's global hotkeys (mod+l, mod+k, mod+n, ...) stand aside while a key capture
      // has focus, so Ctrl+L is recorded instead of opening the model picker.
      assert.equal(pickerOpened, false, 'Ctrl+L opened the model picker instead of being captured')
      // macOS records ⌘L, which is mod+l there.
      await waitForBinding(file, RESUME, process.platform === 'darwin' ? 'super+l' : 'ctrl+l')
    })

    await step(
      'external edit with a legacy name and an unknown id is shown, migrated and kept',
      async () => {
        const legacy = { cursorUp: 'alt+u', 'x.custom': 'ctrl+q' }
        await writeExternally(app, file, `${JSON.stringify(legacy, null, 2)}\n`)
        const cursorUp = keyRow(app, 'tui.editor.cursorUp')
        await cursorUp.getByTitle('alt+u').waitFor()
        await keyRow(app, NEW_SESSION).getByText('Unassigned').waitFor()
        await captureKey(app, NEW_SESSION, 'Alt+Shift+KeyN')
        await waitForBinding(file, NEW_SESSION, 'shift+alt+n')
        const text = await readFile(file, 'utf8')
        assert.equal(
          text,
          `${JSON.stringify({ 'tui.editor.cursorUp': 'alt+u', [NEW_SESSION]: 'shift+alt+n', 'x.custom': 'ctrl+q' }, null, 2)}\n`,
          'registry order, unknown ids last, legacy name migrated'
        )
        assert.deepEqual(engineKeys(agentDir).getKeys('tui.editor.cursorUp'), ['alt+u'])
      }
    )

    await step(
      'invalid keybindings.json: error shown, changes refused, file byte-identical',
      async () => {
        const broken = '{ "app.session.new": "ctrl+n", '
        await writeExternally(app, file, broken)
        await app.page.getByText('keybindings.json could not be read').waitFor()
        await dismissToasts(app)
        await captureKey(app, FORK, 'Alt+Shift+KeyF')
        await toastWith(app, 'Keybinding not saved').waitFor()
        await app.screenshot('settings-keybindings-invalid')
        assert.equal(await readFile(file, 'utf8'), broken)
      }
    )

    await step('the filter finds actions by key', async () => {
      await writeExternally(app, file, '{}\n')
      await app.page.getByText('All defaults').waitFor()
      await app.page.getByPlaceholder('Filter actions or keys').fill(MODEL_SELECT_DEFAULT)
      await waitFor(
        async () => (await app.page.locator('[id^="setting-keybinding."]').count()) >= 1,
        'filtered rows'
      )
      const ids = await app.page
        .locator('[id^="setting-keybinding."]')
        .evaluateAll((rows) => rows.map((row) => row.id.slice('setting-keybinding.'.length)))
      const expected = Object.entries(KEYBINDINGS)
        .filter(([, def]) => [def.defaultKeys].flat().some((k) => k.includes(MODEL_SELECT_DEFAULT)))
        .map(([id]) => id)
      assert.ok(ids.includes(MODEL_SELECT), `rows: ${ids}`)
      assert.deepEqual(ids.sort(), expected.sort())
    })

    finish()
  },
  { launch: LAUNCH }
)
