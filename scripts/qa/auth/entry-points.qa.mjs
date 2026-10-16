// The other ways into sign-in: the onboarding "Connect a provider" step (first run, no workspace)
// and the composer's /login and /logout. The onboarding step must offer the engine's providers
// the same way Settings → Providers does; OAuth is started and CANCELLED (browser stubbed).
import assert from 'node:assert/strict'
import { runSuite } from '../lib/suite.mjs'
import {
  LAUNCH,
  providerRow,
  readTempAuth,
  softSteps,
  stubMainNetwork,
  waitUntil
} from './helpers.mjs'

const KEY = 'qa-test-value'

await runSuite(
  'auth-entry-points',
  async ({ agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    await stubMainNetwork(app)
    let catalog
    let featured

    await step('first run: onboarding → Engine detected → Continue', async () => {
      await page.getByText('Engine detected').waitFor()
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByText('API key', { exact: true }).waitFor()
      catalog = await app.invoke('settings:catalog')
      await app.screenshot('entry-01-onboarding-provider')
    })

    await step('provider step: connected chips are the configured providers', async () => {
      const configured = catalog.providers.filter((p) => p.status.configured)
      await page.getByRole('heading', { name: 'You’re connected' }).waitFor()
      for (const provider of configured) await page.getByText(provider.name).first().waitFor()
    })

    await step('provider step: sign-in cards are OAuth providers of the engine', async () => {
      const cards = page.locator('button:has(svg.lucide-shield-check)')
      featured = await cards.evaluateAll((buttons) =>
        buttons.map((button) => button.querySelector('span span')?.textContent ?? '')
      )
      assert.equal(featured.length, 4, `four sign-in cards: ${featured.join(', ')}`)
      // Cards are titled with the engine's provider names, like Settings → Providers (auth-9).
      const oauthTitles = new Set(catalog.providers.filter((p) => p.oauth).map((p) => p.name))
      for (const title of featured)
        assert.ok(oauthTitles.has(title), `${title} is an OAuth provider`)
    })

    // auth-4: onboarding features current providers (`openai`, "Sign in with ChatGPT"), never one
    // the engine marks as legacy ("OpenAI Codex (legacy)").
    await soft.step('provider step: no legacy provider among the sign-in cards', async () => {
      const legacy = catalog.providers.filter((p) => p.oauth && /legacy/i.test(p.name))
      assert.ok(legacy.length > 0, 'the engine marks a provider as legacy')
      const subtitles = await page
        .locator('button:has(svg.lucide-shield-check)')
        .evaluateAll((buttons) => buttons.map((button) => button.innerText.replace(/\s+/g, ' ')))
      for (const provider of legacy) {
        const plan = provider.oauth.name.match(/\((.*)\)/)?.[1] ?? provider.oauth.name
        assert.ok(
          !subtitles.some((text) => text.includes(plan)),
          `${provider.id} ("${provider.name}") is featured as: ${subtitles.join(' | ')}`
        )
      }
    })

    await step(
      'provider step: the API-key list is every engine provider with key auth',
      async () => {
        await page.getByText('API key', { exact: true }).locator('..').getByRole('combobox').click()
        const options = await page.getByRole('option').allInnerTexts()
        const expected = catalog.providers.filter((p) => p.apiKey).map((p) => p.name)
        assert.deepEqual([...options].sort(), [...expected].sort())
        await app.screenshot('entry-02-onboarding-key-list')
        await page.getByRole('option', { name: 'OpenRouter', exact: true }).click()
      }
    )

    await step(
      'provider step: Anthropic card starts the same sign-in dialog; close cancels',
      async () => {
        await page.locator('button:has(svg.lucide-shield-check)', { hasText: 'Anthropic' }).click()
        const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
        await dialog.getByText('Select Anthropic login method:').waitFor()
        await dialog.getByRole('button', { name: 'Browser login (default)' }).click()
        await dialog.getByText('Your browser opened the sign-in page').waitFor()
        await app.screenshot('entry-03-onboarding-oauth')
        await dialog.getByRole('button', { name: 'Close' }).click()
        await dialog.waitFor({ state: 'detached' })
        assert.ok(!(await readTempAuth(agentDir))?.anthropic)
      }
    )

    await step(
      'provider step: Add key stores an OpenRouter key and shows it connected',
      async () => {
        await page.getByRole('button', { name: 'Add key' }).click()
        const dialog = page.getByRole('dialog', { name: 'OpenRouter API key' })
        await dialog.locator('input').first().fill(KEY)
        await dialog.getByRole('button', { name: 'Save key' }).click()
        await dialog.getByText('Connected').waitFor()
        const auth = await waitUntil(async () => (await readTempAuth(agentDir))?.openrouter, {
          label: 'auth.json openrouter'
        })
        assert.deepEqual(auth, { type: 'api_key', key: KEY })
        await dialog.waitFor({ state: 'detached' })
        await page.locator('span.rounded-full', { hasText: 'OpenRouter' }).waitFor()
        await app.screenshot('entry-04-onboarding-connected')
      }
    )

    await step('open a workspace', async () => {
      await app.openWorkspace()
    })

    async function slash(text) {
      const composer = page.getByRole('textbox', { name: 'Message' })
      await composer.fill(text)
      await composer.press('Enter')
    }

    await step('/login opens Settings → Providers & accounts', async () => {
      await slash('/login')
      await page.getByRole('heading', { name: 'Providers & accounts', exact: true }).waitFor()
      assert.equal((await app.appState()).ui.settingsSection, 'providers')
      assert.equal((await app.agentState()).entries.length, 0, 'nothing was sent to the engine')
      await app.test('closeSettings')
    })

    await step('/login github copilot jumps to that provider', async () => {
      await slash('/login github copilot')
      const row = providerRow(page, 'github-copilot')
      await row.locator('.bg-info-soft').waitFor()
      await app.screenshot('entry-05-login-provider')
      await app.test('closeSettings')
    })

    // In the engine's /logout, the user picks one of the providers with a stored credential.
    await step('/logout opens Providers where the stored key can be removed', async () => {
      await slash('/logout')
      await page.getByRole('heading', { name: 'Providers & accounts', exact: true }).waitFor()
      const row = providerRow(page, 'openrouter')
      await row.getByRole('button', { name: 'Remove key' }).click()
      await page.getByText('Signed out of OpenRouter').waitFor()
      assert.ok(!(await readTempAuth(agentDir))?.openrouter)
    })

    soft.finish()
  },
  { launch: { ...LAUNCH, env: { OPENROUTER_API_KEY: undefined } } }
)
