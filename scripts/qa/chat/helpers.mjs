// Local helpers for the chat QA suites (candidates for scripts/qa/lib once the harness adopts them).
import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { reportShotsDir } from '../lib/app.mjs'
import { inspectRequest } from '../lib/fake-llm.mjs'

/** Screenshots for the QA report (see reportShotsDir). */
export const SHOTS_DIR = reportShotsDir('chat')

/** pi-ai DEFAULT_THINKING_BUDGETS (api/simple-options.js); xhigh/max clamp to high. */
export const THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }

/** Footer picker labels (composer/thinking-pill.tsx THINKING_LABELS). */
export const THINKING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Poll `predicate` (sync or async) until truthy; returns its value. */
export async function until(
  predicate,
  { timeoutMs = 15_000, intervalMs = 50, label = 'condition' } = {}
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
 * Steps that record a failure and let the suite go on (runSuite stops at the first throw). Use it for
 * `// BUG` steps so one confirmed bug does not hide the coverage after it; call `assertAll()` last.
 */
export function softSteps(step, app) {
  const failed = []
  return {
    async check(label, action) {
      try {
        return await step(label, action)
      } catch (error) {
        failed.push(`${label}: ${error.message.split('\n')[0]}`)
        console.error(`    \u2717 ${label}: ${error.message.split('\n')[0]}`)
        await app.page.keyboard.press('Escape').catch(() => undefined)
        return undefined
      }
    },
    assertAll() {
      if (failed.length) {
        throw new Error(`${failed.length} step(s) failed:\n  ${failed.join('\n  ')}`)
      }
    }
  }
}

export const composer = (app) => app.page.getByRole('textbox', { name: 'Message' })

/** Type into the real composer without sending. */
export async function typeDraft(app, text) {
  const box = composer(app)
  await box.fill(text)
  return box
}

/** Escape out of the command palette (nested pages go back to the root first). */
export async function closePalette(app) {
  const palette = app.page.getByRole('dialog', { name: 'Command palette' })
  for (let i = 0; i < 4 && (await palette.count()) > 0; i++) {
    await app.page.keyboard.press('Escape')
    await sleep(150)
  }
  assert.equal(await palette.count(), 0, 'palette closed')
}

/** Type a composer command that does not start a run (slash command) and press Enter. */
export async function submitCommand(app, text) {
  const box = composer(app)
  await box.fill(text)
  await box.press('Enter')
  await sleep(250)
}

/** Choose a level in the footer thinking picker (the real dropdown). */
export async function pickThinkingLevel(app, level) {
  await app.page.getByRole('button', { name: /^Thinking level:/ }).click()
  await app.page
    .getByRole('menuitemradio', { name: new RegExp(`^${THINKING_LABELS[level]}`) })
    .click()
  await until(async () => (await app.agentState())?.thinkingLevel === level, {
    label: `thinking level ${level}`
  })
}

/** Choose a model in the footer model picker (the real popover), by `provider/id`. */
export async function pickModelInFooter(app, provider, id) {
  await app.page.getByRole('button', { name: /^Model:/ }).click()
  const dialogInput = app.page.getByPlaceholder('Search models…')
  await dialogInput.waitFor()
  await dialogInput.fill(id)
  await app.page.locator(`[cmdk-item][data-value="${provider}/${id}"]`).click()
  await until(async () => (await app.agentState())?.model?.id === id, { label: `model ${id}` })
}

/**
 * Send through the composer and return the first model request it caused (after `from`).
 * Waits for the run to settle unless `settle: false`.
 */
export async function sendAndCapture(app, server, text, { settle = true, predicate } = {}) {
  const from = server.requests.length
  await app.send(text)
  const request = await server.waitForRequest(predicate, { from })
  if (settle) await app.waitForSettle()
  return { request, sent: inspectRequest(request), from }
}

/** Visible text of the whole window. */
export const bodyText = (app) => app.page.evaluate(() => document.body.innerText)

/** Text of the transcript scroller only. */
export const transcriptText = (app) =>
  app.page.evaluate(() => document.querySelector('[data-transcript-scroll]')?.innerText ?? '')

/**
 * Engine branding / raw protocol leaks in UI copy. `allow` strips known-good occurrences
 * (e.g. text the test itself put into the conversation) before checking.
 */
export function assertCleanUiText(text, { allow = [] } = {}) {
  let checked = text
  for (const pattern of allow) checked = checked.replace(pattern, '')
  assert.doesNotMatch(checked, /\bpi\b/i, 'UI copy says "pi"')
  assert.doesNotMatch(
    checked,
    /\{"type":|"error":\s*\{|request_id|"message":\s*"/,
    'raw JSON in the UI'
  )
}

/** Wait for the active agent's last assistant entry and return the message. */
export async function lastAssistant(app) {
  const state = await app.agentState()
  return [...state.entries].reverse().find((entry) => entry.message.role === 'assistant')?.message
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A valid solid-colour RGB PNG (for image attach / read-image tests). */
export function makePng(width, height, [r, g, b] = [220, 40, 40]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill([r, g, b]).flat())])
  const pixels = deflateSync(Buffer.concat(Array(height).fill(row)))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
