// Launch lane scenarios: the project Trust dialog (before the engine starts, and re-opened from the palette),
// the workspace launch-options editor (every section, extension flags discovered from the engine help),
// and "New session with options…" pre-filled from the workspace defaults.
// Mock mode: the engine config is a seeded temp agent dir; defaultProjectTrust is switched to "ask" here.
import { join } from 'node:path'
import { mockHomePath } from './lib/mock-paths.mjs'

export async function scenarios(page, { shot, test, wait, MOCK_WORKSPACE }) {
  const dialog = page.getByRole('dialog').last()
  const settle = async () => {
    await page.mouse.move(1400, 880)
    for (const button of await page.getByRole('button', { name: 'Dismiss' }).all())
      await button.click().catch(() => undefined)
  }
  /** Run a palette action by its title. */
  const action = async (title) => {
    await test('setPalette', true)
    await page.keyboard.type(title, { delay: 8 })
    await wait(250)
    await page.keyboard.press('Enter')
    await wait(200)
  }
  const section = async (label, name) => {
    await dialog.getByRole('navigation').getByRole('button', { name: label }).click()
    await dialog.locator('[data-launch-scroll]').evaluate((el) => (el.scrollTop = 0))
    await settle()
    await shot(name, { settleMs: 500 })
  }

  await test('setPrefs', {
    workspaces: [{ path: MOCK_WORKSPACE, name: 'aurora', lastOpenedAt: Date.now() }]
  })
  await page.evaluate(() =>
    window.vengeance.invoke('settings:set', {
      scope: 'global',
      cwd: null,
      path: ['defaultProjectTrust'],
      value: 'ask'
    })
  )

  // ─── Trust dialog before the first engine starts ─────────────────────────
  await page.evaluate((cwd) => void window.__vengeanceTest.openWorkspace(cwd), MOCK_WORKSPACE)
  await page.getByText('Trust “aurora”?').waitFor({ timeout: 15_000 })
  await settle()
  await shot('launch-trust-dialog', { settleMs: 600 })
  await page.keyboard.press('ArrowDown')
  await shot('launch-trust-dialog-keyboard', { settleMs: 300 })
  await page.keyboard.press('1')
  await page.getByText('Trust “aurora”?').waitFor({ state: 'hidden' })
  await page.waitForFunction(() => !!window.__vengeanceTest.activeAgentId(), null, {
    timeout: 30_000
  })
  await wait(600)

  // ─── Workspace launch options, every section ─────────────────────────────
  await action('Workspace launch options')
  await dialog.getByText('Launch options', { exact: true }).waitFor()
  await dialog.getByLabel('Allowed tools').fill('read,grep,find,')
  await dialog.getByLabel('Excluded tools').fill('mcp__*,')
  await dialog.getByLabel('Excluded tools').press('Enter')
  await section('Tools', 'launch-options-tools')

  await dialog.getByRole('navigation').getByRole('button', { name: 'Resources' }).click()
  await dialog.getByLabel('Load context files').click()
  await dialog.getByLabel('Load mcp servers').click()
  await dialog.getByPlaceholder('./tools/review.ts or builtin:mcp').fill('builtin:codemode')
  await dialog.getByPlaceholder('./tools/review.ts or builtin:mcp').press('Enter')
  await dialog.getByPlaceholder('Skill file or folder').fill(mockHomePath('skills', 'release-notes'))
  await dialog.getByPlaceholder('Skill file or folder').press('Enter')
  await section('Resources', 'launch-options-resources')

  await dialog.getByRole('navigation').getByRole('button', { name: 'System prompt' }).click()
  await dialog.getByRole('button', { name: 'Text' }).click()
  await dialog
    .getByLabel('Appended prompt 1', { exact: true })
    .fill('Prefer small, reviewable commits. Explain risky changes before making them.')
  await dialog.getByRole('button', { name: 'Text' }).click()
  await dialog.getByLabel('Appended prompt 2', { exact: true }).fill(join('.pi', 'team-conventions.md'))
  await section('System prompt', 'launch-options-system-prompt')

  await dialog.getByRole('navigation').getByRole('button', { name: 'Models' }).click()
  await dialog.getByLabel('Model scope').fill('anthropic/*,gpt-5:high,')
  await dialog.getByLabel('Offline').click()
  await section('Models', 'launch-options-models')

  await dialog.getByRole('navigation').getByRole('button', { name: 'Environment' }).click()
  await dialog.getByRole('button', { name: 'Variable' }).click()
  await dialog.getByLabel('Variable name').last().fill('PI_CACHE_RETENTION')
  await dialog.getByLabel('Value of PI_CACHE_RETENTION').fill('long')
  await dialog.getByRole('button', { name: 'Variable' }).click()
  await dialog.getByLabel('Variable name').last().fill('OPENROUTER_API_KEY')
  await dialog.getByLabel('Value of OPENROUTER_API_KEY').fill('qa-test-value')
  await section('Environment', 'launch-options-environment')

  await dialog.getByRole('navigation').getByRole('button', { name: 'Extension flags' }).click()
  await dialog.getByLabel('Disable autoformat').waitFor()
  await dialog.getByLabel('Disable autoformat').click()
  await dialog.getByLabel('Subagent worktrees').click()
  await dialog.getByLabel('Subagent max').fill('6')
  await section('Extension flags', 'launch-options-extension-flags')
  await dialog.getByRole('button', { name: 'Show engine command' }).click()
  await settle()
  await shot('launch-options-engine-command', { settleMs: 500 })
  const preview = await dialog.getByTestId('engine-arguments').innerText()
  for (const expected of [
    '--tools read,grep,find',
    '--no-context-files',
    '--offline',
    '--no-autoformat',
    '--subagent-max 6'
  ]) {
    if (!preview.includes(expected))
      throw new Error(`Engine arguments preview misses "${expected}": ${preview}`)
  }
  await dialog.getByRole('button', { name: 'Save defaults' }).click()
  await wait(400)

  // ─── New session with options (pre-filled from the defaults) ─────────────
  await action('New session with options')
  await dialog.getByText('New session with options').waitFor()
  await dialog.getByRole('navigation').getByRole('button', { name: 'Extension flags' }).click()
  await dialog.getByLabel('Disable lens').click()
  await settle()
  await shot('launch-new-session-with-options', { settleMs: 500 })
  const agentsBefore = await page.evaluate(() => window.__vengeanceTest.activeAgentId())
  await dialog.getByRole('button', { name: 'Start session' }).click()
  await page.waitForFunction(
    (before) => window.__vengeanceTest.activeAgentId() !== before,
    agentsBefore,
    { timeout: 30_000 }
  )
  await wait(600)

  // ─── Project trust re-opened from the palette (/trust) ───────────────────
  await action('Project trust')
  await page.getByText('Project trust for “aurora”').waitFor()
  await settle()
  await shot('launch-trust-manage', { settleMs: 500 })
  await page.keyboard.press('Escape')
  await wait(300)

  // Light theme: the decide dialog for another folder.
  await test('setPrefs', { theme: 'light' })
  await page.evaluate((cwd) => void window.__vengeanceTest.openWorkspace(cwd), mockHomePath('projects', 'nightshade'))
  await page.getByText('Trust “nightshade”?').waitFor({ timeout: 15_000 })
  await settle()
  await shot('launch-trust-dialog-light', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await page.getByText('Trust “nightshade”?').waitFor({ state: 'hidden' })
}
