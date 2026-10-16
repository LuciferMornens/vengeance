import assert from 'node:assert/strict'

const RECOVERY_TITLE = 'Conversation display interrupted'
const DRAFT = 'Keep this draft while the conversation recovers.'
const NARROW_WINDOW = { width: 880, height: 640 }

export async function scenarios(page, { app, shot, test, tempDir }) {
  const cwd = await tempDir('transcript-recovery-')
  await test('setPrefs', {
    onboardingCompleted: true,
    theme: 'dark',
    workspaces: [{ path: cwd, name: 'Stream recovery', lastOpenedAt: Date.now() }],
    activeWorkspace: cwd
  })
  const agentId = await test('openWorkspace', cwd, { engine: 'prime' })
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const send = (event) =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('engine:event', payload)
      },
      { agentId, event }
    )
  const message = {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'pending',
    timestamp: Date.now()
  }

  await send({ type: 'agent_start' })
  await send({ type: 'message_start', message })
  await composer.fill(DRAFT)
  // A malformed protocol field exercises React's error boundary through the public event pump.
  await send({
    type: 'message_update',
    usage: message.usage,
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: null }
  })
  await page.getByRole('heading', { name: RECOVERY_TITLE }).waitFor()
  assert.equal(await composer.inputValue(), DRAFT)
  assert.ok(await composer.isEditable())
  assert.ok(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible())
  assert.ok(await page.locator('header').isVisible())
  await shot('transcript-recovery-dark')
  await test('setPrefs', { theme: 'light' })
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, NARROW_WINDOW)
  await shot('transcript-recovery-bone-narrow')

  const recoveredText = 'The conversation is visible again. Your draft is still here.'
  await send({
    type: 'message_end',
    message: { ...message, content: [{ type: 'text', text: recoveredText }], stopReason: 'stop' }
  })
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await page.getByText(recoveredText, { exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: RECOVERY_TITLE }).count(), 0)
  assert.equal(await composer.inputValue(), DRAFT)
  assert.ok(errors.length > 0, 'the malformed frame reached the boundary')
  assert.ok(errors.every((error) => /Cannot read properties of null.*trim/s.test(error)))
  await shot('transcript-recovered-bone-narrow')

  // Mounting another session gives it a fresh boundary and leaves the recovered session available.
  await test('openWorkspace', cwd, { engine: 'pi', approve: true })
  assert.equal(await page.getByRole('heading', { name: RECOVERY_TITLE }).count(), 0)
  assert.ok(await composer.isEditable())
}
