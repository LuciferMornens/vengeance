import assert from 'node:assert/strict'

const HISTORY_HINT = 'Shell · output kept in history'
const EXCLUDED_HINT = 'Shell · output kept out of context'
const CONTEXT_NOTICE =
  'Engine 2 may not use this shell output in the next turn. Paste the relevant output into your message.'

export async function scenarios(page, { shot, test, tempDir }) {
  const cwd = await tempDir('native-shell-workspace-')
  await test('setPrefs', {
    theme: 'dark',
    workspaces: [{ path: cwd, name: 'Shell output', lastOpenedAt: Date.now() }],
    activeWorkspace: cwd,
    onboardingCompleted: true
  })
  await test('openWorkspace', cwd, { engine: 'prime' })
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('!git status --short')
  await page.getByText(HISTORY_HINT, { exact: true }).waitFor()
  await shot('prime-bash-history-hint-dark')
  await composer.press('Enter')
  const notice = page.getByText(CONTEXT_NOTICE, { exact: true })
  await notice.waitFor()
  await page.getByRole('button', { name: 'Copy output', exact: true }).waitFor()
  await shot('prime-bash-output-notice-dark')

  await composer.fill('!!git diff --stat')
  await page.getByText(EXCLUDED_HINT, { exact: true }).waitFor()
  await composer.press('Enter')
  await page.waitForFunction(() => {
    const state = window.__vengeanceTest.agentState()
    return state.entries.some(
      (entry) =>
        entry.message.role === 'bashExecution' && entry.message.command === 'git diff --stat'
    )
  })
  assert.equal(await notice.count(), 1, 'excluded output does not gain the native context notice')
  await test('setPrefs', { theme: 'light' })
  await shot('prime-bash-included-and-excluded-bone')

  await test('openWorkspace', cwd, { engine: 'pi', approve: true })
  await composer.fill('!git status --short')
  await page.getByText('Shell · output added to context', { exact: true }).waitFor()
  await composer.press('Enter')
  await page.waitForFunction(() => {
    const state = window.__vengeanceTest.agentState()
    return state.entries.some((entry) => entry.message.role === 'bashExecution')
  })
  assert.equal(await notice.count(), 0, 'Engine shell output keeps its native context behavior')
  await test('setPrefs', { theme: 'dark' })
}
