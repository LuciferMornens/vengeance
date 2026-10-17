// Responsive scenarios: the shell at the minimum window size, laptop, desktop, wide and 4K-class
// sizes, with the sidebar and inspector open or closed, an idle and a running composer (GPT-6.1
// Sol, High, Fast), the docked todo list expanded and collapsed, the empty session hero, settings,
// the extension gallery and the palette. A width sweep at the smallest and largest text sizes
// asserts that the center pane and the composer footer never overflow.

const SIZES = [
  { name: 'min', width: 880, height: 560 },
  { name: 'laptop', width: 1180, height: 740 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide', width: 1920, height: 1080 },
  { name: 'ultrawide', width: 2560, height: 1300 }
]

const WIDTH_SWEEP_STEP = 24

/** Narrowest center pane beside docked panels (MIN_CENTER_WIDTH in shell/panel-layout.ts). */
const MIN_CENTER_WIDTH = 480

async function resize(app, page, { width, height }) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(size.width, size.height)
      win.center()
    },
    { width, height }
  )
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height }
  )
}

/** Where the composer footer wraps or anything in the session pane overflows horizontally. */
async function layoutProblems(page, where) {
  const problems = await page.evaluate((minCenter) => {
    const found = []
    const main = document.querySelector('main')
    if (main && main.getBoundingClientRect().width < minCenter)
      found.push(`center pane is ${Math.round(main.getBoundingClientRect().width)}px wide`)
    const footer = document.querySelector('[data-composer-footer]')
    if (footer) {
      const rows = new Set(
        [...footer.querySelectorAll('button')]
          .filter((button) => button.offsetParent !== null)
          .map((button) => Math.round(button.getBoundingClientRect().bottom))
      )
      if (rows.size > 1) found.push(`composer footer controls sit on ${rows.size} rows`)
      const controls = footer.firstElementChild
      if (controls && controls.scrollWidth > controls.clientWidth + 1)
        found.push(
          `composer footer controls overflow by ${controls.scrollWidth - controls.clientWidth}px`
        )
      for (const button of footer.querySelectorAll('button')) {
        if (button.offsetParent !== null && button.scrollHeight > button.clientHeight + 1)
          found.push(`"${button.innerText.trim()}" wraps inside its button`)
      }
    }
    const pane = document.querySelector('[data-session-pane]')
    if (pane && pane.scrollWidth > pane.clientWidth + 1)
      found.push(`session pane overflows by ${pane.scrollWidth - pane.clientWidth}px`)
    return found
  }, MIN_CENTER_WIDTH)
  return problems.map((problem) => `${where}: ${problem}`)
}

