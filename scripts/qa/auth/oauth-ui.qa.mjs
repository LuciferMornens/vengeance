// OAuth sign-in UI with the engine's real login flows, always CANCELLED, never completed:
//   - Anthropic (browser + local callback server): the sign-in URL, "Copy link", the paste-code
//     fallback, and a clean cancel (callback port closed, nothing stored);
//   - GitHub Copilot (device code): the code, the verification page, copy/open buttons, cancel.
// The main process's shell.openExternal and fetch are stubbed (helpers.stubMainNetwork): no
// browser opens and GitHub's device endpoints answer from canned JSON. The renderer clipboard is
// stubbed too, so the user's clipboard is never overwritten.
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { runSuite } from '../lib/suite.mjs'
import {
  LAUNCH,
  openSettings,
  providerRow,
  readTempAuth,
  softSteps,
  stubMainNetwork,
  waitUntil
} from './helpers.mjs'

const DEVICE = {
  device_code: 'qa-device-code',
  user_code: 'QAQA-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5
}

function portIsOpen(port) {
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolvePort(true)
    })
    socket.once('error', () => resolvePort(false))
  })
}

async function stubClipboard(page) {
  await page.evaluate(() => {
    window.__qaClipboard = []
    navigator.clipboard.writeText = async (text) => {
      window.__qaClipboard.push(text)
    }
  })
  return () => page.evaluate(() => [...window.__qaClipboard])
}

