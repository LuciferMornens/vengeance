// Global vs project settings and project trust: the scope switch writes the right file, the UI says
// which value wins, the Engine honors the project value only for trusted folders, clearing the project
// override falls back to global, global-only settings are locked in project scope, and
// defaultProjectTrust decides for folders without a saved decision.
//
//   node scripts/qa/settings/scope-trust.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'
import {
  choose,
  closeSettings,
  dismissToasts,
  fill,
  LAUNCH,
  newSessionIn,
  openSettings,
  projectSettingsPath,
  readJsonOrNull,
  restartFromEngineSection,
  restartFromToast,
  sendAndCapture,
  setScope,
  settingRow,
  softSteps,
  waitFor,
  waitForJsonValue
} from './settings-ui.mjs'

/** The "low" thinking budget the Engine sends (sessions run at "low" for these checks). */
async function lowBudget(app, server, text) {
  await app.rpc({ type: 'set_thinking_level', level: 'low' })
  const request = await sendAndCapture(app, server, text, turn.text('ok'))
  return inspectRequest(request).thinking?.budget_tokens
}

/** Open `cwd` (whose .pi needs a trust decision) and answer the Trust dialog with `choice`. */
async function openAndAnswerTrust(app, cwd, choice) {
  const opening = app.test('openWorkspace', cwd, {})
  const option = app.page.getByRole('option', { name: new RegExp(`^${choice}`) })
  await option.waitFor()
  await app.screenshot(`settings-trust-dialog`)
  await option.click()
  const agentId = await opening
  const composer = app.page.getByRole('textbox', { name: 'Message' })
  await waitFor(async () => (await composer.count()) === 1, 'one composer')
  return agentId
}

async function trustEntries(agentDir) {
  return (await readJsonOrNull(agentDir.path('trust.json'))) ?? {}
}

