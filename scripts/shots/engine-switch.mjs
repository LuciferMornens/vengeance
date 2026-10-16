import assert from 'node:assert/strict'

const DRAFT = 'Keep my unsent message while changing the engine.'
const NARROW_WINDOW = { width: 880, height: 760 }
const READY_TIMEOUT_MS = 30_000

async function engineMenu(page, engine) {
  await page.getByRole('button', { name: `Conversation engine: ${engine}`, exact: true }).click()
}

async function waitForEngine(page, agentId, engine) {
  await page.waitForFunction(
    ({ agentId, engine }) => {
      const state = window.__vengeanceTest.agentState(agentId)
      return state?.info.engine === engine && state?.status === 'ready' && state?.session
    },
    { agentId, engine },
    { timeout: READY_TIMEOUT_MS }
  )
}

export async function scenarios(page, { app, shot, test, tempDir }) {
  const cwd = await tempDir('engine-switch-')
  const agentId = await test('openWorkspace', cwd, { engine: 'pi', name: 'Review the workspace' })
  await test('mockPlay', { script: 'short', instant: true })
  const history = (await test('agentState', agentId)).entries.map((entry) => entry.message)
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(DRAFT)

  await engineMenu(page, 'Engine')
  await page.getByRole('menuitem', { name: 'Switch to Engine 2…', exact: true }).waitFor()
  await shot('engine-switch-menu-dark')
  await page.getByRole('menuitem', { name: 'Switch to Engine 2…', exact: true }).click()
  await page.getByRole('dialog', { name: 'Continue with Engine 2?' }).waitFor()
  await shot('engine-switch-confirm-dark')
  await page.getByRole('button', { name: 'Switch engine', exact: true }).click()
  await waitForEngine(page, agentId, 'prime')
  assert.equal(await test('activeAgentId'), agentId)
  assert.equal(await composer.inputValue(), DRAFT)
  assert.deepEqual(
    (await test('agentState', agentId)).entries.map((entry) => entry.message),
    history
  )

  await app.evaluate(({ BrowserWindow }, dimensions) => {
    BrowserWindow.getAllWindows()[0].setContentSize(dimensions.width, dimensions.height)
  }, NARROW_WINDOW)
  await test('setPrefs', { theme: 'light' })
  await engineMenu(page, 'Engine 2')
  await shot('engine-switch-menu-bone-narrow')
  await page.getByRole('menuitem', { name: 'Switch to Engine…', exact: true }).click()
  await shot('engine-switch-confirm-bone-narrow')
  await page.getByRole('button', { name: 'Switch engine', exact: true }).click()
  await waitForEngine(page, agentId, 'pi')
  assert.equal(await composer.inputValue(), DRAFT)

  await page.getByRole('button', { name: 'More ways to start', exact: true }).click()
  await shot('engine-new-session-choices-bone')
  await page.getByRole('menuitem', { name: 'New session with Engine 2', exact: true }).click()
  await page.waitForFunction(
    (previous) => {
      const state = window.__vengeanceTest.agentState()
      return state?.id !== previous && state?.info.engine === 'prime' && state?.status === 'ready'
    },
    agentId,
    { timeout: READY_TIMEOUT_MS }
  )
  const prefs = (await test('appState')).prefs
  assert.equal(prefs.workspaces.find((workspace) => workspace.path === cwd).engine, 'pi')
  assert.equal((await test('agentState', agentId)).info.engine, 'pi')
}