await runSuite(
  'auth-oauth-ui',
  async ({ agentDir, app, step }) => {
    const soft = softSteps(step)
    const page = app.page
    const network = await stubMainNetwork(app, [
      { prefix: 'https://github.com/login/device/code', json: DEVICE },
      {
        prefix: 'https://github.com/login/oauth/access_token',
        json: { error: 'authorization_pending' }
      }
    ])
    let callbackPort

    await step('open a workspace and Settings → Providers', async () => {
      await app.openWorkspace()
      await openSettings(app, 'providers', 'Providers & accounts')
    })
    const clipboard = await stubClipboard(page)

    await step('Anthropic: Sign in shows the browser step with the real sign-in URL', async () => {
      await providerRow(page, 'anthropic').getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
      // The engine first asks for the login method (select prompt).
      await dialog.getByText('Select Anthropic login method:').waitFor()
      await dialog.getByRole('button', { name: 'Copy code login (headless)' }).waitFor()
      await app.screenshot('oauth-00-anthropic-method')
      await dialog.getByRole('button', { name: 'Browser login (default)' }).click()
      await dialog.getByText('Your browser opened the sign-in page').waitFor()
      const url = await dialog.locator('code').first().innerText()
      const parsed = new URL(url)
      assert.equal(parsed.protocol, 'https:')
      assert.ok(parsed.searchParams.get('code_challenge'), 'PKCE challenge in the URL')
      const redirect = new URL(parsed.searchParams.get('redirect_uri'))
      assert.equal(redirect.hostname, 'localhost')
      callbackPort = Number(redirect.port)
      assert.ok(await portIsOpen(callbackPort), 'the engine callback server listens')
      assert.deepEqual(await network.opened(), [url], 'the browser was asked to open that URL')
      await app.screenshot('oauth-01-anthropic-browser')
    })

    await step('Anthropic: Copy link copies the full URL', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
      const url = await dialog.locator('code').first().innerText()
      await dialog.getByRole('button', { name: 'Copy link' }).click()
      await dialog.getByRole('button', { name: 'Copied' }).waitFor()
      assert.deepEqual(await clipboard(), [url])
    })

    await step('Anthropic: the paste-code fallback opens an input', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
      await dialog.getByText('Signing in on another device? Paste the code instead').click()
      await dialog.locator('input').first().waitFor()
      await dialog.getByRole('button', { name: 'Continue' }).waitFor()
      await app.screenshot('oauth-02-anthropic-paste-code')
    })

    await step('Anthropic: closing the dialog cancels the flow cleanly', async () => {
      await page.keyboard.press('Escape')
      await page
        .getByRole('dialog', { name: 'Sign in to Anthropic' })
        .waitFor({ state: 'detached' })
      await waitUntil(async () => !(await portIsOpen(callbackPort)), {
        label: 'the callback server to close'
      })
      const auth = await readTempAuth(agentDir)
      assert.ok(!auth?.anthropic, 'nothing stored for anthropic')
      assert.equal(await page.getByText('Sign-in failed').count(), 0)
      await providerRow(page, 'anthropic').getByRole('button', { name: 'Sign in' }).waitFor()
    })

    await step('Anthropic copy-code login: the sign-in URL', async () => {
      const openedBefore = (await network.opened()).length
      await providerRow(page, 'anthropic').getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
      await dialog.getByRole('button', { name: 'Copy code login (headless)' }).click()
      await dialog.getByText('copy the code Anthropic shows and paste it here').waitFor()
      const url = await dialog.locator('code').first().innerText()
      assert.ok(new URL(url).searchParams.get('redirect_uri').startsWith('https://'))
      assert.equal((await network.opened()).length, openedBefore + 1)
      await app.screenshot('oauth-02b-anthropic-copy-code')
    })

    // auth-7: in the copy-code (headless) flow, pasting the code is the required next step, so
    // the field is shown inline (only the browser flow folds it as a fallback).
    await soft.step(
      'Anthropic copy-code login: the paste field is shown, not folded away',
      async () => {
        const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
        await dialog
          .getByText('Paste the code Anthropic shows after you sign in:')
          .waitFor({ timeout: 3_000 })
      }
    )

    await step('Anthropic copy-code login: closing cancels; nothing stored', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in to Anthropic' })
      await dialog.getByRole('button', { name: 'Close' }).click()
      await dialog.waitFor({ state: 'detached' })
      assert.ok(!(await readTempAuth(agentDir))?.anthropic)
    })

    // auth-3: the engine asks "GitHub Enterprise URL/domain (blank for github.com)"; Continue
    // stays enabled while the field is blank.
    await soft.step('GitHub Copilot: the enterprise-domain prompt accepts blank', async () => {
      await providerRow(page, 'github-copilot').getByRole('button', { name: 'Sign in' }).click()
      const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot' })
      await dialog.getByText('GitHub Enterprise URL/domain (blank for github.com)').waitFor()
      await app.screenshot('oauth-03-copilot-domain')
      const continueButton = dialog.getByRole('button', { name: 'Continue' })
      assert.equal(await continueButton.isDisabled(), false, 'Continue enabled with a blank field')
    })

    await step('GitHub Copilot: device code, verification page and copy', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot' })
      // A blank domain is github.com.
      await dialog.getByRole('button', { name: 'Continue' }).click()
      await dialog.getByText(DEVICE.user_code, { exact: true }).waitFor()
      await dialog.getByText('github.com/login/device', { exact: true }).waitFor()
      await dialog.getByText('Expires in 15 minutes').waitFor()
      assert.ok(
        (await network.fetched()).some((url) =>
          url.startsWith('https://github.com/login/device/code')
        ),
        'device code requested from the (stubbed) GitHub endpoint'
      )
      await dialog.getByRole('button', { name: 'Copy code' }).click()
      assert.equal((await clipboard()).at(-1), DEVICE.user_code)
      await dialog.getByRole('button', { name: 'Open page' }).click()
      await waitUntil(async () => (await network.opened()).includes(DEVICE.verification_uri), {
        label: 'Open page → openExternal(verification_uri)'
      })
      await app.screenshot('oauth-04-copilot-device-code')
    })

    // auth-8: while the engine polls for the device approval, the dialog says "Starting…"
    // (the fallback for "no progress notice yet"); it now says it waits for the approval.
    await soft.step('GitHub Copilot: no "Starting…" once the code is shown', async () => {
      const dialog = page.getByRole('dialog', { name: 'Sign in to GitHub Copilot' })
      await dialog.getByText('Waiting for you to approve in the browser').waitFor()
      assert.equal(await dialog.getByText('Starting…').count(), 0)
    })

    await step('GitHub Copilot: closing the dialog cancels; nothing stored', async () => {
      await page.keyboard.press('Escape')
      await page
        .getByRole('dialog', { name: 'Sign in to GitHub Copilot' })
        .waitFor({ state: 'detached' })
      await page.waitForTimeout(500)
      const auth = await readTempAuth(agentDir)
      assert.ok(!auth?.['github-copilot'], 'nothing stored for github-copilot')
      assert.equal(await page.getByText('Sign-in failed').count(), 0)
    })

    soft.finish()
  },
  { launch: LAUNCH }
)
