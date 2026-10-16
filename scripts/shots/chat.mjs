// Chat + tools scenarios: empty hero, thinking stream, live bash, retry countdown, mid-answer streaming,
// settled transcript (collapsed + expanded, several scroll positions), session header (rename, context
// breakdown), hidden thinking (Ctrl+T), light theme, a gallery session covering every remaining card/entry
// type, a parity session (PowerShell, tool_search, MCP, codemode nested calls, mermaid, Ctrl+O) and a
// 220-turn session (virtualized transcript, jump to latest, context over the limit), JSON result trees, the
// captioned lightbox, and the tool rows / subagent rows of the `toolbelt` script (with the §6.6 assertions).

// The scroll helpers set exact positions as the user: the transcript only stops following the bottom on user
// input, so each position change comes with a wheel tick (synthetic, it scrolls nothing itself).

async function scrollTranscript(page, fraction) {
  await page.evaluate((f) => {
    const el = document.querySelector('[data-transcript-scroll]')
    if (!el) return
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    el.scrollTop = (el.scrollHeight - el.clientHeight) * f
  }, fraction)
}

/** Distance (px) between the transcript's scroll position and its bottom. */
function distanceFromBottom(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-transcript-scroll]')
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : -1
  })
}

/** Expand every collapsed activity group and tool row in the transcript (Raw views stay closed). */
async function expandAll(page) {
  for (let pass = 0; pass < 3; pass++) {
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-transcript-scroll]')
      const buttons = [...(root?.querySelectorAll('button[aria-expanded="false"]') ?? [])]
      buttons.forEach((b) => b.click())
      return buttons.length
    })
    if (!clicked) break
    await page.waitForTimeout(500)
  }
}

/** Resume a paused mock run without waiting for it (mock:play resolves only when the run pauses again). */
function resumeRaw(page, args) {
  return page.evaluate((a) => {
    const id = window.__vengeanceTest.activeAgentId()
    void window.vengeance.invoke('mock:play', id, { resume: true, ...a })
  }, args)
}

/** Scroll the transcript so the first element whose text starts with `text` sits 120px below the header. */
async function scrollToText(page, text) {
  const found = await page.evaluate((t) => {
    const root = document.querySelector('[data-transcript-scroll]')
    const ownText = (n) => [...n.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim().startsWith(t))
    const el = [...(root?.querySelectorAll('span, div, button, pre') ?? [])].find(ownText)
    if (!root || !el) return false
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 120
    return true
  }, text)
  if (!found) throw new Error(`"${text}" is not in the transcript`)
  await page.waitForTimeout(200)
}

async function newSession(page, wait) {
  await page.click('button[aria-label="New session"]')
  await wait(1500)
}

/** Model-facing protocol text that must never reach the screen (spec §6.6). */
const RAW_PROTOCOL = /PI_SUBAGENT_|Detached\. Return control now|async-subagent-runs|Retention-managed|subagent\(\{|Inspect subagent updates above/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/

/** Throw when protocol text is on screen, or (collapsed transcripts) a run id is in the transcript. */
async function assertNoRawProtocol(page, where, { uuids = true } = {}) {
  const { body, transcript } = await page.evaluate(() => ({
    body: document.body.innerText,
    transcript: document.querySelector('[data-transcript-scroll]')?.innerText ?? ''
  }))
  const raw = RAW_PROTOCOL.exec(body)
  if (raw) throw new Error(`${where}: raw protocol text on screen: "${raw[0]}"`)
  const id = uuids && UUID.exec(transcript)
  if (id) throw new Error(`${where}: run id in the collapsed transcript: "${id[0]}"`)
}

/** innerText of the whole transcript, including settled turns that content-visibility skips off-screen. */
function transcriptText(page) {
  return page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = '[data-transcript-scroll] * { content-visibility: visible !important; }'
    document.head.append(style)
    const text = document.querySelector('[data-transcript-scroll]')?.innerText ?? ''
    style.remove()
    return text
  })
}

/** Run folders, the user profile path, run ids and the engine's own name: never in a settled transcript. */
const TRANSCRIPT_LEAKS = [/async-subagent-runs/, /AppData/, /\bPi\b/, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i]
/** Rows whose errors are answers, not failures: a `grep -c` with no match, a check on a child with no command. */
const BENIGN_ROW = /grep -c error|\u2019s command/

/**
 * Throw when a settled delegation transcript leaks paths, ids or the engine's name, still says "needs attention"
 * after every run ended, or shows a benign error as a failure (pinned when folded, danger-toned when open).
 */
