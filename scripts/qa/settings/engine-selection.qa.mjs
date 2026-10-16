import assert from 'node:assert/strict'
import { scenarios } from '../../shots/settings-engines.mjs'
import { reportShotsDir } from '../lib/app.mjs'
import { runSuite } from '../lib/suite.mjs'
import { waitUntil } from '../auth/helpers.mjs'

const READY_TIMEOUT_MS = 15_000
const MOCK_LAUNCH = {
  env: { VENGEANCE_MOCK: '1' },
  outDir: reportShotsDir('settings-engine')
}

async function chooseEngine(application, label) {
  await application.page.getByRole('combobox', { name: 'Settings engine' }).click()
  await application.page.getByRole('option', { name: label, exact: true }).click()
}

async function workspaceDefault(application, cwd) {
  const state = await application.invoke('app:get-state')
  return state.workspaces.find((workspace) => workspace.path === cwd)?.engine
}

async function checkNewSession(application, engine) {
  const before = await application.activeAgentId()
  await application.page.keyboard.press('Control+n')
  await waitUntil(
    async () => {
      const state = await application.agentState()
      return (
        state?.info.agentId !== before && state?.status === 'ready' && state?.info.engine === engine
      )
    },
    { label: `Ctrl+N starts ${engine}`, timeoutMs: READY_TIMEOUT_MS }
  )
}

await runSuite(
  'settings-engine-without-workspace',
  async ({ app: application, step }) => {
    let restartedApplication
    try {
      await step(
        'choosing an engine before opening a workspace saves the app default',
        async () => {
          await application.test('openSettings', 'providers')
          await chooseEngine(application, 'Engine 2')
          assert.equal((await application.invoke('app:get-state')).defaultEngine, 'prime')
          await application.page.getByText('New workspaces default to Engine 2.').waitFor()
          await application.screenshot('settings-engine-app-default')
          await application.test('closeSettings')
        }
      )

      await step(
        'the app default survives restart and applies to the first workspace',
        async () => {
          restartedApplication = await application.relaunch()
          assert.equal((await restartedApplication.invoke('app:get-state')).defaultEngine, 'prime')
          await restartedApplication.test('openSettings', 'providers')
          await restartedApplication.page
            .getByRole('combobox', { name: 'Settings engine' })
            .getByText('Engine 2', { exact: true })
            .waitFor()
          await restartedApplication.test('closeSettings')
          const opened = await restartedApplication.openWorkspace()
          assert.equal((await restartedApplication.agentState(opened.agentId)).info.engine, 'prime')
          assert.equal(await workspaceDefault(restartedApplication, opened.cwd), 'prime')
        }
      )
    } finally {
      await restartedApplication?.close()
    }
  },
  { launch: MOCK_LAUNCH }
)

await runSuite(
  'settings-engine-selection',
  async ({ app: application, step }) => {
    let currentApplication = application
    const firstWorkspace = await application.createWorkspace()
    let secondWorkspace

    try {
      await step('long diagnostics and the visible Settings picker at two window sizes', () =>
        scenarios(application.page, {
          app: application.app,
          shot: (...parameters) => application.screenshot(...parameters),
          test: (...parameters) => application.test(...parameters),
          MOCK_WORKSPACE: firstWorkspace
        })
      )

      await step('another workspace has its own default for new sessions', async () => {
        const opened = await application.openWorkspace({ args: { engine: 'pi' } })
        secondWorkspace = opened.cwd
        await application.test('openSettings', 'providers')
        await application.page
          .getByRole('combobox', { name: 'Settings engine' })
          .getByText('Engine', { exact: true })
          .waitFor()
        await chooseEngine(application, 'Engine 2')
        assert.equal(await workspaceDefault(application, firstWorkspace), 'prime')
        assert.equal(await workspaceDefault(application, secondWorkspace), 'prime')
        await chooseEngine(application, 'Engine')
        assert.equal(await workspaceDefault(application, firstWorkspace), 'prime')
        assert.equal(await workspaceDefault(application, secondWorkspace), 'pi')
        assert.equal((await application.agentState(opened.agentId)).info.engine, 'pi')
        await application.test('closeSettings')
        await checkNewSession(application, 'pi')
      })

      await step('workspace defaults survive a complete app restart', async () => {
        currentApplication = await application.relaunch()
        assert.equal(await workspaceDefault(currentApplication, firstWorkspace), 'prime')
        assert.equal(await workspaceDefault(currentApplication, secondWorkspace), 'pi')
        const reopened = await currentApplication.openWorkspace({ cwd: firstWorkspace })
        await currentApplication.test('openSettings', 'providers')
        await currentApplication.page
          .getByRole('combobox', { name: 'Settings engine' })
          .getByText('Engine 2', { exact: true })
          .waitFor()
        assert.equal((await currentApplication.agentState(reopened.agentId)).info.engine, 'prime')
        await currentApplication.screenshot('settings-engine-restarted-default')
        await currentApplication.test('closeSettings')
        await checkNewSession(currentApplication, 'prime')
        currentApplication.assertNoErrors()
      })
    } finally {
      if (currentApplication !== application) await currentApplication.close()
    }
  },
  { launch: MOCK_LAUNCH }
)
