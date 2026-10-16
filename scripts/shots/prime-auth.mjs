import assert from 'node:assert/strict'

const MCP_NAME = 'fixture-mcp'
const ANTHROPIC_KEY = 'fixture-anthropic-key-not-real'
const FULL_WINDOW = { width: 1440, height: 900 }
const NARROW_WINDOW = { width: 880, height: 760 }

export async function scenarios(page, { app, shot, test, MOCK_WORKSPACE }) {
  await test('openWorkspace', MOCK_WORKSPACE)
  await test('openSettings', 'providers')
  await page.getByRole('combobox', { name: 'Settings engine' }).click()
  await page.getByRole('option', { name: /^Engine 2(?:\s|$)/ }).click()

  const sheet = page.locator('[role="dialog"]').first()
  await sheet.getByRole('heading', { name: 'Subscriptions' }).waitFor()

  const anthropic = sheet.locator('[id="setting-provider.anthropic"]')
  await anthropic.getByRole('button', { name: 'API key', exact: true }).click()
  const keyDialog = page.getByRole('dialog', { name: 'Anthropic API key', exact: true })
  await keyDialog.locator('input[type="password"]').fill(ANTHROPIC_KEY)
  await keyDialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await keyDialog.waitFor({ state: 'detached' })
  await anthropic.getByRole('button', { name: 'Replace key', exact: true }).waitFor()
  await anthropic.getByRole('button', { name: 'Remove key', exact: true }).waitFor()
  await anthropic.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  await shot('prime-auth-anthropic-key-subscription-actions')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, NARROW_WINDOW)
  await shot('prime-auth-anthropic-key-subscription-actions-narrow')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, FULL_WINDOW)
  await anthropic.getByRole('button', { name: 'Sign in', exact: true }).click()
  const anthropicDialog = page.getByRole('dialog', { name: 'Sign in to Anthropic', exact: true })
  await anthropicDialog.getByText('Your browser opened the sign-in page').waitFor()
  await shot('prime-auth-anthropic-subscription-from-key')
  await page.keyboard.press('Escape')
  await anthropicDialog.waitFor({ state: 'detached' })
  await anthropic.getByRole('button', { name: 'Replace key', exact: true }).waitFor()

  const subscription = sheet.locator('[id="setting-provider.openai-codex"]')
  await subscription.getByRole('button', { name: 'Sign in' }).click()
  await page.getByText('Your browser opened the sign-in page').waitFor()
  await shot('prime-auth-browser-subscription')
  await page.keyboard.press('Escape')

  const device = sheet.locator('[id="setting-provider.github-copilot"]')
  await device.getByRole('button', { name: 'Sign in' }).click()
  await page.getByText('VENG-2026').waitFor()
  await shot('prime-auth-device-code')
  await page.keyboard.press('Escape')

  await sheet.getByPlaceholder('Filter providers').fill('prime')
  const prime = sheet.locator('[id="setting-provider.prime-inference"]')
  await prime.getByRole('button', { name: 'API key' }).click()
  await page.getByText('Enter your API key.').waitFor()
  await shot('prime-auth-direct-key')
  const loginDialog = page.locator('[role="dialog"]').last()
  await loginDialog.locator('input[type="password"]').fill('fixture-key-not-real')
  await loginDialog.getByRole('button', { name: 'Save key' }).click()
  await loginDialog.getByRole('button', { name: 'Example team' }).waitFor()
  await shot('prime-auth-team-selection')
  await page.keyboard.press('Escape')

  await page.evaluate(
    ([workspace, serverName]) =>
      window.vengeance.invoke('engine:settings', {
        engine: 'prime',
        cwd: workspace,
        channel: 'settings:set',
        args: [
          {
            scope: 'global',
            cwd: null,
            path: ['mcpServers', serverName],
            value: {
              type: 'http',
              url: 'http://127.0.0.1:9/mcp',
              oauth: true,
              enabled: false
            }
          }
        ]
      }),
    [MOCK_WORKSPACE, MCP_NAME]
  )
  await test('closeSettings')
  await test('openSettings', 'mcp')
  await sheet.getByText(MCP_NAME).waitFor()
  await sheet.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByText('Your browser opened the sign-in page').waitFor()
  await page.getByText('Complete sign-in in your browser, or enter a test response.').waitFor()
  await shot('prime-auth-mcp-manual-code')
  await page.keyboard.press('Escape')
  await page.getByText('Sign in to fixture-mcp').waitFor({ state: 'hidden' })
  assert.equal(await sheet.getByText(MCP_NAME).count(), 1)
  await shot('prime-auth-mcp-cancelled')

  const isolation = await app.evaluate(() => ({
    piAgentDir: process.env.PI_CODING_AGENT_DIR,
    primeAgentDir: process.env.PRIME_AGENT_CODING_AGENT_DIR,
    temp: process.env.TEMP
  }))
  assert.ok(isolation.piAgentDir?.startsWith(isolation.temp))
  assert.ok(!isolation.primeAgentDir || isolation.primeAgentDir.startsWith(isolation.temp))
}