async function assertCalmDelegation(page, where, { opened }) {
  const text = await transcriptText(page)
  for (const pattern of TRANSCRIPT_LEAKS) {
    const leak = pattern.exec(text)
    if (leak) throw new Error(`${where}: "${leak[0]}" in the transcript`)
  }
  if (/needs? attention/i.test(text)) throw new Error(`${where}: "needs attention" after every run ended`)
  const rows = await page.evaluate((source) => {
    const benign = new RegExp(source)
    return [...document.querySelectorAll('[data-transcript-scroll] [data-tool-row]')]
      .filter((row) => benign.test(row.textContent ?? ''))
      .map((row) => ({
        text: row.textContent?.slice(0, 80),
        phase: row.getAttribute('data-tool-phase'),
        danger: row.querySelector('.text-danger') !== null,
        pinned: row.closest('[data-pinned-row]') !== null
      }))
  }, BENIGN_ROW.source)
  const red = rows.filter((row) => row.phase === 'error' || row.danger || row.pinned)
  if (red.length) throw new Error(`${where}: benign errors shown as failures: ${JSON.stringify(red)}`)
  if (opened && rows.length < 2) throw new Error(`${where}: expected the grep -c and command check rows, found ${rows.length}`)
}

/** Every settled activity group without a pinned row is one 28px line (≤ 32 with rounding). */
async function assertGroupsFolded(page, where) {
  const tall = await page.evaluate(() =>
    [...document.querySelectorAll('[data-transcript-scroll] [data-activity-group]:not([data-has-pinned])')]
      .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), text: el.textContent?.slice(0, 60) }))
      .filter((g) => g.h > 32)
  )
  if (tall.length) throw new Error(`${where}: settled groups taller than 32px: ${JSON.stringify(tall)}`)
}

/** Open the activity group whose header summary contains `text`. */
async function openGroup(page, text) {
  const header = page.locator('[data-transcript-scroll] button[data-group-header]', { hasText: text }).first()
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click()
  await page.waitForTimeout(450)
  return header
}

/** Click the tool row whose text contains `text` (expands its detail). */
async function openRow(page, text) {
  const row = page.locator('[data-transcript-scroll] [data-tool-row]', { hasText: text }).first()
  await row.locator('button[aria-expanded="false"]').first().click()
  await page.waitForTimeout(450)
  return row
}

/** Scroll so `locator`'s top sits 120px below the transcript's top. */
async function scrollToLocator(page, locator) {
  await locator.evaluate((el) => {
    const root = document.querySelector('[data-transcript-scroll]')
    if (!root) return
    root.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top - 120
  })
  await page.waitForTimeout(200)
}

