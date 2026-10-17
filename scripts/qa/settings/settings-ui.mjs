// Settings-domain helpers: drive the real Settings sheet (rows are `#setting-<dotted key>`), read what
// landed on disk and wait for engines to restart. Local to scripts/qa/settings until the harness adopts
// them (see reports/qa/settings.md, "Harness notes").
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reportShotsDir } from '../lib/app.mjs'

/** Screenshots of this domain land next to the QA report (`reports/qa/settings-shots`). */
export const SHOTS_DIR = process.env.QA_SETTINGS_SHOTS ?? reportShotsDir('settings')

/** runSuite() launch options shared by every settings suite. */
export const LAUNCH = { outDir: SHOTS_DIR }

const POLL_MS = 50
const DEFAULT_WAIT_MS = 10_000
const ENGINE_RESTART_MS = 60_000

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Poll `probe` until it returns a truthy value; throws with `label` and the last value on timeout. */
export async function waitFor(probe, label, timeoutMs = DEFAULT_WAIT_MS) {
  const started = Date.now()
  let last
  for (;;) {
    try {
      last = await probe()
      if (last) return last
    } catch (error) {
      last = error
    }
    if (Date.now() - started > timeoutMs) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last)
      throw new Error(`Timed out waiting for ${label} (last: ${detail})`)
    }
    await sleep(POLL_MS)
  }
}

/** Parsed JSON file, or `null` when it does not exist (throws on invalid JSON). */
export async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Value at a dotted path (`retry.provider.maxRetries`). */
export function at(object, dotted) {
  return dotted
    .split('.')
    .reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object)
}

/** Wait until `<file>` holds `expected` at `key` (deep-equal through JSON), return the whole file. */
export async function waitForJsonValue(path, key, expected, timeoutMs = DEFAULT_WAIT_MS) {
  const want = JSON.stringify(expected)
  return waitFor(
    async () => {
      const data = await readJsonOrNull(path)
      return data && JSON.stringify(at(data, key)) === want ? data : null
    },
    `${path} ${key} = ${want}`,
    timeoutMs
  )
}

export function projectSettingsPath(cwd) {
  return join(cwd, '.pi', 'settings.json')
}

/** The Settings sheet is open (its search box is mounted). */
export async function settingsOpen(app) {
  return app.page
    .locator('input[aria-label="Search settings"]')
    .isVisible()
    .catch(() => false)
}

/** Open Settings through the sidebar gear (or Ctrl+, when no sidebar), then go to the nav section. */
export async function openSettings(app, section) {
  if (!(await settingsOpen(app))) {
    const gear = app.page.getByRole('button', { name: 'Settings', exact: true })
    if (await gear.isVisible().catch(() => false)) await gear.click()
    else await app.page.keyboard.press('ControlOrMeta+Comma')
    await app.page.locator('input[aria-label="Search settings"]').waitFor()
  }
  if (section) {
    await app.page
      .getByRole('navigation')
      .getByRole('button', { name: section, exact: true })
      .click()
    await app.page.getByRole('heading', { name: section, exact: true }).waitFor()
    // The section fades in (AnimatePresence); wait for the motion to finish before clicking rows.
    await app.page.waitForTimeout(250)
  }
}

export async function closeSettings(app) {
  if (await settingsOpen(app)) {
    await app.page.locator('button[aria-label="Close settings"]').click()
    await app.page.locator('input[aria-label="Search settings"]').waitFor({ state: 'detached' })
  }
}

/** The row of one schema setting. */
export function settingRow(app, key) {
  return app.page.locator(`[id="setting-${key}"]`)
}

/** Global / Project scope switch in the sheet header (next to the close button). */
export function scopeSwitch(app) {
  return app.page.locator('div:has(> button[aria-label="Close settings"])').getByRole('radio')
}

export async function setScope(app, scope) {
  const target = scopeSwitch(app).nth(scope === 'global' ? 0 : 1)
  await target.click()
  await waitFor(
    async () => (await target.getAttribute('aria-checked')) === 'true',
    `scope ${scope}`
  )
  await app.page.waitForTimeout(300)
}

export async function setSwitch(app, key, on) {
  const control = settingRow(app, key).getByRole('switch')
  if ((await control.getAttribute('aria-checked')) !== String(on)) await control.click()
  await waitFor(
    async () => (await control.getAttribute('aria-checked')) === String(on),
    `${key} switch = ${on}`
  )
}

/** Pick an option of a choice row: a segmented radio, or a Radix select (combobox → option). */
export async function choose(app, key, label) {
  const row = settingRow(app, key)
  const radio = row.getByRole('radio', { name: label, exact: true })
  if ((await radio.count()) > 0) {
    await radio.first().click()
    return
  }
  await row.getByRole('combobox').first().click()
  await app.page.getByRole('option', { name: label, exact: true }).click()
  // An open Radix Select hides its siblings from the accessibility tree until it has closed.
  await app.page.locator('[role="listbox"]').waitFor({ state: 'detached' })
}

