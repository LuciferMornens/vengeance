// Refused sign-ins: when a provider refuses to renew a sign-in, the Engine marks the credential in auth.json
// (`refreshRejectedAt`). This scenario writes those marks itself, on fake tokens. Onboarding shows the provider's
// sign-in card as Sign-in expired; Settings → Providers shows Sign-in expired with Sign in again. A mark shows up
// live without a restart offer; a new sign-in that clears it offers one. The only file it writes is auth.json in the
// app's PI_CODING_AGENT_DIR, which the harness has checked is the mock's seeded agent dir in this file's temp root.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REJECTED_AT = Date.UTC(2026, 9, 20, 9, 30)
/** Fake ChatGPT sign-in tokens (never real secrets), expired an hour before the provider refused them. */
const chatgpt = (tokens, mark) => ({
  type: 'oauth',
  access: `mock-chatgpt-access-${tokens}`,
  refresh: `mock-chatgpt-refresh-${tokens}`,
  expires: REJECTED_AT - 3_600_000,
  accountId: 'mock-account',
  ...(mark ? { refreshRejectedAt: REJECTED_AT } : {})
})

export async function scenarios(page, { app, shot, test, wait, MOCK_WORKSPACE }) {
  const agentDir = await app.evaluate(() => process.env.PI_CODING_AGENT_DIR)
  const authPath = join(agentDir, 'auth.json')
  const seeded = JSON.parse(await readFile(authPath, 'utf8'))
  const writeAuth = (credentials) =>
    writeFile(authPath, `${JSON.stringify({ ...seeded, ...credentials }, null, 2)}\n`)
  const sheet = page.locator('[role="dialog"]').first()
  const row = (provider) => sheet.locator(`[id="setting-provider.${provider}"]`)
  const noRestartOffer = async (label) => {
    await wait(1500)
    assert.equal(await page.getByText('Restart to apply').count(), 0, label)
  }
  const dismissToasts = async () => {
    for (const button of await page.locator('button[aria-label="Dismiss"]').all())
      await button.click().catch(() => undefined)
    // Off the sidebar, so no row keeps a hover highlight in the screenshots.
    await page.mouse.move(300, 880)
    await wait(200)
  }

  // ─── Onboarding: the mark arrives while the provider step is open ─────────
  await writeAuth({ openai: chatgpt('a', false) })
  await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('You’re connected').waitFor({ timeout: 15_000 })
  await writeAuth({ openai: chatgpt('a', true) })
  const card = page.getByRole('button', { name: /ChatGPT.*Sign-in expired/ })
  await card.waitFor({ timeout: 10_000 })
  await shot('providers-expired-onboarding', { settleMs: 700 })
  await page.getByRole('button', { name: 'Continue' }).click()

  // ─── Settings → Providers ─────────────────────────────────────────────────
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi' })
  await test('openSettings', 'providers')
  const openai = row('openai')
  await openai.getByText('Sign-in expired', { exact: true }).waitFor({ timeout: 15_000 })
  const again = openai.getByRole('button', { name: 'Sign in again', exact: true })
  const explanation = await again.evaluate(
    (button) => document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent
  )
  assert.equal(
    explanation,
    'The provider rejected the saved sign-in. Sign in again to use its models.'
  )
  assert.equal(await openai.getByRole('button', { name: 'Reconnect' }).count(), 0)

  // A new sign-in outside Vengeance replaces the credential (the mark goes): open sessions list the provider again
  // after a restart, so it is offered like any sign-in. A refused one coming back applies live.
  await writeAuth({ openai: chatgpt('b', false) })
  await openai.getByRole('button', { name: 'Reconnect', exact: true }).waitFor({ timeout: 10_000 })
  await page.getByText('Sign-ins changed.', { exact: false }).waitFor({ timeout: 10_000 })
  await dismissToasts()
  await writeAuth({
    anthropic: { ...seeded.anthropic, refreshRejectedAt: REJECTED_AT },
    openai: chatgpt('b', true)
  })
  await again.waitFor({ timeout: 10_000 })
  await row('anthropic').getByText('Sign-in expired', { exact: true }).waitFor({ timeout: 10_000 })
  await noRestartOffer('a refused sign-in offers no restart')
  await sheet
    .getByText('Credentials the engine can use right now, and sign-ins to renew.')
    .waitFor()
  await shot('providers-expired-settings', { settleMs: 600 })

  // Sign in again starts the provider's own sign-in.
  await again.click()
  await page.getByRole('dialog', { name: 'Sign in to ChatGPT' }).waitFor()
  await shot('providers-expired-sign-in-again', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Sign in to ChatGPT' }).waitFor({ state: 'detached' })
  await test('closeSettings')

  // ─── Chat: a reply that fails on the expired sign-in names the remedy, not the endpoint's error code ──
  // The conversation runs on Anthropic's default model, whose sign-in the step above marked refused.
  await test('mockPlay', {
    script: 'expired-sign-in',
    instant: true,
    prompt: 'Summarize the open issues.'
  })
  const failure = page
    .locator('[data-transcript-scroll]')
    .getByRole('button', { name: 'Sign in again' })
  await failure.waitFor({ timeout: 10_000 })
  const transcript = page.locator('[data-transcript-scroll]')
  await transcript.getByText('Sign-in expired', { exact: true }).waitFor()
  // The card names the conversation's own provider and model, as the composer does.
  await transcript.getByText('Anthropic · claude-sonnet-4-5', { exact: true }).waitFor()
  // The token endpoint's error code was the card's title before the Engine's message was recognised.
  assert.equal(await transcript.getByText('invalid_grant', { exact: true }).count(), 0)
  await dismissToasts()
  await shot('providers-expired-chat', { settleMs: 600 })
  await failure.click()
  await row('anthropic').getByText('Sign-in expired', { exact: true }).waitFor({ timeout: 10_000 })
  await test('closeSettings')
}
