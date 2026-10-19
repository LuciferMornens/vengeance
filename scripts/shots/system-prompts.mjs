import assert from 'node:assert/strict'

async function settingsRequest(page, engine, channel, ...args) {
  return page.evaluate(
    ([backend, name, values]) =>
      window.vengeance.invoke('engine:settings', {
        engine: backend,
        channel: name,
        args: values
      }),
    [engine, channel, args]
  )
}

async function chooseEngine(page, label) {
  await page.getByRole('combobox', { name: 'Settings engine' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

export async function scenarios(page, { app, test, shot, MOCK_WORKSPACE }) {
  const agentId = await test('openWorkspace', MOCK_WORKSPACE, {
    engine: 'pi',
    name: 'Review the payment flow'
  })
  await test('openSettings', 'engine')
  await page.getByRole('button', { name: 'Edit prompts', exact: true }).click()
  const foundation = page.locator('[id="setting-instructions.SYSTEM.md"]')
  await foundation.getByRole('button', { name: 'Global', exact: true }).waitFor()
  await shot('system-prompts-engine-dark')
  await page.getByRole('button', { name: 'View default', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Engine built-in foundation', exact: true })
  await dialog.waitFor()
  assert.match(await dialog.locator('pre').innerText(), /expert coding assistant/)
  await shot('system-prompts-default-dark')
  await dialog.getByRole('button', { name: 'Customize foundation', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'SYSTEM.md · Global', exact: true })
  const editor = dialog.getByRole('textbox', { name: 'SYSTEM.md', exact: true })
  await editor.fill(
    'You are a careful engineer.\n\nVerify the payment flow and keep changes reviewable.'
  )
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).waitFor()
  await shot('system-prompts-unsaved-dark')
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await foundation.getByRole('button', { name: 'Global', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'SYSTEM.md · Global', exact: true })
  await dialog
    .getByRole('textbox', { name: 'SYSTEM.md', exact: true })
    .fill('Keep this draft safe while another editor saves.')
  await settingsRequest(
    page,
    'pi',
    'settings:instruction-file-write',
    MOCK_WORKSPACE,
    { kind: 'SYSTEM.md', scope: 'global' },
    'A newer foundation saved in another editor.'
  )
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.getByText(/This file changed outside the editor/).waitFor()
  await shot('system-prompts-conflict-dark')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await foundation.getByRole('button', { name: 'Global', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'SYSTEM.md · Global', exact: true })
  await dialog.getByRole('button', { name: 'Restore engine default', exact: true }).click()
  await shot('system-prompts-restore-dark')
  await dialog.getByRole('button', { name: 'Remove and restore', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    (
      await settingsRequest(page, 'pi', 'settings:instruction-file', MOCK_WORKSPACE, {
        kind: 'SYSTEM.md',
        scope: 'global'
      })
    ).exists,
    false
  )
  assert.equal((await test('agentState', agentId)).engineGeneration, 0)
  await page.getByRole('button', { name: 'View prompt', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Current session prompt', exact: true })
  await dialog.waitFor()
  await shot('system-prompts-current-dark')
  await page.keyboard.press('Escape')
  await test('setPrefs', { theme: 'light' })
  await page.locator('[id="setting-instructions.builtIn"]').scrollIntoViewIfNeeded()
  await shot('system-prompts-engine-bone')
  await chooseEngine(page, 'Engine 2')
  await page
    .getByText('Open an Engine 2 session in this workspace to inspect its assembled prompt.')
    .waitFor()
  await page.locator('[id="setting-instructions.builtIn"]').scrollIntoViewIfNeeded()
  await shot('system-prompts-no-session-bone')
  await page.getByRole('button', { name: 'View default', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Engine 2 built-in foundation', exact: true })
  await dialog.waitFor()
  await shot('system-prompts-engine2-default-bone')
  await page.keyboard.press('Escape')
  await test('closeSettings')
  await test('setPrefs', { theme: 'dark' })
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'prime', name: 'Validate release changes' })
  await test('openSettings', 'sessions')
  await chooseEngine(page, 'Engine 2')
  await page.getByRole('button', { name: 'View prompt', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Current session prompt', exact: true })
  await dialog.waitFor()
  assert.match(await dialog.locator('pre').innerText(), /You are a careful coding assistant/)
  await shot('system-prompts-engine2-current-dark')
  await page.keyboard.press('Escape')
  const append = page.locator('[id="setting-instructions.APPEND_SYSTEM.md"]')
  await append.getByRole('button', { name: 'Project', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'APPEND_SYSTEM.md · Project', exact: true })
  await dialog
    .getByRole('textbox', { name: 'APPEND_SYSTEM.md', exact: true })
    .fill('Check the release notes before making changes.')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(880, 760)
  )
  await shot('system-prompts-editor-narrow-dark')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
}