/** Lane T tool rows on the `toolbelt` script: live tail, folded groups, pinned failure, stopped run, details, subagent rows. */
async function toolbeltScenarios(page, { shot, test, wait }) {
  await newSession(page, wait)
  await test('mockPlay', { script: 'toolbelt', prompt: 'The session tree jumps to the top on fork. Fix it and check everything.', pauseAt: 'bash-live' })
  // The pause detection can fire in a streaming gap; the run is parked once the shots command's tail shows.
  await page.locator('[data-transcript-scroll] [data-tool-row]', { hasText: 'npm run shots' }).locator('[data-live-tail]').waitFor({ timeout: 30_000 })
  await wait(400)
  const live = await page.evaluate(() => {
    const group = document.querySelector('[data-transcript-scroll] [data-tool-phase="running"]')?.closest('[data-activity-group]')
    return group ? { height: group.getBoundingClientRect().height, tail: group.querySelector('[data-live-tail]') !== null } : null
  })
  if (!live) throw new Error('bash-live: no live activity group')
  if (live.height > 200) throw new Error(`bash-live: live group is ${Math.round(live.height)}px (budget 200)`)
  if (!live.tail) throw new Error('bash-live: the running shell shows no live tail')
  await shot('chat-tools-live', { settleMs: 500 })

  await test('mockPlay', { resume: true, instant: true, pauseAt: 'delegation' })
  await wait(1200)
  await assertGroupsFolded(page, 'tools settled')
  await assertNoRawProtocol(page, 'tools settled')
  await scrollTranscript(page, 0)
  await shot('chat-tools-settled', { settleMs: 400 })
  const pinned = page.locator('[data-transcript-scroll] [data-pinned-row]', { hasText: 'npm test' })
  if ((await pinned.count()) !== 1) throw new Error('The failed npm test row is not pinned under its folded group')
  await scrollToLocator(page, pinned)
  await shot('chat-tools-error-pinned', { settleMs: 300 })
  const stopped = page.locator('[data-transcript-scroll] [data-tool-row][data-tool-phase="aborted"]', { hasText: 'npm run dev' })
  if ((await stopped.count()) !== 1) throw new Error('The aborted npm run dev row does not render as stopped')
  await scrollTranscript(page, 1)
  await shot('chat-tools-cancelled', { settleMs: 300 })

  await openGroup(page, 'ran 3 commands')
  const typecheck = await openRow(page, 'npm run typecheck')
  await scrollToLocator(page, typecheck)
  await shot('chat-tools-row-expanded', { settleMs: 400 })
  await openGroup(page, 'edited')
  const edit = await openRow(page, 'Edited')
  await scrollToLocator(page, edit)
  await shot('chat-tools-edit-lens', { settleMs: 600 })
  const lens = await openGroup(page, 'code checks')
  await scrollToLocator(page, lens)
  await shot('chat-tools-lens-rows', { settleMs: 400 })
  const web = await openGroup(page, 'web lookups')
  await scrollToLocator(page, web)
  await shot('chat-tools-web-rows', { settleMs: 400 })

  // Delegation: launches, steer/status/management, notices, the wake and reply prompts, resume, bg_wait.
  await newSession(page, wait)
  await test('mockPlay', { script: 'toolbelt', instant: true, prompt: 'The session tree jumps to the top on fork. Fix it and check everything.', pauseAt: 'delegation' })
  const usersBefore = await page.locator('[data-transcript-scroll] [data-segment="user"]').count()
  await test('mockPlay', { resume: true, instant: true, pauseAt: 'needs-decision' })
  const card = page.locator('[data-transcript-scroll] [data-supervisor-card]')
  await card.waitFor({ timeout: 30_000 })
  const cardHeight = await card.evaluate((el) => el.getBoundingClientRect().height)
  if (cardHeight > 180) throw new Error(`The supervisor card is ${Math.round(cardHeight)}px (budget 176)`)
  await assertNoRawProtocol(page, 'needs-decision', { uuids: false })
  await scrollTranscript(page, 1)
  await shot('chat-subagent-card', { settleMs: 500 })
  await test('setPrefs', { theme: 'light' })
  await shot('chat-subagent-card-light', { settleMs: 500 })
  await test('setPrefs', { theme: 'dark' })
  await test('mockPlay', { resume: true, instant: true })
  await test('waitForIdle')
  await wait(1200)
  const usersAfter = await page.locator('[data-transcript-scroll] [data-segment="user"]').count()
  // One real user message in the delegation runs; the two wakes and the reply prompt are not bubbles.
  if (usersAfter !== usersBefore + 1) throw new Error(`Wake / reply prompts rendered as user bubbles (${usersBefore} → ${usersAfter} user segments)`)
  if ((await page.locator('[data-transcript-scroll] [data-supervisor-card]').count()) !== 0) throw new Error('The answered supervisor request still shows its card')
  await assertGroupsFolded(page, 'delegation settled')
  await assertNoRawProtocol(page, 'delegation settled')
  await assertCalmDelegation(page, 'delegation settled', { opened: false })
  await scrollToLocator(page, page.locator('[data-transcript-scroll] [data-segment="user"]').last())
  await shot('chat-subagent-rows', { settleMs: 500 })
  await scrollTranscript(page, 1)
  await shot('chat-subagent-rows-bottom', { settleMs: 400 })
  await test('setPrefs', { theme: 'light' })
  await scrollToLocator(page, page.locator('[data-transcript-scroll] [data-segment="user"]').last())
  await shot('chat-subagent-rows-light', { settleMs: 600 })
  await scrollTranscript(page, 0)
  await shot('chat-tools-settled-light', { settleMs: 400 })
  await test('setPrefs', { theme: 'dark' })
  // Every group and updates row open: the rows behind the one-line summaries.
  await page.evaluate(() => {
    const root = document.querySelector('[data-transcript-scroll]')
    const headers = root?.querySelectorAll('button[data-group-header][aria-expanded="false"], [data-subagent-updates] > [data-tool-row] button[aria-expanded="false"]') ?? []
    for (const button of headers) button.click()
  })
  await wait(600)
  await assertCalmDelegation(page, 'delegation open', { opened: true })
  await scrollToLocator(page, page.locator('[data-transcript-scroll] [data-segment="user"]').last())
  await shot('chat-subagent-rows-open', { settleMs: 400 })
  await scrollToLocator(page, page.locator('[data-transcript-scroll] [data-tool-row]', { hasText: 'Peeked at' }).first())
  await shot('chat-subagent-peeks', { settleMs: 400 })
  await test('setPrefs', { theme: 'light' })
  await shot('chat-subagent-peeks-light', { settleMs: 600 })
  await test('setPrefs', { theme: 'dark' })
  await scrollTranscript(page, 1)
  await shot('chat-subagent-rows-open-bottom', { settleMs: 400 })
}

