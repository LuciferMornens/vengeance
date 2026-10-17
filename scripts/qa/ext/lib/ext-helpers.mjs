// Helpers for the ext QA suites (extensions, packages, resources, MCP). Local to this domain; the
// harness can adopt them later.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportShotsDir } from '../../lib/app.mjs'

export const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURES_DIR = join(EXT_DIR, 'fixtures')
/** Report screenshots (see reportShotsDir). */
export const SHOTS_DIR = reportShotsDir('ext')

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Text of a fixture file (relative to scripts/qa/ext/fixtures). */
export function fixture(relativePath) {
  return readFileSync(join(FIXTURES_DIR, relativePath), 'utf8')
}

/** `files` entry for createAgentDir that installs the QA fixture extension. */
export function fixtureExtensionFiles() {
  return { 'extensions/qa-fixture.ts': fixture('qa-fixture.ts') }
}

/** Every JSON line the fixture extension logged so far (`<agentDir>/qa-ext-log.jsonl`). */
export function readExtLog(agentDir) {
  const file = join(agentDir.dir, 'qa-ext-log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Wait for a fixture log entry of `kind` (after `from` entries) that matches `predicate`. */
export async function waitForExtLog(
  agentDir,
  kind,
  { from = 0, predicate = () => true, timeoutMs = 15_000 } = {}
) {
  const started = Date.now()
  for (;;) {
    const hit = readExtLog(agentDir)
      .slice(from)
      .find((entry) => entry.kind === kind && predicate(entry))
    if (hit) return hit
    if (Date.now() - started > timeoutMs) {
      const kinds = readExtLog(agentDir)
        .slice(from)
        .map((entry) => entry.kind)
      throw new Error(`Timed out waiting for fixture log "${kind}" (saw: ${kinds.join(', ')})`)
    }
    await sleep(100)
  }
}

/** Number of fixture log lines so far (use as `from` for the next waitForExtLog). */
export function extLogLength(agentDir) {
  return readExtLog(agentDir).length
}

/**
 * Type into the real composer and press Enter without waiting for a model turn (extension commands
 * that open a dialog never start one).
 */
export async function submitComposer(app, text) {
  const composer = app.page.getByRole('textbox', { name: 'Message' })
  await composer.fill(text)
  await composer.press('Enter')
}

/** Screenshot into the report folder. */
export async function reportShot(app, name, options) {
  await mkdir(SHOTS_DIR, { recursive: true })
  await app.page.evaluate(() => document.fonts.ready)
  await app.page.waitForTimeout(options?.settleMs ?? 400)
  const path = join(SHOTS_DIR, `${name}.png`)
  await app.page.screenshot({ path })
  return path
}

/** Poll until `predicate()` returns a truthy value. */
export async function until(
  predicate,
  { timeoutMs = 15_000, label = 'condition', intervalMs = 100 } = {}
) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(intervalMs)
  }
}

/**
 * Steps that check a known bug (`// BUG ext-<n>`) without stopping the suite: a failure is printed
 * and collected, and `finish()` throws them all at the end so the suite still fails.
 */
export function bugSteps(step) {
  const failures = []
  return {
    async bugStep(label, action) {
      try {
        await step(label, action)
      } catch (error) {
        console.log(`    ✗ ${label}: ${error.message.split('\n')[0]}`)
        failures.push(`${label}: ${error.message.split('\n')[0]}`)
      }
    },
    finish() {
      if (failures.length) throw new Error(`Known-bug steps failed:\n  ${failures.join('\n  ')}`)
    }
  }
}

/** Open the command palette (Ctrl+K), type `title` and run the first match with Enter. */
export async function runPaletteAction(app, title) {
  await app.page.keyboard.press('ControlOrMeta+k')
  const input = app.page.getByRole('combobox').first()
  await input.waitFor()
  await input.fill(title)
  await app.page
    .getByRole('option', { name: new RegExp(`^${escapeRegExp(title)}`) })
    .first()
    .waitFor()
  await app.page.keyboard.press('Enter')
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * app.waitForSettle() for apps with several open sessions (every session keeps a composer mounted,
 * so the harness' single-composer locator is ambiguous): the active agent idles and its events stop.
 */
export async function settleActive(app, { timeoutMs = 60_000, quietMs = 400 } = {}) {
  await app.test('waitForIdle', timeoutMs)
  let marker = -1
  let since = Date.now()
  await until(
    async () => {
      const lastEventAt = (await app.agentState())?.lastEventAt ?? 0
      if (lastEventAt !== marker) {
        marker = lastEventAt
        since = Date.now()
      }
      return Date.now() - since >= quietMs
    },
    { timeoutMs, label: 'a quiet engine', intervalMs: 50 }
  )
}
