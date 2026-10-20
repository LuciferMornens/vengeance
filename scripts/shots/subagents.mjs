// Subagents lane scenarios (mock `subagents` script): fleet pill and popover, the needs-decision state, the
// inspector Agents tab (live detail, steer box, finished output), the finished transcript in both themes,
// the LSP chip (hidden until a server ran, active, idle after it ran) and machine data in the Extensions tab.
// Each step asserts what it shows.

const PROMPT = 'Fix the session-tree jump on fork, and have someone review the tool rows redesign while you are at it.'
/** Model-facing protocol text that must never reach the screen. */
const RAW_PROTOCOL = /PI_SUBAGENT_|Detached\. Return control now|async-subagent-runs|Retention-managed|subagent\(\{|Inspect subagent updates above/
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Text of every element matching `selector`, joined. */
function textOf(page, selector) {
  return page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.innerText).join('\n'), selector)
}

/** S-owned surfaces (fleet pill, popover, inspector, status row, widgets) never show protocol text or the TUI progress line. */
async function assertCleanSurfaces(page, where) {
  const text = await textOf(page, '[data-fleet-pill], [data-fleet-popover], [role=tabpanel], [data-widget], [data-lsp-chip]')
  assert(!RAW_PROTOCOL.test(text), `${where}: raw protocol text in a subagent surface`)
  const body = await page.evaluate(() => document.body.innerText)
  assert(!body.includes('ctrl+o live detail'), `${where}: the hidden subagent-slash status is visible`)
  const widget = await page.evaluate(() => document.querySelector('[data-widget="subagent-async"]') !== null || [...document.querySelectorAll('[data-widget]')].some((el) => el.textContent.includes('PI_SUBAGENT')))
  assert(!widget, `${where}: subagent-async lines rendered as a widget`)
}

/**
 * Transcript rules (§6.6.2) need Lane T's transcript markers (`[data-activity-group]`); until that lane is
 * merged they are reported as skipped instead of failing on the old tool cards.
 */
async function assertTranscript(page, where) {
  const ready = await page.evaluate(() => document.querySelector('[data-activity-group]') !== null)
  if (!ready) {
    console.log(`  · ${where}: transcript assertions skipped (no Lane T activity groups in this build)`)
    return
  }
  const body = await page.evaluate(() => document.body.innerText)
  assert(!RAW_PROTOCOL.test(body), `${where}: raw protocol text on screen`)
  const transcript = await textOf(page, '[data-transcript-scroll]')
  assert(!UUID.test(transcript), `${where}: a run id is visible in the collapsed transcript`)
  const tall = await page.evaluate(() =>
    [...document.querySelectorAll('[data-activity-group]')].filter((el) => !el.hasAttribute('data-has-pinned') && el.getBoundingClientRect().height > 32).length
  )
  assert(tall === 0, `${where}: ${tall} settled activity group(s) taller than 32px`)
}

async function pillText(page) {
  return (await page.locator('[data-fleet-pill]').innerText().catch(() => '')).trim()
}

/** Park the mouse over the transcript so no chip or pill tooltip is open in the next shot. */
async function parkMouse(page, wait) {
  await page.mouse.move(720, 160)
  await wait(400)
}

/** Resume the paused run up to `label` (instant: the pause is the only quiet moment). */
async function playTo(test, label) {
  await test('mockPlay', { resume: true, instant: true, pauseAt: label })
}

