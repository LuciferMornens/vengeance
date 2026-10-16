// Local helpers for the auth QA suites (providers, accounts and models). Candidates for lib/ later:
//   - softSteps(): run the rest of a suite after a failed step, fail the suite at the end;
//   - stubMainNetwork(): replace shell.openExternal and fetch in the MAIN process, so login flows
//     never open the user's browser and never reach a real OAuth server.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REAL_AGENT_DIR } from '../lib/agent-dir.mjs'
import { reportShotsDir } from '../lib/app.mjs'

/** Screenshots land next to the report. */
export const SHOTS_DIR = reportShotsDir('auth')

/** Launch options every auth suite uses: screenshots into the report folder. */
export const LAUNCH = { outDir: SHOTS_DIR }

/**
 * Steps that do not stop the suite: a failing step is logged and remembered, later steps still
 * run, and `finish()` throws one error listing every failure (so the suite still fails).
 */
export function softSteps(step) {
  const failures = []
  return {
    async step(label, action) {
      try {
        return await step(label, action)
      } catch (error) {
        console.error(
          `    ✗ ${label}\n      ${String(error?.message ?? error)
            .split('\n')
            .join('\n      ')}`
        )
        failures.push(`${label}: ${error?.message ?? error}`)
        return undefined
      }
    },
    failures,
    finish() {
      if (failures.length) {
        throw new Error(`${failures.length} step(s) failed:\n  - ${failures.join('\n  - ')}`)
      }
    }
  }
}

/** size + mtime of the user's real auth.json (never read: rule 2 of the brief). */
export async function realAuthStat() {
  try {
    const info = await stat(join(REAL_AGENT_DIR, 'auth.json'))
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** auth.json of the TEMP agent dir (fake mode only), or null when it does not exist. */
export async function readTempAuth(agentDir) {
  try {
    return await agentDir.readJson('auth.json')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Main process: record shell.openExternal calls instead of opening the browser, and answer
 * `fetch` for the given URL prefixes from canned JSON (everything else goes to the real fetch,
 * which in fake mode only ever reaches 127.0.0.1). Returns readers for the recorded calls.
 *
 * @param {import('../lib/app.mjs').QaApp} app
 * @param {Array<{ prefix: string, json: unknown, status?: number }>} [routes]
 */
export async function stubMainNetwork(app, routes = []) {
  await app.app.evaluate(({ shell }, cannedRoutes) => {
    const state = (globalThis.__qaAuthStub = { opened: [], fetched: [] })
    shell.openExternal = async (url) => {
      state.opened.push(String(url))
    }
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input))
      const route = cannedRoutes.find((candidate) => url.startsWith(candidate.prefix))
      if (!route) return realFetch(input, init)
      state.fetched.push(url)
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  }, routes)
  return {
    opened: () => app.app.evaluate(() => [...globalThis.__qaAuthStub.opened]),
    fetched: () => app.app.evaluate(() => [...globalThis.__qaAuthStub.fetched])
  }
}

/**
 * models.json: keep the fake `qa` provider and point a BUILT-IN provider (e.g. openrouter) at the
 * fake LLM's OpenAI route with a provider-level baseUrl override (models.md). Its catalog models and
 * auth methods stay the engine's own; only requests go to 127.0.0.1.
 */
export async function routeProviderToFake(agentDir, server, providerId) {
  const models = await agentDir.readJson('models.json')
  models.providers[providerId] = { baseUrl: server.openaiBaseUrl }
  await agentDir.writeText('models.json', models)
}

/** The composer of the visible session (lib send()/openWorkspace() assume a single session). */
export function visibleComposer(page) {
  return page.getByRole('textbox', { name: 'Message' }).filter({ visible: true })
}

/** Open one more workspace next to the current one; resolves with its agent id once ready. */
export async function openAnotherWorkspace(app, args = {}) {
  const cwd = await app.createWorkspace()
  const agentId = await app.test('openWorkspace', cwd, args)
  // The previous session pane fades out (AnimatePresence exit) before it unmounts.
  await waitUntil(async () => (await visibleComposer(app.page).count()) === 1, {
    label: 'one session pane'
  })
  return agentId
}

/** lib send() for several open sessions: type into the visible composer, wait for the engine. */
export async function sendVisible(app, text) {
  const before = (await app.agentState())?.entries.length ?? 0
  const composer = visibleComposer(app.page)
  await composer.fill(text)
  await composer.press('Enter')
  await waitUntil(
    async () => {
      const state = await app.agentState()
      return state && (state.phase === 'running' || state.entries.length > before)
    },
    { timeoutMs: 30_000, label: 'the engine to accept the prompt' }
  )
}

/** lib waitForSettle() for several open sessions: the active agent idles and goes quiet. */
export async function settleVisible(app) {
  await app.test('waitForIdle', 60_000)
  let marker = -1
  let since = Date.now()
  await waitUntil(
    async () => {
      const lastEventAt = (await app.agentState())?.lastEventAt ?? 0
      if (lastEventAt !== marker) {
        marker = lastEventAt
        since = Date.now()
      }
      return Date.now() - since >= 300
    },
    { timeoutMs: 60_000, label: 'a quiet engine' }
  )
}

/** The Settings row of a provider (`Row settingKey="provider.<id>"`). */
export function providerRow(page, providerId) {
  return page.locator(`[id="setting-provider.${providerId}"]`)
}

/** Open Settings on a section and wait for its header. */
export async function openSettings(app, section, heading) {
  await app.test('openSettings', section)
  await app.page.getByRole('heading', { name: heading, exact: true }).waitFor()
}

/** Open the composer footer model picker and return its `provider/id` values (in order). */
export async function openComposerPicker(app) {
  const page = app.page
  await page
    .getByRole('button', { name: /^Model: / })
    .filter({ visible: true })
    .click()
  const list = page.locator('[cmdk-list]').last()
  await list.locator('[cmdk-item]').first().waitFor()
  return list.locator('[cmdk-item]').evaluateAll((items) => items.map((item) => item.dataset.value))
}

/** The engine's own list (RPC get_available_models) as `provider/id` keys. */
export async function engineModelKeys(app, agentId) {
  const { models } = await app.rpc({ type: 'get_available_models' }, agentId)
  return models.map((model) => `${model.provider}/${model.id}`)
}

/** Sorted copy (set comparisons with readable diffs). */
export function sorted(values) {
  return [...values].sort()
}

/** Elements in `a` missing from `b`. */
export function missing(a, b) {
  const other = new Set(b)
  return a.filter((value) => !other.has(value))
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Poll `predicate` until it returns a truthy value. */
export async function waitUntil(predicate, { timeoutMs = 15_000, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(100)
  }
}
