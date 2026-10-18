// Workspace launch options (Command palette → "Workspace launch options…" / "New session with
// options…"): environment variables (masked, sealed at rest, reveal), extension flags, model scope,
// offline and the engine-command disclosure, each followed into the Engine process.
//
//   node scripts/qa/settings/launch-options.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  dismissToasts,
  LAUNCH,
  newSessionIn,
  softSteps,
  toastWith,
  waitFor
} from './settings-ui.mjs'

const SECRET = 'qa-test-value'
const PLAIN = 'plain-value'

/** A global extension that registers two flags and reports their values in the system prompt. */
const FLAG_EXTENSION = `export default function (pi) {
  pi.registerFlag('qavng-style', { type: 'string', description: 'QA style flag' })
  pi.registerFlag('qavng-loud', { type: 'boolean', description: 'QA boolean flag' })
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: event.systemPrompt + '\\nQA_FLAGS style=' + pi.getFlag('qavng-style') + ' loud=' + pi.getFlag('qavng-loud') +
      ' argvOffline=' + process.argv.includes('--offline')
  }))
}
`

// The harness runs every engine with PI_OFFLINE=1, so offline mode is observed through the Engine's argv.
const ECHO = 'echo "QA_ENV plain=$QA_PLAIN secret=$QA_SECRET_TOKEN"'

async function runPalette(app, title) {
  await dismissToasts(app)
  await app.page.keyboard.press('ControlOrMeta+KeyK')
  const input = app.page
    .getByRole('combobox')
    .or(app.page.getByPlaceholder(/command/i))
    .first()
  await input.waitFor()
  await input.fill(title.replace('…', ''))
  await app.page
    .getByRole('option', { name: new RegExp(`^${title}`) })
    .first()
    .click()
}

const dialog = (app) => app.page.getByRole('dialog')

async function openSection(app, label) {
  await dialog(app)
    .locator(`nav[aria-label="Launch option sections"] button`, { hasText: label })
    .click()
  await dialog(app).getByRole('heading', { name: label, exact: true }).waitFor()
}

/** Add one environment row by typing name and value (the editor commits on change). */
async function addEnv(app, name, value) {
  await dialog(app).getByRole('button', { name: 'Variable', exact: true }).click()
  await dialog(app).getByRole('textbox', { name: 'Variable name' }).last().fill(name)
  await dialog(app)
    .getByLabel('Value of ' + name)
    .fill(value)
}

/** The bash tool's output for `ECHO` in a fresh turn of the active session. */
async function echoEnv(app, server) {
  const from = server.requests.length
  server.queue(turn.toolCall('bash', { command: ECHO }), turn.text('done'))
  await app.send('print env')
  await app.waitForSettle()
  const request = await server.waitForRequest(
    (r) => inspectRequest(r).toolResults.some((m) => m.text.includes('QA_ENV')),
    { from }
  )
  const line = inspectRequest(request)
    .toolResults.map((m) => m.text)
    .find((text) => text.includes('QA_ENV'))
  return { line: line.trim(), first: inspectRequest(server.requests[from]) }
}