export async function scenarios(page, { shot, test, wait, MOCK_WORKSPACE }) {
  await test('openWorkspace', MOCK_WORKSPACE)
  await wait(600)
  await test('setPrefs', { inspector: { open: false, width: 400, tab: 'overview' } })

  // Launched: two async runs. No language server has run yet, so the idle LSP status shows no chip.
  await test('mockPlay', { script: 'subagents', prompt: PROMPT, instant: true, pauseAt: 'launched' })
  await wait(400)
  assert((await pillText(page)).includes('2 agents'), `pill after launch reads "${await pillText(page)}"`)
  assert((await page.locator('[data-lsp-chip]').count()) === 0, 'an idle LSP chip shows before any language server ran')
  await assertCleanSurfaces(page, 'launched')
  await shot('subagents-launched')

  // Live fleet: worker, reviewer and a two-step workflow; the TypeScript server is running.
  await playTo(test, 'fleet-live')
  await wait(300)
  assert((await pillText(page)).includes('3 agents'), `pill while live reads "${await pillText(page)}"`)
  assert((await page.locator('[data-lsp-chip="success"]').count()) === 1, 'active LSP chip while the fleet runs')
  await assertCleanSurfaces(page, 'fleet-live')
  await parkMouse(page, wait)
  await shot('subagents-fleet-live')

  await page.locator('[data-fleet-pill]').click()
  await page.locator('[data-fleet-popover]').waitFor()
  const rows = await page.locator('[data-fleet-popover] [data-subagent-row]').count()
  assert(rows === 3, `popover lists ${rows} active runs`)
  assert((await page.locator('[data-fleet-popover] [data-subagent-child]').count()) === 2, 'workflow children in the popover')
  await assertCleanSurfaces(page, 'fleet-popover')
  await shot('subagents-fleet-popover')
  await test('setPrefs', { theme: 'light' })
  await shot('subagents-fleet-popover-light', { settleMs: 700 })
  await test('setPrefs', { theme: 'dark' })
  await page.keyboard.press('Escape')

  // Machine data: the async snapshot is inspectable in Extensions, never drawn near the composer.
  await test('setPrefs', { inspector: { open: true, width: 400, tab: 'extensions' } })
  await wait(500)
  const machineRow = page.locator('[data-machine-row="subagent-async"] button')
  await machineRow.click()
  await shot('inspector-extensions-machine-data', { settleMs: 600 })

  // A supervisor request: warning pill, Agents tab dot.
  await test('setPrefs', { inspector: { open: true, width: 400, tab: 'overview' } })
  await playTo(test, 'needs-decision')
  await wait(400)
  assert((await pillText(page)).includes('1 needs you'), `pill with a request reads "${await pillText(page)}"`)
  assert((await page.locator('[data-tab-dot="warning"]').count()) === 1, 'Agents tab warning dot')
  await assertCleanSurfaces(page, 'needs-decision')
  await shot('subagents-needs-decision')

  // Detail of the running worker (opened from the popover), with live activity from inspect.
  await page.locator('[data-fleet-pill]').click()
  await page.locator('[data-fleet-popover] [data-subagent-row]').first().waitFor()
  await page.getByRole('button', { name: 'Open worker' }).first().click()
  await page.locator('[data-subagent-activity]').waitFor({ timeout: 10_000 })
  await assertCleanSurfaces(page, 'detail-running')
  await shot('subagents-detail-running', { settleMs: 700 })

  await page.getByRole('button', { name: 'Steer…' }).click()
  await page.getByRole('textbox', { name: 'Message to worker' }).fill('Keep the virtualized list stable while new entries stream in; check it with the parity script.')
  await shot('subagents-steer', { settleMs: 500 })
  await page.keyboard.press('Enter')
  await page.locator('[data-steer-box] button', { hasText: 'Delivered' }).waitFor({ timeout: 10_000 })
  await page.keyboard.press('Escape')

  // Run to the end: the reviewer finishes, the worker times out and is resumed, the parent settles.
  await playTo(test, 'attention')
  await playTo(test, 'finished')
  await test('mockPlay', { resume: true, instant: true })
  await test('waitForIdle')
  await wait(500)

  await page.getByRole('button', { name: 'All agents' }).click().catch(() => undefined)
  await page.locator('[data-agents-list]').waitFor()
  // Every run of the session, with a keyboard focus ring on the reviewer row.
  await page.getByRole('button', { name: 'Open reviewer' }).first().focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await assertCleanSurfaces(page, 'agents-list')
  await shot('subagents-agents-list', { settleMs: 500 })
  await test('setPrefs', { theme: 'light' })
  await shot('subagents-agents-list-light', { settleMs: 700 })
  await test('setPrefs', { theme: 'dark' })
  await page.getByRole('button', { name: 'Open reviewer' }).first().click()
  await page.locator('[data-subagent-detail="complete"]').getByText('Output', { exact: true }).waitFor({ timeout: 10_000 })
  await assertCleanSurfaces(page, 'detail-done')
  await shot('subagents-detail-done', { settleMs: 700 })

  // Nothing lingers: after the done morph the pill is gone and the transcript is folded.
  await test('setPrefs', { inspector: { open: false, width: 400, tab: 'agents' } })
  await wait(4500)
  assert((await page.locator('[data-fleet-pill]').count()) === 0, `fleet pill still visible after settle: "${await pillText(page)}"`)
  await assertCleanSurfaces(page, 'finished')
  await assertTranscript(page, 'finished')
  await parkMouse(page, wait)
  await shot('subagents-finished-transcript')
  await test('setPrefs', { theme: 'light' })
  await shot('subagents-transcript-light', { settleMs: 700 })
  await test('setPrefs', { theme: 'dark' })

  // The TypeScript server ran earlier and has since idled: the calm idle chip explains the quiet.
  const idle = page.locator('[data-lsp-chip="idle"]')
  assert((await idle.innerText()).includes('Code intelligence idle'), 'idle LSP chip wording after a server ran')
  await idle.click()
  await page.locator('[data-status-details]').waitFor()
  await shot('composer-lsp-idle', { settleMs: 700 })
  await page.keyboard.press('Escape')
  await parkMouse(page, wait)

  // LSP active: pi-lens reports the TypeScript server after the first source read (showcase script).
  await page.click('button[aria-label="New session"]')
  await wait(1500)
  await test('mockPlay', { script: 'showcase', instant: true, pauseAt: 'select' })
  await page.locator('[data-lsp-chip="success"]').waitFor({ timeout: 10_000 })
  assert((await page.locator('[data-lsp-chip="success"]').innerText()).includes('TypeScript'), 'active LSP chip names the language')
  await page.locator('[data-lsp-chip="success"]').click()
  await page.locator('[data-status-details]').waitFor()
  await shot('composer-lsp-active', { settleMs: 700 })
  await page.keyboard.press('Escape')
}
