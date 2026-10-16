// Full-window modals (palette, Settings sheet, dialogs) block the window with their own backdrop element.
// Behavior: an outside click closes the modal without reaching what is behind it, Tab stays inside, the
// transcript does not scroll under it, the titlebar is inert under a sheet, the composer gets focus back, and
// nothing is left behind. Cost guard: <body> never computes `pointer-events: none` and the toast position
// variables stay off :root, because toggling either restyles every element of a long transcript.
import assert from 'node:assert/strict'
import { turn } from '../lib/fake-llm.mjs'
import { runSuite } from '../lib/suite.mjs'

const LONG_ANSWER_LINES = 120
const SETTLE_MS = 300

await runSuite('shell/modals', async ({ server, app, step }) => {
  const { page } = app
  await app.openWorkspace({ files: { 'README.md': '# modals\n' } })
  const lines = Array.from({ length: LONG_ANSWER_LINES }, (_, i) => `Line ${i} of a long answer.`)
  server.queue(turn.text(lines.join('\n\n')))
  await app.send('Write a long answer')
  await app.waitForSettle()

  const sidebarToggle = page
    .locator('button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]')
    .first()
  const sidebarOpen = async () =>
    (await page.locator('button[aria-label="Hide sidebar"]').count()) > 0
  const scroller = page.locator('[data-transcript-scroll]').first()
  const scrollTop = () => scroller.evaluate((el) => el.scrollTop)
  const wheelOverTranscript = async () => {
    const box = await scroller.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3)
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(SETTLE_MS)
  }
  const backdropUnder = async (locator) => {
    const box = await locator.boundingBox()
    return page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.hasAttribute('data-modal-backdrop') ?? false,
      [box.x + box.width / 2, box.y + box.height / 2]
    )
  }
  // While a modal is open Radix still writes `pointer-events: none` inline on <body>; the backdrop rule keeps
  // it from applying, so only the computed value is checked then. Once closed, the inline value is gone too.
  const bodyState = () =>
    page.evaluate(() => ({
      computed: getComputedStyle(document.body).pointerEvents,
      rootToastWidth: getComputedStyle(document.documentElement)
        .getPropertyValue('--toast-w')
        .trim()
    }))
  const OPEN_BODY = { computed: 'auto', rootToastWidth: '' }
  const closedBody = async () => ({
    ...(await bodyState()),
    inline: await page.evaluate(() => document.body.style.pointerEvents)
  })
  const CLOSED_BODY = { computed: 'auto', rootToastWidth: '', inline: '' }

  await step('control: the wheel scrolls the transcript with no modal open', async () => {
    const before = await scrollTop()
    await wheelOverTranscript()
    assert.notEqual(await scrollTop(), before)
  })

  const palette = page.getByRole('dialog')
  await step('palette: opens over a backdrop without restyling <body>', async () => {
    await (await app.composer()).click()
    await page.keyboard.press('Control+k')
    await palette.waitFor()
    assert.equal(await page.locator('body > [data-modal-backdrop]').count(), 1)
    assert.deepEqual(await bodyState(), OPEN_BODY)
    assert.equal(await backdropUnder(sidebarToggle), true)
  })

  await step('palette: Tab keeps focus inside', async () => {
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
    assert.equal(await palette.evaluate((el) => el.contains(document.activeElement)), true)
  })

  await step('palette: the wheel does not scroll the transcript behind it', async () => {
    const before = await scrollTop()
    await wheelOverTranscript()
    assert.equal(await scrollTop(), before)
  })

  await step(
    'palette: an outside click closes it without reaching the sidebar toggle; the composer is refocused',
    async () => {
      const open = await sidebarOpen()
      await sidebarToggle.click({ force: true })
      await palette.waitFor({ state: 'detached' })
      assert.equal(await sidebarOpen(), open)
      assert.equal(
        await page.evaluate(() => Boolean(document.activeElement?.closest('[data-composer]'))),
        true
      )
    }
  )

  const settingsSearch = page.locator('input[aria-label="Search settings"]')
  await step('settings: the titlebar is covered and inert while the sheet is open', async () => {
    await page.keyboard.press('Control+Comma')
    await settingsSearch.waitFor()
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await backdropUnder(sidebarToggle), true)
    const open = await sidebarOpen()
    await sidebarToggle.click({ force: true })
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await sidebarOpen(), open)
    assert.equal(await settingsSearch.isVisible(), true)
    assert.deepEqual(await bodyState(), OPEN_BODY)
  })

  await step('settings: Escape closes it and leaves <body> untouched', async () => {
    await page.keyboard.press('Escape')
    await settingsSearch.waitFor({ state: 'detached' })
    assert.deepEqual(await closedBody(), CLOSED_BODY)
  })

  // Reopened while it is still sliding out, the sheet keeps its node and its backdrop mounts again after it.
  await step('settings: reopened during its exit, the sheet still takes clicks', async () => {
    await page.keyboard.press('Control+Comma')
    await settingsSearch.waitFor()
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Comma')
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await backdropUnder(settingsSearch), false)
    await settingsSearch.click({ timeout: 2000 })
    assert.equal(await settingsSearch.evaluate((el) => el === document.activeElement), true)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await settingsSearch.waitFor({ state: 'detached' })
  })

  await step('dialog: an outside click closes it without reaching the sidebar toggle', async () => {
    await page.keyboard.press('Control+k')
    await palette.waitFor()
    await page.keyboard.type('Fork from a previous message')
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await page.locator('body > [data-modal-backdrop]').count(), 1)
    const open = await sidebarOpen()
    await sidebarToggle.click({ force: true })
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await sidebarOpen(), open)
  })

  await step('after the modals: no backdrop is left and the titlebar works again', async () => {
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await page.locator('[data-modal-backdrop]').count(), 0)
    assert.deepEqual(await closedBody(), CLOSED_BODY)
    const open = await sidebarOpen()
    await sidebarToggle.click()
    await page.waitForTimeout(SETTLE_MS)
    assert.equal(await sidebarOpen(), !open)
  })
})
