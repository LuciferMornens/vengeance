// Design-system scenarios: the primitives gallery (#design, dev/test only) in Obsidian and Bone,
// plus a live dialog, toast stack and tooltip so overlays are inspected on real surfaces.
async function openGallery(page) {
  await page.evaluate(() => {
    window.location.hash = '#design'
  })
  await page.locator('[data-gallery]').waitFor()
}

async function scrollGallery(page, y) {
  await page.evaluate((top) => document.querySelector('[data-gallery]').scrollTo({ top }), y)
}

async function galleryPages(page, shot, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t
  }, theme)
  await page.getByRole('radio', { name: theme === 'light' ? 'Bone' : 'Obsidian' }).click()
  await scrollGallery(page, 0)
  await shot(`design-${theme}-1`)
  await scrollGallery(page, 860)
  await shot(`design-${theme}-2`)

  // Overlays on top of the second page.
  for (const level of ['Info', 'Warning', 'Success']) await page.getByRole('button', { name: level, exact: true }).click()
  await page.mouse.move(0, 0)
  await shot(`design-${theme}-toasts`, { settleMs: 600 })
  for (const button of await page.getByRole('button', { name: 'Dismiss' }).all()) await button.click().catch(() => undefined)

  await page.getByRole('button', { name: 'picker', exact: true }).click()
  await shot(`design-${theme}-dialog`, { settleMs: 500 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'confirm', exact: true }).click()
  await shot(`design-${theme}-confirm`, { settleMs: 500 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
}

export async function scenarios(page, { shot }) {
  await openGallery(page)
  await galleryPages(page, shot, 'dark')

  await page.getByRole('button', { name: 'New session' }).first().hover()
  await shot('design-dark-tooltip', { settleMs: 900 })
  await page.mouse.move(0, 0)

  await galleryPages(page, shot, 'light')
}
