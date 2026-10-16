import assert from 'node:assert/strict'

const SAVED_SESSION_NAME = 'Release follow-up'
const TEMPORARY_SESSION_NAME = 'Temporary review'
const SAVED_CLOSE_TOOLTIP = 'Close tab — session keeps running in Background sessions'
const TEMPORARY_CLOSE_TOOLTIP = 'Close tab — stops this temporary session'

function closeButton(page, title) {
  return page
    .locator('section[aria-label="Open sessions"] [data-session-row]', { hasText: title })
    .locator('xpath=..')
    .getByRole('button', { name: 'Close tab', exact: true })
}

export async function scenarios(page, { app, shot, test, MOCK_WORKSPACE }) {
  await test('setPrefs', {
    theme: 'dark',
    workspaces: [{ path: MOCK_WORKSPACE, name: 'aurora', lastOpenedAt: Date.now() }],
    activeWorkspace: MOCK_WORKSPACE,
    features: { sessions: { pinned: [], scope: 'workspace', collapsed: [] } }
  })
  await test('openWorkspace', MOCK_WORKSPACE, {
    engine: 'prime',
    name: SAVED_SESSION_NAME
  })
  await closeButton(page, SAVED_SESSION_NAME).hover()
  await page.getByRole('tooltip').getByText(SAVED_CLOSE_TOOLTIP, { exact: true }).waitFor()
  await shot('session-close-keeps-running-dark')
  await page.mouse.move(760, 300)
  await page.getByRole('button', { name: 'Controls', exact: true }).click()
  const controls = page.getByRole('dialog', { name: 'Engine 2 session controls', exact: true })
  await controls.getByText('Closing this tab keeps the session running.', { exact: true }).waitFor()
  await controls.getByRole('button', { name: 'Stop session…', exact: true }).click()
  await controls
    .getByText('Stops this session and cancels its scheduled work. Saved history remains.')
    .waitFor()
  await shot('session-stop-confirm-dark')
  await test('setPrefs', { theme: 'light' })
  await shot('session-stop-confirm-bone')
  await controls.getByRole('button', { name: 'Keep running', exact: true }).click()
  await page.keyboard.press('Escape')
  await test('setPrefs', { theme: 'dark' })

  await test('openWorkspace', MOCK_WORKSPACE, {
    engine: 'prime',
    name: TEMPORARY_SESSION_NAME,
    noSession: true
  })
  await closeButton(page, TEMPORARY_SESSION_NAME).hover()
  await page.getByRole('tooltip').getByText(TEMPORARY_CLOSE_TOOLTIP, { exact: true }).waitFor()
  await shot('session-close-temporary-dark')
  await page.mouse.move(760, 300)
  await page.getByRole('button', { name: 'Controls', exact: true }).click()
  await controls
    .getByText('Closing this tab stops the temporary session.', { exact: true })
    .waitFor()
  assert.equal(
    await controls
      .getByText('Closing this tab keeps the session running.', { exact: true })
      .count(),
    0
  )
  await shot('session-close-temporary-controls-dark')
  await page.keyboard.press('Escape')

  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'prime', name: 'Delete this conversation' })
  const deletingId = await test('activeAgentId')
  const deletingRow = page
    .locator('section[aria-label="Open sessions"] [data-session-row]', {
      hasText: 'Delete this conversation'
    })
    .locator('xpath=..')
  await deletingRow.hover()
  await deletingRow.getByRole('button', { name: 'Delete session', exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete this session?', exact: true })
  await deleteDialog.getByText(/Its running work and schedules will stop/).waitFor()
  await shot('session-delete-confirm-dark')
  await app.evaluate(({ ipcMain }) => {
    let attempts = 0
    ipcMain.removeHandler('sessions:trash')
    ipcMain.handle('sessions:trash', async () => {
      attempts++
      if (attempts === 1) {
        return { ok: false, error: { message: 'The session file is temporarily locked.' } }
      }
      return { ok: true }
    })
  })
  await deleteDialog.getByRole('button', { name: 'Move to Recycle Bin', exact: true }).click()
  await deleteDialog
    .getByRole('alert')
    .getByText(/temporarily locked/)
    .waitFor()
  assert.ok(await test('agentState', deletingId), 'a failed delete keeps the open tab available')
  await shot('session-delete-retry-dark')
  await deleteDialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await deleteDialog.waitFor({ state: 'hidden' })
  assert.equal(await test('agentState', deletingId), null, 'a successful delete closes the tab')
}
