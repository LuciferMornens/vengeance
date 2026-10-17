import assert from 'node:assert/strict'

const LONG_SESSION_TITLE =
  'Review every release change and inspect the complete diagnostics for the workspace — ' +
  'including authentication, configuration, resources, resident sessions, and restart behavior'
const FULL_WINDOW = { width: 1440, height: 900 }
const NARROW_WINDOW = { width: 880, height: 760 }
const READY_TIMEOUT_MS = 15_000
const BOUNDS_TOLERANCE_PX = 1

async function invoke(page, channel, ...parameters) {
  return page.evaluate(
    ([name, values]) => window.vengeance.invoke(name, ...values),
    [channel, parameters]
  )
}

async function chooseEngine(page, label) {
  await page.getByRole('combobox', { name: 'Settings engine' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

async function setWindow(app, dimensions) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, dimensions)
}

async function checkDiagnosticsBounds(trigger) {
  const bounds = await trigger.evaluate((element) => {
    const rectangle = element.getBoundingClientRect()
    const label = element.firstElementChild
    const icon = element.lastElementChild
    const iconBounds = icon.getBoundingClientRect()
    const parentBounds = element.parentElement.getBoundingClientRect()
    return {
      right: rectangle.right,
      parentRight: parentBounds.right,
      iconRight: iconBounds.right,
      labelWidth: label.clientWidth,
      labelContentWidth: label.scrollWidth,
      textOverflow: getComputedStyle(label).textOverflow
    }
  })
  assert.ok(bounds.right <= bounds.parentRight + BOUNDS_TOLERANCE_PX)
  assert.ok(bounds.iconRight <= bounds.right + BOUNDS_TOLERANCE_PX)
  assert.ok(bounds.labelContentWidth > bounds.labelWidth, 'the long title needs truncation')
  assert.equal(bounds.textOverflow, 'ellipsis')
}

export async function scenarios(page, { app, shot, test, MOCK_WORKSPACE }) {
  const firstAgentId = await test('openWorkspace', MOCK_WORKSPACE, {
    engine: 'pi',
    name: LONG_SESSION_TITLE
  })
  await test('openSettings', 'engine')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByText('Choose engine', { exact: true }).waitFor()
  await settings.getByText('New sessions in this workspace use Engine.').waitFor()
  const diagnostics = settings.getByRole('combobox', { name: 'Diagnostics session' })
  await diagnostics.scrollIntoViewIfNeeded()
  assert.equal(await diagnostics.getAttribute('title'), LONG_SESSION_TITLE)
  await checkDiagnosticsBounds(diagnostics)
  assert.equal(
    await settings.locator('pre').last().innerText(),
    (await invoke(page, 'engine:stderr', firstAgentId)).trim() || 'No error output. All quiet.'
  )
  await shot('settings-engine-long-diagnostics-dark')
  await setWindow(app, NARROW_WINDOW)
  await checkDiagnosticsBounds(diagnostics)
  await diagnostics.click()
  const option = page.getByRole('option', { name: LONG_SESSION_TITLE, exact: true })
  await option.waitFor()
  const menuBounds = await page.getByRole('listbox').boundingBox()
  const viewportWidth = await page.evaluate(() => window.innerWidth)
  assert.ok(menuBounds.x >= 0)
  assert.ok(menuBounds.x + menuBounds.width <= viewportWidth + BOUNDS_TOLERANCE_PX)
  await shot('settings-engine-long-diagnostics-menu-narrow')
  await page.keyboard.press('Escape')
  await test('setPrefs', { theme: 'light' })
  await shot('settings-engine-long-diagnostics-bone-narrow')
  await setWindow(app, FULL_WINDOW)
  await test('setPrefs', { theme: 'dark' })

  await chooseEngine(page, 'Engine 2')
  await settings.getByText('New sessions in this workspace use Engine 2.').waitFor()
  assert.equal((await test('agentState', firstAgentId)).info.engine, 'pi')
  const preferences = (await invoke(page, 'app:get-state')).workspaces
  assert.equal(preferences.find((workspace) => workspace.path === MOCK_WORKSPACE).engine, 'prime')
  await test('closeSettings')
  await test('openSettings', 'providers')
  await settings.getByRole('heading', { name: 'Subscriptions', exact: true }).waitFor()
  await settings.getByRole('combobox', { name: 'Settings engine' }).getByText('Engine 2').waitFor()
  await settings
    .locator('[id="setting-provider.openai-codex"]')
    .getByText('ChatGPT · Codex')
    .waitFor()
  await shot('settings-engine-default-subscriptions')
  await test('closeSettings')

  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await page.waitForFunction(
    (firstIdentifier) => {
      const state = window.__vengeanceTest.agentState()
      return state?.info.agentId !== firstIdentifier && state?.info.engine === 'prime'
    },
    firstAgentId,
    { timeout: READY_TIMEOUT_MS }
  )
  assert.equal((await test('agentState', firstAgentId)).info.engine, 'pi')
  await shot('settings-engine-new-session-default')

  await page.locator('[data-session-row]', { hasText: LONG_SESSION_TITLE }).first().click()
  await test('openSettings', 'providers')
  await settings.getByRole('combobox', { name: 'Settings engine' }).getByText('Engine 2').waitFor()
  assert.equal((await test('agentState')).info.agentId, firstAgentId)
  assert.equal((await test('agentState')).info.engine, 'pi')
  await test('closeSettings')

  const inspector = page.getByRole('tablist', { name: 'Inspector' })
  if (!(await inspector.isVisible())) await page.keyboard.press('ControlOrMeta+i')
  await inspector.getByRole('tab', { name: 'Tools', exact: true }).click()
  await page
    .getByRole('tabpanel', { name: 'Tools', exact: true })
    .getByRole('button', { name: 'Agent behavior', exact: true })
    .click()
  await settings
    .getByRole('combobox', { name: 'Settings engine' })
    .getByText('Engine', { exact: true })
    .waitFor()
  await settings.getByText('New sessions in this workspace use Engine 2.').waitFor()
  const applyDefault = settings.getByRole('button', {
    name: 'Use Engine for new sessions',
    exact: true
  })
  await applyDefault.waitFor()
  await shot('settings-engine-session-target-mismatch')
  await applyDefault.click()
  await settings.getByText('New sessions in this workspace use Engine.').waitFor()
  assert.equal((await test('agentState', firstAgentId)).info.engine, 'pi')
  await chooseEngine(page, 'Engine 2')
  await test('closeSettings')
}
