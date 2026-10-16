// Soft steps for the sessions suites: a failing check (a confirmed bug) is recorded and the suite keeps going,
// so one run reports every finding; `finish()` then fails the suite with all of them.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { reportShotsDir } from '../../lib/app.mjs'

/** Screenshots referenced by the report: D:/coding/vengeance-lanes/reports/qa/sessions-shots/. */
export const SHOTS_DIR = reportShotsDir('sessions')

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Poll `predicate` (sync or async) until truthy; returns its value or throws `label` on timeout. */
export async function waitUntil(
  predicate,
  { timeoutMs = 10_000, intervalMs = 100, label = 'condition' } = {}
) {
  const started = Date.now()
  let last
  for (;;) {
    try {
      last = await predicate()
      if (last) return last
    } catch (error) {
      last = error
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for ${label}${last instanceof Error ? ` (${last.message})` : ''}`
      )
    }
    await sleep(intervalMs)
  }
}

/**
 * `check(label, action)` runs a step through the suite's `step` but records a failure instead of throwing;
 * `finish()` throws once with every failed check. Use `step` directly for setup that later checks need.
 */
export function createChecks(step, app, suite) {
  const failures = []
  async function check(label, action) {
    try {
      return await step(label, action)
    } catch (error) {
      failures.push({ label, error })
      console.log(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
      const name = `${suite}-FAIL-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`
      await app()
        ?.screenshot(name, { settleMs: 0 })
        .catch(() => undefined)
      // Leave no dialog or menu open for the next check.
      await app()
        ?.page.keyboard.press('Escape')
        .catch(() => undefined)
      return undefined
    }
  }
  function finish() {
    if (!failures.length) return
    throw new Error(
      `${failures.length} check(s) failed:\n  ${failures.map((f) => `${f.label}: ${f.error.message.split('\n')[0]}`).join('\n  ')}`
    )
  }
  return { check, finish, failures }
}

/**
 * Send through the real composer once the pane switch animation has ended: while an old session pane fades
 * out, two composers exist and the harness `send()` locator is ambiguous.
 */
export async function sendWhenSettled(app, text) {
  await waitUntil(
    async () => (await app.page.locator('textarea[aria-label="Message"]').count()) === 1,
    {
      label: 'a single composer',
      timeoutMs: 5000
    }
  )
  await app.send(text)
}

/**
 * Type an app command (`/export x.jsonl`, `/share`) into the real composer and press Enter. Unlike the harness
 * `send()` it does not wait for the engine: built-in commands never reach it. Resolves once the composer
 * emptied (the command ran).
 */
export async function runComposerCommand(app, text) {
  await waitUntil(
    async () => (await app.page.locator('textarea[aria-label="Message"]').count()) === 1,
    {
      label: 'a single composer',
      timeoutMs: 5000
    }
  )
  const composer = app.page.locator('textarea[aria-label="Message"]')
  await composer.fill(text)
  await composer.press('Enter')
  await waitUntil(async () => (await composer.inputValue()) === '', {
    label: `${text} to run`,
    timeoutMs: 5000
  })
}

export async function ensureShotsDir() {
  await mkdir(SHOTS_DIR, { recursive: true })
  return SHOTS_DIR
}

export function shotPath(name) {
  return join(SHOTS_DIR, `${name}.png`)
}

/** Open the inspector (if closed) on its Branches tab. */
export async function openBranchesTab(app) {
  const page = app.page
  await waitUntil(
    async () => (await page.getByRole('button', { name: /^(Show|Hide) inspector$/ }).count()) === 1,
    {
      label: 'one inspector toggle'
    }
  )
  if (await page.getByRole('button', { name: 'Show inspector' }).count()) {
    await page.getByRole('button', { name: 'Show inspector' }).click()
  }
  await page.getByRole('tab', { name: 'Branches' }).click()
}