export async function scenarios(page, { shot, test, wait, MOCK_WORKSPACE }) {
  await test('openWorkspace', MOCK_WORKSPACE)
  await wait(600)
  await shot('chat-empty-state', { settleMs: 900 })

  await test('mockPlay', { script: 'showcase', pauseAt: 'thinking' })
  await shot('chat-thinking-streaming', { settleMs: 1200 })

  await test('mockPlay', { resume: true, pauseAt: 'bash-running' })
  await shot('chat-bash-running', { settleMs: 700 })

  await test('mockPlay', { resume: true, instant: true, pauseAt: 'select' })
  await test('mockPlay', { resume: true, instant: true })
  await test('mockPlay', { resume: true, pauseAt: 'retry' })
  await test('answerDialog', 'No, just SessionStore')
  await wait(1200)
  // Past the failed response: the countdown banner replaces the error card while the 2s retry delay runs.
  await resumeRaw(page, { pauseAt: 'final-text', instant: false })
  await shot('chat-retry', { settleMs: 650 })

  await wait(3600)
  await shot('chat-transcript-streaming', { settleMs: 700 })

  await test('mockPlay', { resume: true })
  await test('waitForIdle')
  await wait(800)
  await shot('chat-transcript-complete-bottom', { settleMs: 900 })
  await scrollTranscript(page, 0)
  await shot('chat-transcript-complete-top')
  await scrollTranscript(page, 0.5)
  await shot('chat-transcript-complete-middle')

  // Session header: context breakdown on hover, inline rename.
  await page.hover('[data-context-usage]')
  await shot('chat-header-context', { settleMs: 600 })
  await page.mouse.move(700, 500)
  await page.click('button[aria-label="Rename session"]')
  await shot('chat-header-rename', { settleMs: 300 })
  await page.keyboard.press('Escape')
  await page.mouse.move(700, 500)

  // Ctrl+T hides thinking blocks (pi's hideThinkingBlock); Ctrl+T again shows them.
  await scrollTranscript(page, 0)
  await page.keyboard.press('Control+t')
  await shot('chat-thinking-hidden', { settleMs: 600 })
  await page.keyboard.press('Control+t')
  await wait(300)

  await expandAll(page)
  await scrollTranscript(page, 0)
  await shot('chat-expanded-1', { settleMs: 700 })
  for (const [i, fraction] of [0.2, 0.4, 0.6, 0.8, 1].entries()) {
    await scrollTranscript(page, fraction)
    await shot(`chat-expanded-${i + 2}`)
  }

  await test('setPrefs', { theme: 'light' })
  await wait(400)
  await scrollTranscript(page, 1)
  await shot('chat-light-bottom', { settleMs: 700 })
  await scrollTranscript(page, 0.45)
  await shot('chat-light-middle')
  await scrollTranscript(page, 0.7)
  await shot('chat-light-tools')
  await test('setPrefs', { theme: 'dark' })

  // Gallery session: images, subagents, web, MCP fallback, edit error, custom, !cmd, branch summary, aborted.
  await newSession(page, wait)
  await test('mockPlay', {
    script: 'gallery',
    instant: true,
    prompt: 'The sidebar still shows the old title after I rename. Screenshots attached — is this the same bug?'
  })
  await wait(600)
  await scrollTranscript(page, 0)
  await shot('chat-gallery-top', { settleMs: 900 })
  await page.hover('[data-transcript-scroll] [class~="group/user"]')
  await shot('chat-gallery-user-hover', { settleMs: 400 })
  await page.click('[data-transcript-scroll] img[alt="Attachment 1"]')
  await shot('chat-gallery-lightbox', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await wait(300)
  // The small 320×200 attachment: upscaled for reading, captioned with position · dimensions · size.
  await page.click('[data-transcript-scroll] img[alt="Attachment 2"]')
  await shot('chat-lightbox-caption', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await wait(300)
  for (const [i, fraction] of [0.35, 0.7, 1].entries()) {
    await scrollTranscript(page, fraction)
    await shot(`chat-gallery-collapsed-${i + 1}`)
  }
  await expandAll(page)
  for (const [i, fraction] of [0, 0.25, 0.5, 0.75, 1].entries()) {
    await scrollTranscript(page, fraction)
    await shot(`chat-gallery-expanded-${i + 1}`, { settleMs: i === 0 ? 800 : 450 })
  }
  await page.hover('[data-transcript-scroll] [class~="group/turn"] >> nth=-1')
  await shot('chat-gallery-turn-hover', { settleMs: 400 })

  // JSON tool result as a key/value tree (URL link, id chips); the raw source behind its disclosure.
  await scrollToText(page, 'Linear create issue')
  await page.mouse.move(700, 500)
  await shot('chat-json-result-tree', { settleMs: 500 })
  const linearRaw = page.locator('[data-transcript-scroll] [data-tool-row]', { hasText: 'Linear create issue' }).locator('[data-row-detail] button:has-text("Raw")')
  await linearRaw.click()
  await wait(500)
  await scrollToText(page, 'Arguments')
  await shot('chat-json-result-raw', { settleMs: 500 })
  await linearRaw.click()
  await wait(300)

  await test('setPrefs', { theme: 'light' })
  await scrollTranscript(page, 0)
  await shot('chat-gallery-light-top', { settleMs: 700 })
  await scrollTranscript(page, 0.5)
  await shot('chat-gallery-light-middle')
  await scrollToText(page, 'Linear create issue')
  await shot('chat-json-result-tree-light', { settleMs: 500 })
  await test('setPrefs', { theme: 'dark' })

  // Parity session: PowerShell, tool_search, MCP resources + MCP tool, codemode nested calls, mermaid.
  await newSession(page, wait)
  await test('mockPlay', { script: 'parity', instant: true, prompt: 'Which stores still use the old debounce? File it in Linear if needed.' })
  await test('waitForIdle')
  await wait(600)
  await scrollTranscript(page, 0)
  await shot('chat-parity-top', { settleMs: 1200 })
  await scrollTranscript(page, 0.55)
  await shot('chat-parity-codemode', { settleMs: 600 })
  await scrollTranscript(page, 1)
  await shot('chat-parity-mermaid', { settleMs: 1500 })
  // Ctrl+O expands every tool card (pi's app.tools.expand); again restores the per-card defaults.
  await page.keyboard.press('Control+o')
  await scrollTranscript(page, 0)
  await shot('chat-parity-tools-expanded', { settleMs: 700 })
  await scrollTranscript(page, 0.5)
  await shot('chat-parity-tools-expanded-2')
  // An MCP result listing records, and script output that ends in JSON: both as structured trees.
  await scrollToText(page, 'Search issues')
  await shot('chat-json-record-list', { settleMs: 500 })
  await scrollToText(page, '3 stores')
  await shot('chat-json-script-output', { settleMs: 500 })
  await page.keyboard.press('Control+o')
  await scrollTranscript(page, 0)
  await shot('chat-parity-tools-collapsed', { settleMs: 700 })
  await test('setPrefs', { theme: 'light' })
  await scrollTranscript(page, 0)
  await shot('chat-parity-light-top', { settleMs: 900 })
  await scrollTranscript(page, 1)
  await shot('chat-parity-light-mermaid', { settleMs: 1500 })
  await test('setPrefs', { theme: 'dark' })

  // Long session: 220 turns (settled turns virtualized), mid-scroll and an exact jump back to the latest.
  await newSession(page, wait)
  await test('mockPlay', { script: 'marathon', instant: true, prompt: 'Walk through the stores step by step.' })
  await test('waitForIdle')
  await wait(800)
  await shot('chat-long-bottom', { settleMs: 900 })
  await scrollTranscript(page, 0.5)
  await shot('chat-long-middle', { settleMs: 700 })
  await page.click('button:has-text("Jump to latest")')
  await wait(1800)
  const distance = await distanceFromBottom(page)
  if (distance > 2) throw new Error(`Jump to latest stopped ${distance}px above the bottom`)
  await shot('chat-long-jumped', { settleMs: 300 })

  // The marathon session is past its context window: clamped gauges, over-limit badge and its explanation.
  const overLimit = await page.locator('[data-context-usage][data-over-limit]').count()
  if (overLimit !== 1) throw new Error('Expected the header context gauge in its over-limit state')
  await page.hover('[data-context-usage]')
  await shot('chat-context-over-limit', { settleMs: 600 })
  await test('setPrefs', { theme: 'light' })
  await shot('chat-context-over-limit-light', { settleMs: 600 })
  await test('setPrefs', { theme: 'dark' })

  await toolbeltScenarios(page, { shot, test, wait })
}