await runSuite(
  'settings-scope-trust',
  async (context) => {
    const { server, agentDir, app } = context
    const { check: step, finish } = softSteps(context, 'settings-scope-trust')
    const settingsPath = agentDir.path('settings.json')
    let agentId
    let cwd
    let projectPath

    await step('global Low budget 3000 is written to the agent dir settings.json', async () => {
      ;({ agentId, cwd } = await app.openWorkspace())
      projectPath = projectSettingsPath(cwd)
      await openSettings(app, 'Models')
      await fill(app, 'thinkingBudgets.low', 3000)
      await waitForJsonValue(settingsPath, 'thinkingBudgets', { low: 3000 })
      await restartFromToast(app, agentId)
      await closeSettings(app)
      assert.equal(await lowBudget(app, server, 'global budget'), 3000)
    })

    await step(
      'project scope shows the inherited global value; 5000 goes to .pi/settings.json',
      async () => {
        await openSettings(app, 'Models')
        await setScope(app, 'project')
        const row = settingRow(app, 'thinkingBudgets.low')
        await row.getByText('Inherited', { exact: true }).waitFor()
        assert.equal(await row.locator('input').getAttribute('placeholder'), '3000')
        await fill(app, 'thinkingBudgets.low', 5000)
        await waitForJsonValue(projectPath, 'thinkingBudgets', { low: 5000 })
        await row.getByText('Project', { exact: true }).waitFor()
        assert.deepEqual(
          (await readJsonOrNull(settingsPath)).thinkingBudgets,
          { low: 3000 },
          'global untouched'
        )
        await app.page.getByText('This folder isn’t trusted').waitFor()
        await app.screenshot('settings-scope-project')
      }
    )

    await step('global scope marks the row "Overridden in project"', async () => {
      await setScope(app, 'global')
      const row = settingRow(app, 'thinkingBudgets.low')
      await row.getByText('Overridden in project').waitFor()
      assert.equal(await row.locator('input').inputValue(), '3000')
    })

    await step(
      'untrusted folder: after "Restart engines" the Engine still uses the global value',
      async () => {
        await restartFromEngineSection(app, agentId)
        await closeSettings(app)
        assert.equal(await lowBudget(app, server, 'untrusted project'), 3000)
      }
    )

    await step(
      '"Trust folder" saves trust.json; after a restart the project value wins',
      async () => {
        await openSettings(app, 'Models')
        await setScope(app, 'project')
        await app.page.getByRole('button', { name: 'Trust folder' }).first().click()
        await waitFor(
          async () => Object.values(await trustEntries(agentDir)).includes(true),
          'trust.json entry'
        )
        await app.page.getByText('This folder isn’t trusted').waitFor({ state: 'detached' })
        await restartFromEngineSection(app, agentId)
        await closeSettings(app)
        assert.equal(await lowBudget(app, server, 'trusted project'), 5000)
      }
    )

    await step(
      '"Remove project override" empties the project key; the Engine falls back to global',
      async () => {
        await openSettings(app, 'Models')
        await setScope(app, 'project')
        const row = settingRow(app, 'thinkingBudgets.low')
        await row.hover()
        await row.getByRole('button', { name: 'Remove project override' }).click()
        await waitFor(
          async () => (await readJsonOrNull(projectPath))?.thinkingBudgets === undefined,
          'project thinkingBudgets removed'
        )
        await row.getByText('Inherited', { exact: true }).waitFor()
        await restartFromToast(app, agentId)
        await closeSettings(app)
        assert.equal(await lowBudget(app, server, 'override cleared'), 3000)
      }
    )

    await step('global-only settings are locked in project scope', async () => {
      await openSettings(app, 'Models')
      await setScope(app, 'project')
      const warming = settingRow(app, 'cacheWarming')
      await warming.getByText('Global only').waitFor()
      await openSettings(app, 'Agent behavior')
      const proxy = settingRow(app, 'httpProxy')
      await proxy.getByText('Global only').waitFor()
      assert.equal(await proxy.locator('input').isDisabled(), true)
      await openSettings(app, 'Sessions & context')
      await settingRow(app, 'defaultProjectTrust').getByText('Global only').waitFor()
      await setScope(app, 'global')
    })

    await step('Sessions & context: Distrust and Forget update trust.json', async () => {
      await openSettings(app, 'Sessions & context')
      const group = settingRow(app, 'projectTrust')
      await group.getByRole('button', { name: 'Distrust' }).click()
      await waitFor(
        async () => Object.values(await trustEntries(agentDir)).includes(false),
        'distrusted'
      )
      await group.getByText('Not trusted').waitFor()
      await group.getByRole('button', { name: 'Forget' }).click()
      await waitFor(async () => Object.keys(await trustEntries(agentDir)).length === 0, 'forgotten')
      await group.getByText('Using default').waitFor()
    })

    await step(
      'defaultProjectTrust "Always": a new folder with .pi settings is trusted, no dialog',
      async () => {
        await choose(app, 'defaultProjectTrust', 'Always')
        await waitForJsonValue(settingsPath, 'defaultProjectTrust', 'always')
        await closeSettings(app)
        const folder = await app.createWorkspace({
          '.pi/settings.json': { thinkingBudgets: { low: 7000 } }
        })
        await newSessionIn(app, folder)
        assert.equal(await lowBudget(app, server, 'always trusted'), 7000)
      }
    )

    await step(
      'defaultProjectTrust "Never": a new folder starts without its project settings',
      async () => {
        await openSettings(app, 'Sessions & context')
        await choose(app, 'defaultProjectTrust', 'Never')
        await waitForJsonValue(settingsPath, 'defaultProjectTrust', 'never')
        await closeSettings(app)
        const folder = await app.createWorkspace({
          '.pi/settings.json': { thinkingBudgets: { low: 7000 } }
        })
        await newSessionIn(app, folder)
        assert.equal(await lowBudget(app, server, 'never trusted'), 3000)
      }
    )

    await step(
      '"Ask" opens the Trust dialog; "Not now" starts without project settings',
      async () => {
        await openSettings(app, 'Sessions & context')
        await choose(app, 'defaultProjectTrust', 'Ask')
        await waitForJsonValue(settingsPath, 'defaultProjectTrust', 'ask')
        await closeSettings(app)
        cwd = await app.createWorkspace({ '.pi/settings.json': { thinkingBudgets: { low: 7000 } } })
        agentId = await openAndAnswerTrust(app, cwd, 'Not now')
        assert.equal(await lowBudget(app, server, 'not now'), 3000)
      }
    )

    await step('trusting that folder in Settings offers to restart its open session', async () => {
      await openSettings(app, 'Sessions & context')
      await dismissToasts(app)
      await settingRow(app, 'projectTrust').getByRole('button', { name: 'Trust folder' }).click()
      await waitFor(
        async () => Object.values(await trustEntries(agentDir)).includes(true),
        'trusted'
      )
      await app.page.waitForTimeout(800)
      // settings-3: like the Trust dialog, trusting from Settings restarts the folder's open sessions
      // per the restart policy (default: a "Restart to apply" toast).
      const offered = await app.page.locator('[role=status]', { hasText: /restart/i }).count()
      assert.ok(offered > 0, 'no restart offered after trusting the folder')
    })

    await step(
      'after trusting it in Settings, "Restart engines" loads its project settings',
      async () => {
        await restartFromEngineSection(app, agentId)
        await closeSettings(app)
        // settings-2: a restart drops the spawn's pinned `--no-approve` ("Not now") once trust.json
        // holds a decision, so the engine reads the decision just saved.
        assert.equal(await lowBudget(app, server, 'trusted later'), 7000)
      }
    )

    finish()
  },
  { launch: LAUNCH }
)