/** Type into a number or text field of a row and commit (Enter blurs and commits). '' clears it. */
export async function fill(app, key, value, { index = 0 } = {}) {
  const input = settingRow(app, key).locator('input').nth(index)
  await input.fill(String(value))
  await input.press('Enter')
}

/** Add entries to a list row (tag input). */
export async function addListItems(app, key, items) {
  const input = settingRow(app, key).locator('input').last()
  for (const item of items) {
    await input.fill(item)
    await input.press('Enter')
  }
}

/** Open a model picker (trigger inside a row), search and pick the model whose name is `modelName`. */
export async function pickModel(app, trigger, modelName) {
  await trigger.click()
  const search = app.page.getByPlaceholder('Search models…')
  await search.fill(modelName)
  await app.page
    .getByRole('option', { name: new RegExp(`^${modelName}\\b`) })
    .first()
    .click()
  await search.waitFor({ state: 'hidden' })
}

/** Visible toast (status/alert) containing `text`. */
export function toastWith(app, text) {
  return app.page.locator('[role=status],[role=alert]', { hasText: text }).first()
}

/** Dismiss every visible toast (so a later assertion sees only new ones). */
export async function dismissToasts(app) {
  await app.page.evaluate(() => {
    for (const toast of document.querySelectorAll('[role=status],[role=alert]')) {
      toast.querySelector('button[aria-label="Dismiss"]')?.click()
    }
  })
  await app.page.waitForTimeout(250)
}

/** Engine PID of an agent (from the main process list). */
export async function enginePid(app, agentId) {
  const engines = await app.invoke('engine:list')
  return engines.find((engine) => engine.agentId === agentId)?.pid
}

/** Wait until an agent runs on a new engine process (PID changed) and is ready again. */
export async function waitForRestart(app, agentId, previousPid) {
  await waitFor(
    async () => {
      const pid = await enginePid(app, agentId)
      const state = await app.agentState(agentId)
      return pid && pid !== previousPid && state?.status === 'ready' && state.session
    },
    `agent ${agentId} to restart on a new engine`,
    ENGINE_RESTART_MS
  )
}

/** Click "Restart engines" on the "Restart to apply" toast and wait for the agent's new engine. */
export async function restartFromToast(app, agentId) {
  const before = await enginePid(app, agentId)
  const toast = toastWith(app, 'Restart to apply')
  await toast.waitFor()
  await toast.getByRole('button', { name: 'Restart engines' }).click()
  await waitForRestart(app, agentId, before)
}

/** Settings → Engine → Maintenance → "Restart engines" row's Restart button, then wait for the new engine. */
export async function restartFromEngineSection(app, agentId) {
  const before = await enginePid(app, agentId)
  await dismissToasts(app)
  await openSettings(app, 'Engine')
  await app.page.getByRole('button', { name: 'Restart', exact: true }).click()
  await waitForRestart(app, agentId, before)
}

/** Send a prompt through the real composer, wait for the run and return the first model request. */
export async function sendAndCapture(app, server, text, ...turns) {
  const from = server.requests.length
  if (turns.length) server.queue(...turns)
  await app.send(text)
  await app.waitForSettle()
  return server.waitForRequest(undefined, { from })
}

/**
 * Open a new session (new engine) in `cwd` through the app's workspace flow and return its agent id.
 * Waits until the previous session's composer has faded out, so `app.send()` finds exactly one.
 */
export async function newSessionIn(app, cwd, args = {}) {
  const agentId = await app.test('openWorkspace', cwd, args)
  const composer = app.page.getByRole('textbox', { name: 'Message' })
  await waitFor(async () => (await composer.count()) === 1 && composer.isVisible(), 'one composer')
  return agentId
}

/**
 * Steps that keep going after a failed assertion, so one confirmed bug does not hide the rest of a
 * suite. `check(label, action)` runs a step and records its failure (with a `<suite>-<n>-FAILED.png`);
 * `finish()` throws once at the end when any step failed, which fails the suite.
 */
export function softSteps({ step, app }, suite) {
  const failures = []
  async function check(label, action) {
    try {
      return await step(label, action)
    } catch (error) {
      failures.push(`${label}: ${String(error.message).split('\n')[0]}`)
      const detail = String(error.message).split('\n').slice(0, 8).join('\n      ')
      console.error(`    ✗ ${label}\n      ${detail}`)
      await app
        .screenshot(`${suite}-${failures.length}-FAILED`, { settleMs: 0 })
        .catch(() => undefined)
      return undefined
    }
  }
  function finish() {
    if (failures.length) {
      throw new Error(`${failures.length} step(s) failed:\n    ${failures.join('\n    ')}`)
    }
  }
  return { check, finish }
}