export async function scenarios(page, { app, shot, test, wait, MOCK_WORKSPACE }) {
  const problems = []
  await test('openWorkspace', MOCK_WORKSPACE, { thinking: 'high' })
  const modelPill = page.locator('[data-composer] button[aria-label^="Model:"]')
  await modelPill.click()
  await page.getByPlaceholder('Search models…').fill('GPT-6.1 Sol')
  await page.locator('[cmdk-item][data-value="openai/gpt-6.1-sol"]').click()
  await page.locator('[data-composer] button[aria-label="Model: GPT-6.1 Sol"]').waitFor()
  await page.locator('[data-composer] button[aria-label^="Speed:"]').click()
  await page.getByRole('menuitemradio', { name: /^Fast/ }).click()
  await page.locator('[data-composer] button[aria-label="Speed: Fast"]').waitFor()
  await page.getByRole('menu').waitFor({ state: 'detached' })

  /** Pointer parked on the window's bottom-right edge (no hover state), focus dropped. */
  const rest = async () => {
    await page.mouse.move(
      await page.evaluate(() => window.innerWidth - 2),
      await page.evaluate(() => window.innerHeight - 2)
    )
    // Focus passes through the composer so no tooltip stays open on a control the setup clicked.
    await page.locator('textarea[aria-label="Message"]').focus()
    await page.evaluate(() => document.activeElement?.blur())
  }

  // Empty hero: the sidebar on short and laptop windows, both panels on large ones.
  for (const [size, inspector] of [
    [SIZES[0], false],
    [SIZES[1], false],
    [SIZES[2], true],
    [SIZES[3], true]
  ]) {
    await resize(app, page, size)
    await test('setPrefs', {
      sidebar: { open: true, width: 268 },
      inspector: { open: inspector, width: 340, tab: 'overview' }
    })
    await rest()
    await shot(`responsive-${size.name}-empty`, { settleMs: 700 })
  }

  // The todo list docks above the composer from the run's todo tool results, like the real Engine.
  await resize(app, page, SIZES[2])
  await test('mockPlay', { script: 'showcase', instant: true, pauseAt: 'bash-running' })
  await rest()
  const dockRows = await page.locator('[data-todo-dock] li').allInnerTexts()
  if (dockRows.length !== 3) problems.push(`todo dock shows ${dockRows.length} tasks mid-run`)
  await shot('responsive-desktop-todo-dock', { settleMs: 500 })
  // Its heading collapses it to the current task and expands it again.
  const dockHeading = page.locator('[data-todo-dock] button[aria-expanded]')
  await dockHeading.click()
  await page.locator('[data-todo-dock] li').first().waitFor({ state: 'detached' })
  const current = await page.locator('[data-todo-dock] [data-current-task]').innerText()
  if (current !== 'Add a regression test') problems.push(`collapsed todo dock shows "${current}"`)
  await rest()
  await shot('responsive-desktop-todo-dock-collapsed', { settleMs: 500 })
  await dockHeading.click()
  await page.locator('[data-todo-dock] li').nth(2).waitFor()
  await test('mockPlay', { resume: true, instant: true, pauseAt: 'select' })
  await test('mockPlay', { resume: true, instant: true })
  await test('mockPlay', { resume: true, instant: true, pauseAt: 'final-text' })
  await test('answerDialog', 'No, just SessionStore')

  for (const size of SIZES) {
    await resize(app, page, size)
    for (const [label, sidebar, inspector] of [
      ['bare', false, false],
      ['sidebar', true, false],
      ['panels', true, true]
    ]) {
      await test('setPrefs', {
        sidebar: { open: sidebar, width: 268 },
        inspector: { open: inspector, width: 340, tab: 'overview' }
      })
      await rest()
      await wait(600)
      problems.push(...(await layoutProblems(page, `${size.name} ${label} running`)))
      await shot(`responsive-${size.name}-${label}-running`, { settleMs: 200 })
    }
  }

  // The widest panels the dividers allow, on a laptop window.
  await resize(app, page, SIZES[1])
  await test('setPrefs', {
    sidebar: { open: true, width: 420 },
    inspector: { open: true, width: 560, tab: 'overview' }
  })
  await rest()
  await wait(600)
  problems.push(...(await layoutProblems(page, 'laptop max panels running')))
  await shot('responsive-laptop-maxpanels-running', { settleMs: 200 })

  // Every window width at the smallest and largest text sizes: the running footer never wraps.
  for (const fontScale of [0.85, 1.25]) {
    await test('setPrefs', { fontScale })
    for (const [sidebar, inspector] of [
      [true, false],
      [true, true]
    ]) {
      await test('setPrefs', {
        sidebar: { open: sidebar, width: 268 },
        inspector: { open: inspector, width: 340, tab: 'overview' }
      })
      for (let width = SIZES[0].width; width <= 1600; width += WIDTH_SWEEP_STEP) {
        await resize(app, page, { width, height: SIZES[1].height })
        await wait(250)
        const where = `${width}px, text ${fontScale * 100}%, inspector ${inspector}`
        problems.push(...(await layoutProblems(page, where)))
      }
    }
    await resize(app, page, SIZES[1])
    await shot(`responsive-laptop-panels-text-${fontScale * 100}`, { settleMs: 300 })
  }
  await test('setPrefs', { fontScale: 1 })

  await test('mockPlay', { resume: true, instant: true })
  for (const size of [SIZES[0], SIZES[1], SIZES[3]]) {
    await resize(app, page, size)
    await test('setPrefs', {
      sidebar: { open: true, width: 268 },
      inspector: { open: true, width: 340, tab: 'overview' }
    })
    await rest()
    await wait(600)
    problems.push(...(await layoutProblems(page, `${size.name} idle`)))
    await shot(`responsive-${size.name}-panels-idle`, { settleMs: 200 })
  }

  // Tasks finished during an earlier prompt leave the dock.
  await test('mockPlay', { script: 'short', instant: true })
  await page
    .locator('[data-todo-dock]')
    .waitFor({ state: 'detached', timeout: 3_000 })
    .catch(() => problems.push('todo dock still shows tasks finished before the latest prompt'))

  await test('setPrefs', { inspector: { open: false, width: 340, tab: 'overview' } })
  for (const size of [SIZES[0], SIZES[3]]) {
    await resize(app, page, size)
    await test('openSettings', 'general')
    await shot(`responsive-${size.name}-settings`, { settleMs: 700 })
    await test('openSettings', 'extensions')
    await shot(`responsive-${size.name}-extensions`, { settleMs: 1000 })
    await test('closeSettings')
    await test('setPalette', true)
    await shot(`responsive-${size.name}-palette`)
    await test('setPalette', false)
  }

  if (problems.length) throw new Error(`Layout problems:\n    ${problems.join('\n    ')}`)
}
