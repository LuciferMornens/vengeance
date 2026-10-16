// Extension CLI flags (pi.registerFlag) in Launch options: discovered from the engine's --help,
// shown with friendly names, and passed to the engine when a session starts with them
// (verified through pi.getFlag() in the fixture and the system prompt the fake LLM receives).
//
//   node scripts/qa/ext/extension-flags.qa.mjs
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  bugSteps,
  extLogLength,
  fixtureExtensionFiles,
  reportShot,
  runPaletteAction,
  settleActive,
  waitForExtLog
} from './lib/ext-helpers.mjs'

await runSuite(
  'ext-extension-flags',
  async ({ server, agentDir, app, step }) => {
    const { page } = app
    const { bugStep, finish } = bugSteps(step)
    const launchDialog = page.getByRole('dialog', { name: 'New session with options' })

    await step('open a workspace; the fixture starts with its flag defaults', async () => {
      await app.openWorkspace()
      const start = await waitForExtLog(agentDir, 'session_start')
      assert.deepEqual(start.flags, { mode: 'normal', loud: false })
    })

    await step('Launch options lists the fixture flags with friendly names', async () => {
      await runPaletteAction(app, 'New session with options…')
      await launchDialog.waitFor()
      await launchDialog.locator('[data-section="flags"]').click()
      await launchDialog.getByText('--qa-mode', { exact: true }).waitFor({ timeout: 60_000 })
      await launchDialog.getByText('--qa-loud', { exact: true }).waitFor()
      await launchDialog.getByText('Qa mode', { exact: true }).waitFor()
      await launchDialog
        .getByText('QA fixture: run mode label for the fixture extension.')
        .waitFor()
      await launchDialog.getByText(/2 flags from 1 extension/).waitFor()
      await reportShot(app, 'ext-flags-launch-options')
    })

    await bugStep('the flag group is named after the extension that registers it', async () => {
      const other = await launchDialog.getByText('Other extensions', { exact: true }).count()
      assert.equal(other, 0, 'flags are grouped as "Other extensions"')
      await launchDialog.getByText('Qa fixture', { exact: true }).waitFor({ timeout: 1000 })
    })

    await step('setting both flags shows them in the engine command preview', async () => {
      await launchDialog.getByRole('switch', { name: 'Qa loud' }).click()
      await launchDialog.getByRole('textbox', { name: 'Qa mode' }).fill('turbo')
      await launchDialog.getByRole('button', { name: 'Show engine command' }).click()
      const preview = await launchDialog.getByTestId('engine-arguments').innerText()
      assert.match(preview, /--qa-loud/)
      assert.match(preview, /--qa-mode turbo/)
      await reportShot(app, 'ext-flags-preview')
    })

    await step('Start session: the new engine sees both flag values', async () => {
      const from = extLogLength(agentDir)
      const before = await app.activeAgentId()
      await launchDialog.getByRole('button', { name: 'Start session' }).click()
      const start = await waitForExtLog(agentDir, 'session_start', { from, timeoutMs: 60_000 })
      assert.deepEqual(start.flags, { mode: 'turbo', loud: true })
      await page.waitForFunction(
        (previous) => {
          const id = window.__vengeanceTest.activeAgentId()
          const agent = window.__vengeanceTest.agentState(id)
          return id && id !== previous && agent?.status === 'ready'
        },
        before,
        { timeout: 60_000 }
      )
    })

    await step(
      'the flags change engine behaviour: system prompt and per-turn notification',
      async () => {
        const from = server.requests.length
        server.queue(turn.text('Turbo reply.'))
        // Each open session keeps its composer mounted; the newest session's is the last one.
        const composer = page.getByRole('textbox', { name: 'Message' }).last()
        await composer.fill('flag check')
        await composer.press('Enter')
        await settleActive(app)
        const request = await server.waitForRequest(undefined, { from })
        assert.match(inspectRequest(request).system, /QA-SYSTEM-MARKER mode=turbo/)
        await page.locator('[data-toaster]').getByText('QA loud turn finished').first().waitFor()
      }
    )

    await step('workspace defaults: a saved flag applies to the next new session', async () => {
      await runPaletteAction(app, 'Workspace launch options…')
      const defaults = page.getByRole('dialog', { name: 'Launch options' })
      await defaults.waitFor()
      await defaults.locator('[data-section="flags"]').click()
      await defaults.getByRole('textbox', { name: 'Qa mode' }).fill('fromdefaults')
      await defaults.getByRole('button', { name: 'Save defaults' }).click()
      await defaults.waitFor({ state: 'detached' })
      const from = extLogLength(agentDir)
      // Ctrl+N: typing 'New session' in the palette picks the open session titled 'New session'.
      await page.keyboard.press('Control+n')
      const start = await waitForExtLog(agentDir, 'session_start', { from, timeoutMs: 60_000 })
      assert.equal(start.flags.mode, 'fromdefaults')
    })
    finish()
  },
  { agentDir: { files: fixtureExtensionFiles() } }
)
