// A provider overload that outlived the automatic retries: Kimi Code's 429 engine_overloaded_error reads as the
// provider's capacity, not the account's rate limit, and offers another model.
import assert from 'node:assert/strict'
import { MOCK_WORKSPACE } from './lib/mock-paths.mjs'

const KIMI_OVERLOAD =
  '429 {"error":{"message":"The engine is currently overloaded, please try again later","type":"engine_overloaded_error"}}'

export async function scenarios(page, { app, shot, test }) {
  await test('setPrefs', { onboardingCompleted: true, theme: 'dark' })
  const agentId = await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi' })
  const send = (event) =>
    app.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('engine:event', payload)
      },
      { agentId, event }
    )
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
  const user = { role: 'user', content: 'Refactor the session store', timestamp: Date.now() }
  const failed = {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'kimi-coding',
    model: 'k3.1-pro-highspeed',
    usage,
    stopReason: 'error',
    errorMessage: KIMI_OVERLOAD,
    timestamp: Date.now()
  }
  await send({ type: 'agent_start' })
  await send({ type: 'message_start', message: user })
  await send({ type: 'message_end', message: user })
  await send({ type: 'message_start', message: failed })
  await send({ type: 'message_end', message: failed })
  await send({ type: 'agent_end', messages: [user, failed], willRetry: false })
  await send({ type: 'agent_settled', aborted: false })

  await page.getByText('The provider is overloaded', { exact: true }).waitFor()
  assert.equal(await page.getByText(/rate limit/i).count(), 0)
  const change = page.getByRole('button', { name: 'Change model', exact: true })
  await change.waitFor()
  await shot('provider-overload-dark')

  await change.click()
  await page.getByPlaceholder('Search models…').waitFor()
  await shot('provider-overload-picker-dark')
  await page.keyboard.press('Escape')
}
