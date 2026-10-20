// MCP servers of a conversation: the chip above the composer, its panel with each server's state,
// error and actions (reconnect, on/off for this folder), extension status details, and the live rows
// in Settings for both engines.
import assert from 'node:assert/strict'

async function chooseSettingsEngine(page, engineLabel) {
  await page.getByRole('combobox', { name: 'Settings engine' }).click()
  await page
    .getByRole('option')
    .filter({ has: page.getByText(engineLabel, { exact: true }) })
    .click()
}

export async function scenarios(page, { shot, test, wait, MOCK_WORKSPACE }) {
  const command = (message) =>
    page.evaluate(
      (m) =>
        window.vengeance.invoke('engine:command', window.__vengeanceTest.activeAgentId(), {
          type: 'prompt',
          message: m
        }),
      message
    )
  const chip = page.locator('[data-mcp-chip] >> visible=true')
  const panel = page.locator('[data-mcp-panel]')
  const server = (name, state) =>
    panel.locator(`[data-mcp-server="${name}"]${state ? `[data-mcp-state="${state}"]` : ''}`)

  await test('setPrefs', { theme: 'dark' })
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi', name: 'Wire the billing webhooks' })
  await chip.waitFor()
  assert.equal(await chip.getAttribute('data-mcp-chip'), 'failed')
  assert.match(await chip.innerText(), /MCP 2\/4\s*· 2 need attention/)
  await shot('mcp-chip-dark')

  await chip.click()
  await panel.waitFor()
  assert.equal(await panel.locator('[data-mcp-server]').count(), 5)
  assert.match(await server('filesystem').innerText(), /Connected · 5 tools/)
  assert.match(await server('sentry').innerText(), /Needs sign-in/)
  await shot('mcp-panel-dark')
  await server('linear').locator('button[aria-expanded]').click()
  assert.match(await server('linear').innerText(), /npx: command exited with code 1/)
  await shot('mcp-panel-error-dark')

  await server('linear').getByRole('button', { name: 'Reconnect linear', exact: true }).click()
  await server('linear', 'connecting').waitFor()
  // The previous failure is stale while the server reconnects: the row no longer shows it.
  assert.doesNotMatch(await server('linear').innerText(), /npx: command exited with code 1/)
  await shot('mcp-panel-reconnecting-dark', { settleMs: 100 })
  await server('linear', 'connected').waitFor()
  // The mock trusts its folder, so a switch saves an override there and never the global mcp.json.
  const postgres = panel.getByRole('switch', { name: 'Turn on postgres for this folder', exact: true })
  await postgres.hover()
  const tooltip = page.getByRole('tooltip')
  await tooltip.waitFor()
  assert.match(await tooltip.innerText(), /Saved to the project mcp\.json, for this folder only/)
  assert.equal(await panel.getByText(/for every folder/).count(), 0, 'nothing here changes every folder')
  await shot('mcp-panel-switch-dark')
  await postgres.click()
  await server('postgres', 'connected').waitFor()
  await panel.getByRole('switch', { name: 'Turn off postgres for this folder', exact: true }).waitFor()
  assert.match(await chip.innerText(), /MCP 4\/5\s*· 1 needs attention/)
  await shot('mcp-panel-after-dark')
  await test('setPrefs', { theme: 'light' })
  await shot('mcp-panel-bone', { settleMs: 700 })
  await test('setPrefs', { theme: 'dark' })
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })

  // Every status chip opens what it abbreviates.
  await command('/mock-ui status')
  const rateGuard = page.locator('[data-status-chip="rate-guard"] >> visible=true')
  await rateGuard.waitFor()
  await rateGuard.click()
  const details = page.locator('[data-status-details]')
  await details.waitFor()
  assert.match(await details.innerText(), /to stay under the hourly limit/)
  await shot('status-chip-details-dark')
  await page.keyboard.press('Escape')
  await command('/mock-ui status-clear')
  await rateGuard.waitFor({ state: 'detached' })

  // Settings shows what the open session reports, with Reconnect beside each running server.
  await test('openSettings', 'mcp')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.locator('[data-mcp-row-live]').first().waitFor()
  assert.equal(
    await settings.locator('[data-mcp-row-live][data-mcp-row-state="needs-auth"]').count(),
    1,
    'sentry needs sign-in in the open session'
  )
  await settings
    .getByRole('button', { name: 'Reconnect github in open sessions in this folder', exact: true })
    .waitFor()
  await shot('mcp-settings-live-dark', { settleMs: 1000 })
  await test('closeSettings')

  // Engine 2: the kernel reports when asked; reconnect reloads the server before it answers.
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'prime', name: 'Native MCP review' })
  await chip.waitFor({ timeout: 20_000 })
  assert.match(await chip.innerText(), /MCP 2\/4/)
  await chip.click()
  await panel.waitFor()
  assert.equal(await panel.getByRole('switch').count(), 0, 'Engine 2 turns servers on and off in Settings')
  await server('linear').getByRole('button', { name: 'Reconnect linear', exact: true }).click()
  await server('linear', 'connected').waitFor()
  await shot('mcp-panel-prime-dark')
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })

  await test('openSettings', 'mcp')
  await chooseSettingsEngine(page, 'Engine 2')
  await settings.locator('[data-mcp-row-live]').first().waitFor({ timeout: 20_000 })
  await settings
    .getByRole('button', { name: 'Reconnect github in open sessions in this folder', exact: true })
    .waitFor()
  await shot('mcp-settings-prime-dark', { settleMs: 1000 })
  await test('closeSettings')
  await wait(200)
}
