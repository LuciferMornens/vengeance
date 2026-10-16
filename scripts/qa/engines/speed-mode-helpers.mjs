// Shared steps of the response speed (Fast / Ultrafast) suites: the composer's speed pill and its
// menu (composer/speed-pill.tsx), model switches through the footer picker, turns whose answer
// echoes the provider's speed report, cost checks, and a toast recorder that counts every toast
// the renderer mounts (a notice must be toasted once).
import assert from 'node:assert/strict'
import { pickModelInFooter, submitCommand, until } from '../chat/helpers.mjs'
import { turn } from '../lib/fake-llm.mjs'

const SPEED_LABELS = { standard: 'Standard', fast: 'Fast', ultrafast: 'Ultrafast' }
export const FAST_BETA = 'fast-mode-2026-02-01'

/** Every turn answers with this usage, so a response's cost is exact: input + output at the model's rates. */
export const TURN_USAGE = { input: 1000, output: 100 }
/** Per-million prices of the fake OpenAI / Anthropic models; standard cost of a turn = 0.003. */
const MODEL_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 }
const STANDARD_TURN_COST =
  (TURN_USAGE.input * MODEL_COST.input + TURN_USAGE.output * MODEL_COST.output) / 1_000_000

export function responsesModel(server, id, name = id) {
  return {
    id,
    name,
    api: 'openai-responses',
    baseUrl: server.openaiBaseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 8_000,
    cost: MODEL_COST
  }
}

export function anthropicModel(server, id, name = id) {
  return {
    id,
    name,
    api: 'anthropic-messages',
    baseUrl: server.anthropicBaseUrl,
    reasoning: false,
    input: ['text'],
    contextWindow: 200_000,
    maxTokens: 8_000,
    cost: MODEL_COST
  }
}

export const speedPill = (app) => app.page.getByRole('button', { name: /^Speed: / })

/**
 * The pill's label (`Standard`, `Fast`, `Ultrafast`, `Unavailable`), or null while it is hidden. An
 * unavailable pill's label goes on with its reason (`Speed: Unavailable. <reason>`).
 */
export async function pillLabel(app) {
  const pill = speedPill(app)
  if ((await pill.count()) === 0) return null
  return /^Speed: ([^.]*)/.exec(await pill.first().getAttribute('aria-label'))?.[1] ?? null
}

export async function waitForPill(app, label) {
  await until(async () => (await pillLabel(app)) === label, {
    label: `speed pill ${label ?? 'hidden'}`
  })
}

export async function speedState(app) {
  return (await app.agentState())?.speed ?? null
}

export async function waitForSpeed(app, predicate, label) {
  return until(
    async () => {
      const speed = await speedState(app)
      return speed && predicate(speed) ? speed : null
    },
    { label }
  )
}

/** Open the pill's menu; returns the radio items' accessible names, in order. */
export async function openSpeedMenu(app) {
  await speedPill(app).click()
  const items = app.page.getByRole('menuitemradio')
  await items.first().waitFor()
  return items.allInnerTexts()
}

export async function closeMenu(app) {
  await app.page.keyboard.press('Escape')
  await app.page.getByRole('menu').waitFor({ state: 'detached' })
}

/** Choose `mode` in the pill's menu and wait until the session requests it. */
export async function chooseSpeed(app, mode) {
  await openSpeedMenu(app)
  await app.page.getByRole('menuitemradio', { name: new RegExp(`^${SPEED_LABELS[mode]}`) }).click()
  await waitForSpeed(app, (speed) => speed.requested === mode, `requested ${mode}`)
}

export async function pickModel(app, provider, id) {
  await pickModelInFooter(app, provider, id)
  // The bridge publishes the new model's speed offer on `model_select`; the store follows it.
  await until(async () => (await app.agentState())?.status === 'ready', { label: 'ready' })
}

/** Turn options that echo the provider's speed report like the real APIs with an API key. */
export const ECHO = { serviceTier: true, speed: true, usage: TURN_USAGE }

/**
 * Send `prompt` through the composer with `answer` queued (default: an echoing text turn); wait for
 * the run to settle. Returns the first model request and the run's last assistant message.
 */
export async function sendTurn(app, server, prompt, answer = turn.text('ok', ECHO)) {
  const from = server.requests.length
  server.queue(answer)
  await app.send(prompt)
  const request = await server.waitForRequest(undefined, { from })
  await app.waitForSettle()
  return { request, requests: server.requests.slice(from).filter((r) => r.api), from }
}

export async function lastAssistantMessage(app) {
  const state = await app.agentState()
  return state.entries.map((entry) => entry.message).findLast((m) => m.role === 'assistant')
}

const near = (value, expected) => Math.abs(value - expected) < 1e-9

export async function sessionCost(app) {
  return (await app.rpc({ type: 'get_session_stats' })).cost ?? 0
}

/** The last answer cost `multiplier` × standard, and the session cost grew by the same amount. */
export async function assertTurnCost(app, multiplier, costBefore) {
  const message = await lastAssistantMessage(app)
  const total = message?.usage?.cost?.total
  const expected = STANDARD_TURN_COST * multiplier
  assert.ok(near(total ?? NaN, expected), `message cost ${total}, expected ${expected}`)
  if (costBefore === undefined) return
  let grown
  await until(
    async () => {
      grown = (await sessionCost(app)) - costBefore
      return near(grown, expected)
    },
    { label: 'session cost', timeoutMs: 5000 }
  ).catch(() => assert.fail(`session cost grew by ${grown}, expected ${expected}`))
}

export const hasServiceTier = (request) => 'service_tier' in (request.body ?? {})

export function anthropicBetas(request) {
  return String(request.headers['anthropic-beta'] ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean)
}

/** Records every toast the renderer mounts (title + description), for "toasted once" checks. */
export async function recordToasts(app) {
  await app.page.evaluate(() => {
    if (window.__qaToasts) return
    const seen = []
    window.__qaToasts = seen
    const visit = (node) => {
      if (!(node instanceof HTMLElement)) return
      const toasts = node.matches('[role=status],[role=alert]')
        ? [node]
        : [...node.querySelectorAll('[role=status],[role=alert]')]
      for (const toast of toasts) {
        if (toast.closest('[data-toaster]')) seen.push(toast.innerText)
      }
    }
    new MutationObserver((mutations) => {
      for (const mutation of mutations) for (const node of mutation.addedNodes) visit(node)
    }).observe(document.body, { childList: true, subtree: true })
  })
}

export async function toastsSince(app, from, pattern) {
  const all = await app.page.evaluate(() => window.__qaToasts ?? [])
  return all.slice(from).filter((text) => pattern.test(text))
}

export const toastCount = (app) => app.page.evaluate(() => (window.__qaToasts ?? []).length)

/** A slash command through the real composer (built-in commands run in the renderer). */
export async function slash(app, text) {
  await submitCommand(app, text)
}

/** Palette → the Fast mode entry (`Turn on Fast mode` / `Turn off Fast mode`). */
export async function paletteFastToggle(app, title) {
  await app.test('setPalette', true)
  const palette = app.page.getByRole('dialog', { name: 'Command palette' })
  await palette.waitFor()
  await palette.getByRole('combobox').fill('Fast mode')
  await palette.getByRole('option', { name: new RegExp(`^${title}`) }).click()
  await palette.waitFor({ state: 'detached' })
}
