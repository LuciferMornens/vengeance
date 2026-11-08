import assert from 'node:assert/strict'

export async function scenarios(page, { shot, test, MOCK_WORKSPACE }) {
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi' })
  await test('openSettings', 'providers')
  await page.getByRole('button', { name: /^Show all \d+ providers$/ }).click()
  const provider = page.locator('[id="setting-provider.audn"]')
  await provider.getByText('Audn', { exact: true }).waitFor()
  await provider.scrollIntoViewIfNeeded()
  await shot('audn-provider')
  await provider.getByRole('button', { name: 'Add key', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Audn API key', exact: true })
  await dialog.locator('input[type="password"]').waitFor()
  assert.equal(await dialog.getByRole('button', { name: 'Save key' }).isDisabled(), true)
  await shot('audn-sign-in')
}