await runSuite(
  'settings-launch-options',
  async (context) => {
    const { server, agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-launch-options')
    const appStatePath = join(app.userData, 'app-state.json')
    let cwd

    await step(
      'Workspace launch options: environment, flags, scope and offline are entered',
      async () => {
        await agentDir.writeText('extensions/qa-flags.ts', FLAG_EXTENSION)
        ;({ cwd } = await app.openWorkspace())
        await runPalette(app, 'Workspace launch options…')
        await dialog(app)
          .getByText('Defaults for new Engine sessions in', { exact: false })
          .waitFor()
        await openSection(app, 'Environment')
        await addEnv(app, 'QA_SECRET_TOKEN', SECRET)
        await addEnv(app, 'QA_PLAIN', PLAIN)
        const secretInput = dialog(app).getByLabel('Value of QA_SECRET_TOKEN')
        assert.equal(
          await secretInput.getAttribute('type'),
          'password',
          'secret-looking value typed hidden'
        )
        assert.equal(await dialog(app).getByLabel('Value of QA_PLAIN').getAttribute('type'), 'text')
        await openSection(app, 'Extension flags')
        await dialog(app).getByText('--qavng-style').waitFor({ timeout: 60_000 })
        await dialog(app)
          .getByRole('textbox', { name: /style$/i })
          .fill('loud-style')
        await dialog(app).getByRole('switch', { name: /loud$/i }).click()
        await openSection(app, 'Models')
        await dialog(app).getByRole('switch', { name: 'Offline' }).click()
        const scope = dialog(app)
          .getByRole('combobox', { name: 'Model scope' })
          .or(dialog(app).getByLabel('Model scope'))
        await scope.first().fill('qa/qa-small')
        await scope.first().press('Enter')
        await scope.first().fill('qa/qa-vision')
        await scope.first().press('Enter')
      }
    )

    await step(
      'the engine command disclosure lists the flags and only the variable names',
      async () => {
        await dialog(app).getByRole('button', { name: 'Show engine command' }).click()
        const command = dialog(app).getByTestId('engine-arguments')
        await command.waitFor()
        const text = await command.innerText()
        assert.match(text, /--models qa\/qa-small,qa\/qa-vision/)
        assert.match(text, /--offline/)
        assert.match(text, /--qavng-style loud-style/)
        assert.match(text, /--qavng-loud(\s|$)/)
        assert.match(text, /Environment: QA_SECRET_TOKEN, QA_PLAIN/)
        assert.ok(!text.includes(SECRET) && !text.includes(PLAIN), 'values never shown')
        await app.screenshot('settings-launch-options-command')
      }
    )

    await step(
      'Save defaults: app-state.json stores the options with both env values sealed',
      async () => {
        await dialog(app).getByRole('button', { name: 'Save defaults' }).click()
        await toastWith(app, 'Launch options saved').waitFor()
        const saved = await waitFor(async () => {
          const state = JSON.parse(await readFile(appStatePath, 'utf8'))
          const workspaces = state.prefs?.features?.launch?.workspaces ?? {}
          return Object.values(workspaces)[0]
        }, 'workspace defaults in app-state.json')
        const sealsSecrets = await app.app.evaluate(({ safeStorage }) =>
          safeStorage.isEncryptionAvailable()
        )
        if (sealsSecrets) {
          const raw = await readFile(appStatePath, 'utf8')
          assert.ok(
            !raw.includes(SECRET) && !raw.includes(PLAIN),
            'no clear-text env value on disk'
          )
          assert.match(saved.env.QA_SECRET_TOKEN, /^vengeance-sealed:v1:/)
          assert.match(saved.env.QA_PLAIN, /^vengeance-sealed:v1:/)
        } else {
          // Without OS encryption (Linux's basic password store) the values stay plain at rest.
          assert.deepEqual([saved.env.QA_SECRET_TOKEN, saved.env.QA_PLAIN], [SECRET, PLAIN])
        }
        assert.deepEqual(saved.extensionFlags, { 'qavng-style': 'loud-style', 'qavng-loud': true })
        assert.deepEqual(saved.models, ['qa/qa-small', 'qa/qa-vision'])
        assert.equal(saved.offline, true)
      }
    )

    await step('a new session gets the env, the flags, the scope and offline mode', async () => {
      const agentId = await newSessionIn(app, cwd)
      const state = await app.rpc({ type: 'get_state' }, agentId)
      assert.ok(
        ['qa-small', 'qa-vision'].includes(state.model?.id),
        `start model ${state.model?.id}`
      )
      const { line, first } = await echoEnv(app, server)
      assert.equal(line, `QA_ENV plain=${PLAIN} secret=${SECRET}`)
      assert.match(first.system, /QA_FLAGS style=loud-style loud=true argvOffline=true/)
      const seen = new Set([state.model.id])
      for (let i = 0; i < 3; i++)
        seen.add((await app.rpc({ type: 'cycle_model' }, agentId))?.model?.id)
      assert.deepEqual(
        [...seen].sort(),
        ['qa-small', 'qa-vision'],
        'cycling stays inside the scope'
      )
    })

    await step('after a window reload the renderer holds masks only', async () => {
      // Until the window reloads, the renderer keeps the values the user typed (see the report, P3).
      // A reload keeps the open sessions (the window adopts their engines or restores them), so the
      // reloaded window is ready once one composer shows again.
      await app.page.reload()
      await app.page.waitForFunction(() => !!window.__vengeanceTest)
      const composer = app.page.getByRole('textbox', { name: 'Message' })
      await waitFor(
        async () => (await composer.count()) === 1 && composer.isVisible(),
        'one composer after reload'
      )
      const prefs = (await app.test('appState')).prefs
      const env = Object.values(prefs.features.launch.workspaces)[0].env
      assert.equal(env.QA_SECRET_TOKEN, '\u2022\u2022\u2022\u20226789')
      assert.equal(env.QA_PLAIN, '\u2022\u2022\u2022\u2022')
      assert.ok(!JSON.stringify(prefs).includes(SECRET), 'renderer state holds no secret')
    })

    await step('reopening shows masks; Show value reveals the stored clear text', async () => {
      await runPalette(app, 'Workspace launch options…')
      await openSection(app, 'Environment')
      const secretInput = dialog(app).getByLabel('Value of QA_SECRET_TOKEN')
      const shown = await secretInput.inputValue()
      assert.ok(shown.startsWith('\u2022\u2022\u2022\u2022'), `shown: ${JSON.stringify(shown)}`)
      assert.equal(await secretInput.getAttribute('type'), 'password')
      const row = dialog(app)
        .locator('div.flex.items-center', { has: app.page.getByLabel('Value of QA_SECRET_TOKEN') })
        .last()
      await row.getByRole('button', { name: 'Show value' }).click()
      await waitFor(async () => (await secretInput.inputValue()) === SECRET, 'revealed value')
      assert.equal(await secretInput.getAttribute('type'), 'text')
      await app.screenshot('settings-launch-options-revealed')
      await dialog(app).getByRole('button', { name: 'Cancel' }).click()
      await dialog(app).waitFor({ state: 'detached' })
    })

    await step(
      'New session with options: a per-session override reaches only that engine',
      async () => {
        const savedDefaults = async () =>
          JSON.parse(await readFile(appStatePath, 'utf8')).prefs.features.launch.workspaces
        const before = await savedDefaults()
        const previous = await app.test('activeAgentId')
        await runPalette(app, 'New session with options…')
        await openSection(app, 'Environment')
        const plain = dialog(app).getByLabel('Value of QA_PLAIN')
        await plain.click()
        await plain.fill('session-override')
        await dialog(app).getByRole('button', { name: 'Start session' }).click()
        await dialog(app).waitFor({ state: 'detached' })
        const composer = app.page.getByRole('textbox', { name: 'Message' })
        await waitFor(
          async () => (await composer.count()) === 1 && composer.isVisible(),
          'one composer'
        )
        await waitFor(
          async () => {
            const id = await app.test('activeAgentId')
            return id !== previous && (await app.agentState(id))?.status === 'ready'
          },
          'override session ready',
          60_000
        )
        const info = (await app.agentState(await app.test('activeAgentId')))?.info?.args?.launch
        const { line } = await echoEnv(app, server)
        assert.equal(line, `QA_ENV plain=session-override secret=${SECRET}`, JSON.stringify(info))
        // Sealing is randomized, so compare the shape and the stored clear value, not the bytes.
        const after = await savedDefaults()
        assert.deepEqual(Object.keys(after), Object.keys(before), 'workspace defaults untouched')
        assert.equal(await app.invoke('launch:reveal-env', cwd, 'QA_PLAIN'), PLAIN)
      }
    )

    await step('Reset all + Save defaults clears the workspace defaults', async () => {
      await runPalette(app, 'Workspace launch options…')
      await dialog(app).getByRole('button', { name: 'Reset all' }).click()
      await dialog(app).getByRole('button', { name: 'Save defaults' }).click()
      await waitFor(async () => {
        const state = JSON.parse(await readFile(appStatePath, 'utf8'))
        return Object.keys(state.prefs?.features?.launch?.workspaces ?? {}).length === 0
      }, 'workspace defaults removed')
      await newSessionIn(app, cwd)
      const { line, first } = await echoEnv(app, server)
      assert.equal(line, 'QA_ENV plain= secret=')
      assert.match(first.system, /QA_FLAGS style=undefined loud=undefined argvOffline=false/)
    })

    finish()
  },
  { launch: LAUNCH }
)
