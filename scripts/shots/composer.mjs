// Composer lane scenarios: composer states and footer controls, slash/mention menus with built-ins and argument
// hints, attachments, extension widgets, running queue (with images), extension dialogs + toasts, session info,
// command palette pages (recents, models, settings search, run with arguments), shortcut sheet, light theme.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** A small real folder so the @ picker (sys:list-files) has files to show. */
async function makeWorkspace() {
  const root = join(await mkdtemp(join(tmpdir(), 'vengeance-composer-')), 'aurora')
  const files = {
    'package.json': '{ "name": "aurora", "private": true }\n',
    'README.md': '# aurora\n',
    'tsconfig.json': '{}\n',
    'vite.config.ts': 'export default {}\n',
    '.gitignore': 'node_modules\n',
    'src/app.tsx': 'export {}\n',
    'src/session/store.ts': 'export class SessionStore {}\n',
    'src/session/store.test.ts': 'export {}\n',
    'src/session/persist.ts': 'export {}\n',
    'src/session/types.ts': 'export {}\n',
    'src/session/storage.json': '{}\n',
    'src/util/debounce.ts': 'export {}\n',
    'src/components/SessionList.tsx': 'export {}\n',
    'src/components/StatusBar.tsx': 'export {}\n',
    'scripts/release.sh': 'echo\n',
    'docs/sessions.md': '# Sessions\n',
    // The mock engine lists the project template `fix-tests` at this relative path (argument-hint frontmatter).
    '.pi/prompts/fix-tests.md':
      '---\ndescription: Run the test suite and fix failing tests\nargument-hint: "<test-filter> [max-attempts]"\n---\nRun $1 and fix failures.\n'
  }
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return root
}

export async function scenarios(page, helpers) {
  const workspace = await makeWorkspace()
  try {
    await composerScenarios(page, helpers, workspace)
  } finally {
    await rm(dirname(workspace), { recursive: true, force: true }).catch(() => undefined)
  }
}

async function composerScenarios(page, { shot, test, wait }, workspace) {
  const composer = page.locator('textarea[aria-label="Message"]')

  const clearComposer = async () => {
    await composer.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
  }
  const dismissToasts = async () => {
    for (const button of await page.locator('button[aria-label="Dismiss"]').all())
      await button.click().catch(() => undefined)
    await wait(200)
  }
  const command = (message) =>
    page.evaluate(
      (m) =>
        window.vengeance.invoke('engine:command', window.__vengeanceTest.activeAgentId(), {
          type: 'prompt',
          message: m
        }),
      message
    )
  const pasteImages = (count = 3) =>
    page.evaluate(async (count) => {
      async function image(w, h, hues, label) {
        const canvas = new OffscreenCanvas(w, h)
        const g = canvas.getContext('2d')
        const grad = g.createLinearGradient(0, 0, w, h)
        grad.addColorStop(0, `hsl(${hues[0]} 80% 55%)`)
        grad.addColorStop(1, `hsl(${hues[1]} 70% 30%)`)
        g.fillStyle = grad
        g.fillRect(0, 0, w, h)
        g.fillStyle = 'rgba(255,255,255,0.85)'
        for (let i = 0; i < 6; i++)
          g.fillRect(w * 0.1, h * (0.2 + i * 0.1), w * (0.3 + (i % 3) * 0.15), h * 0.04)
        return new File([await canvas.convertToBlob({ type: 'image/png' })], `${label}.png`, {
          type: 'image/png'
        })
      }
      const makers = [
        () => image(1200, 700, [140, 90], 'settings-page-mockup-v2'),
        () => image(3200, 2000, [12, 330], 'Screenshot 2025-06-14 at 09.41.27'),
        () => image(900, 900, [200, 260], 'diagram')
      ]
      const data = new DataTransfer()
      for (const make of makers.slice(0, count)) data.items.add(await make())
      document
        .querySelector('textarea[aria-label="Message"]')
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        )
    }, count)

  const modelPill = page.locator('[data-composer]').getByRole('button', { name: /^Model:/ })
  const thinkingPill = page.locator('[data-composer] button[aria-label^="Thinking level"]')
  const typeSlash = async (text) => {
    await clearComposer()
    await page.keyboard.type(text)
    await wait(150)
  }
  /** Type a slash command, close its menu and run it with Enter. */
  const runSlash = async (text) => {
    await typeSlash(text)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Enter')
  }
  const removeAttachments = () =>
    page.evaluate(() => {
      for (const b of document.querySelectorAll('button[aria-label^="Remove "]')) b.click()
    })

  await test('openWorkspace', workspace)
  await wait(400)
  await shot('composer-idle')

  // ─── Footer model + thinking controls (SPEC §9.1) ─────────────────────────
  await modelPill.click()
  await shot('composer-model-picker-open', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await wait(250)
  await thinkingPill.click()
  await shot('composer-thinking-control')
  await page.getByRole('menu').press('Escape')
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  await wait(250)

  // ─── Slash menu: grouped, filtered, built-ins, argument hints ─────────────
  await composer.click()
  await page.keyboard.type('/')
  await shot('slash-menu-open')
  await page.keyboard.type('co')
  await page.keyboard.press('ArrowDown')
  await shot('slash-menu-filtered')
  await typeSlash('/tr')
  await shot('slash-menu-builtins-trust-tree')
  await typeSlash('/ex')
  await shot('slash-menu-builtins-export')
  await typeSlash('/fix')
  await shot('slash-menu-template-hint')
  await page.keyboard.press('Enter')
  await wait(150)
  await shot('slash-arg-hint-template')
  // A required `<test-filter>` completes instead of running; fill it in and run the template.
  await page.keyboard.type('session')
  await page.keyboard.press('Enter')
  await wait(600)
  await typeSlash('/model ')
  await shot('slash-arg-hint-model')
  await typeSlash('/export ')
  await shot('slash-arg-hint-export')
  await clearComposer()

  // ─── Built-ins that open app surfaces ─────────────────────────────────────
  await runSlash('/session')
  await shot('slash-session-info-dialog', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await wait(300)
  await runSlash('/model claude')
  await shot('slash-model-fuzzy-picker', { settleMs: 600 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await wait(300)
  await runSlash('/login anthropic')
  await shot('slash-login-provider', { settleMs: 1400 })
  await test('closeSettings')
  await wait(400)
  await runSlash('/hotkeys')
  await shot('slash-hotkeys-sheet', { settleMs: 800 })
  await page.keyboard.press('Escape')
  await wait(400)
  await runSlash('/changelog')
  await shot('slash-changelog', { settleMs: 1200 })
  await page.keyboard.press('Escape')
  await wait(400)
  await dismissToasts()

  // ─── @ mention picker ─────────────────────────────────────────────────────
  await clearComposer()
  await page.keyboard.type('Why does the title revert? Look at @sto')
  await wait(300)
  await shot('mention-picker-open')
  await page.keyboard.press('Enter')

  // ─── Multi-line draft with image attachments ──────────────────────────────
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Repro: rename two sessions within 250 ms, then reload.')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Expected both titles to stick; only the last one survives.')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Screenshots attached.')
  await pasteImages()
  await wait(1200)
  await shot('composer-multiline-with-attachments')
  await clearComposer()
  await removeAttachments()

  // ─── Extension widgets above / below the editor ───────────────────────────
  // The todo widget renders as a native checklist; its duplicate "todos" status chip is hidden meanwhile.
  await command('/mock-ui widgets')
  await composer.click()
  await shot('composer-widgets', { settleMs: 600 })
  if ((await page.locator('[data-widget] ul li').count()) !== 3)
    throw new Error('The todo widget did not render as a checklist')
  await command('/mock-ui widgets-clear')

  // ─── Extension dialogs + toasts ───────────────────────────────────────────
  await command('/mock-ui select')
  await wait(300)
  await page.keyboard.press('ArrowDown')
  await shot('extension-select-dialog')
  await page.keyboard.type('rel')
  await shot('extension-select-filtered')
  await page.keyboard.press('Enter')
  await wait(300)
  await dismissToasts()

  await command('/mock-ui confirm')
  await shot('extension-confirm-dialog')
  await page.keyboard.press('y')
  await wait(300)
  await dismissToasts()

  await command('/mock-ui input')
  await wait(200)
  await page.keyboard.type('fix/session-title-race')
  await shot('extension-input-dialog')
  await page.keyboard.press('Enter')
  await wait(300)
  await dismissToasts()

  await command('/mock-ui editor')
  await shot('extension-editor-dialog')
  await page.keyboard.press('Control+Enter')
  await wait(300)
  await dismissToasts()

  await command('/mock-ui notify')
  await shot('toasts', { settleMs: 700 })
  await dismissToasts()

  // ─── Command palette ──────────────────────────────────────────────────────
  await test('setPalette', true)
  await shot('palette-root')
  await page.keyboard.type('comp')
  await shot('palette-search')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('retry')
  await shot('palette-settings-search')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('/todos')
  await shot('palette-extension-command')
  await page.keyboard.press('Tab')
  await page.keyboard.type('--open done')
  await shot('palette-run-with-args')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('qqzzx')
  await shot('palette-no-results')
  await page.keyboard.press('Escape')
  await wait(300)
  await dismissToasts()

  // Recents: the items just used lead the root page.
  await test('setPalette', true)
  await shot('palette-recents')
  await page.keyboard.press('Escape')
  await wait(300)

  // Nested pages start with an empty query (the root search that led there is not carried over).
  await test('setPalette', true)
  await page.keyboard.type('change model')
  await page.keyboard.press('Enter')
  await shot('palette-models-page', { settleMs: 600 })
  await page.keyboard.press('Backspace')
  await page.keyboard.type('thinking level')
  await page.keyboard.press('Enter')
  await shot('palette-thinking-page')
  const leftover = await page.locator('[cmdk-input]').inputValue()
  if (leftover !== '') throw new Error(`The thinking page kept the root query "${leftover}"`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await wait(300)

  // Setting search: the settings sheet opens on the row and pulses it.
  await test('setPalette', true)
  await page.keyboard.type('double escape')
  await wait(150)
  await page.keyboard.press('Enter')
  await shot('palette-setting-jump', { settleMs: 900 })
  await test('closeSettings')
  await wait(400)

  await page.keyboard.press('Control+/')
  await shot('shortcuts-sheet', { settleMs: 700 })
  await page.keyboard.press('Escape')
  await wait(300)

  // ─── Running: steer / follow-up queue (with an image), Esc Esc ────────────
  await test('mockPlay', { script: 'showcase', instant: true, pauseAt: 'bash-running' })
  await composer.click()
  await page.keyboard.type('Also check the rename flow in the sidebar')
  await page.keyboard.press('Enter')
  await page.keyboard.type('When done, compare against this mockup')
  await pasteImages(1)
  await wait(900)
  await page.keyboard.press('Alt+Enter')
  await wait(200)
  await page.keyboard.type('Prefer a per-session timer over a global debounce')
  await wait(300)
  await shot('composer-running', { settleMs: 700 })
  await page.keyboard.press('Escape')
  await shot('composer-esc-armed', { settleMs: 250 })
  await page.keyboard.press('Escape')
  await test('waitForIdle', 10_000)
  await wait(400)
  await shot('composer-stopped-queue-restored')

  // Escape twice on an empty idle editor runs doubleEscapeAction (default: the session tree).
  await clearComposer()
  await removeAttachments()
  await page.keyboard.press('Escape')
  await shot('composer-esc-tree-armed', { settleMs: 250 })
  await page.keyboard.press('Escape')
  await wait(500)
  await dismissToasts()

  // ─── Light theme ──────────────────────────────────────────────────────────
  await test('setPrefs', { theme: 'light' })
  await clearComposer()
  await page.keyboard.type('Compare these two layouts and suggest spacing fixes')
  await pasteImages()
  await wait(1200)
  await shot('composer-light', { settleMs: 600 })
  await clearComposer()
  await removeAttachments()
  await thinkingPill.click()
  await shot('composer-thinking-control-light')
  await page.keyboard.press('Escape')
  await wait(250)
  await command('/mock-ui widgets')
  await composer.click()
  await shot('composer-todo-widget-light', { settleMs: 600 })
  await page.keyboard.type('/')
  await shot('slash-menu-light')
  await clearComposer()
  await command('/mock-ui widgets-clear')
  await test('setPalette', true)
  await shot('palette-light')
  await page.keyboard.press('Escape')
  await wait(300)
  await command('/mock-ui confirm')
  await shot('extension-confirm-light')
  await page.keyboard.press('n')
  await wait(300)
  await dismissToasts()

  await speedScenarios(page, { shot, test, wait, dismissToasts }, modelPill)
}

/** Response speed: the footer pill per state, its menu, a fallback note, the Settings default. */
async function speedScenarios(page, { shot, test, wait, dismissToasts }, modelPill) {
  const speedPill = page.locator('[data-composer] button[aria-label^="Speed:"]')
  /** Pills at rest: no hover, no focus ring or tooltip left by the menu that just closed. */
  const settle = async () => {
    await wait(250)
    await page.mouse.move(760, 300)
    await page.evaluate(() => document.activeElement?.blur())
  }
  /** Pick `provider/id` by its row (not the first search hit), then wait for the footer to show it. */
  const chooseModel = async (value, name) => {
    await modelPill.click()
    await page.getByPlaceholder('Search models…').fill(name)
    await page.locator(`[cmdk-item][data-value="${value}"]`).click()
    await page.locator(`[data-composer] button[aria-label="Model: ${name}"]`).waitFor()
    await settle()
  }
  const chooseSpeed = async (label) => {
    await speedPill.click()
    await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click()
    await page.locator(`[data-composer] button[aria-label="Speed: ${label}"]`).waitFor()
    await settle()
  }

  await test('setPrefs', { theme: 'dark' })
  await chooseModel('openai/gpt-6.1-sol', 'GPT-6.1 Sol')
  await page.locator('[data-composer] button[aria-label="Speed: Standard"]').waitFor()
  await shot('composer-speed-standard')
  await speedPill.click()
  await shot('composer-speed-menu')
  await page.keyboard.press('Escape')
  await wait(250)
  await chooseSpeed('Fast')
  await shot('composer-speed-fast')
  await chooseSpeed('Ultrafast')
  const { prefs } = await test('appState')
  if (prefs.features.settings?.speedDefault !== 'ultrafast')
    throw new Error('Choosing a speed did not update the default for new sessions')

  // GPT-5.5 offers only Fast: the session keeps asking for Ultrafast and runs at Fast.
  await chooseModel('openai/gpt-5.5', 'GPT-5.5')
  await page.locator('[data-composer] button[aria-label="Speed: Fast"]').waitFor()
  await speedPill.click()
  await shot('composer-speed-fallback-menu')
  await page.keyboard.press('Escape')
  await settle()
  await test('setPrefs', { inspector: { open: true, width: 360, tab: 'overview' } })
  await shot('composer-speed-inspector-overview', { settleMs: 600 })

  await test('setPrefs', { theme: 'light' })
  await shot('composer-speed-fast-light')
  await test('setPrefs', { theme: 'dark' })

  // `/fast off`, then the palette toggle turns Fast back on.
  const composer = page.locator('textarea[aria-label="Message"]')
  await composer.fill('/fast off')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.locator('[data-composer] button[aria-label="Speed: Standard"]').waitFor()
  await test('setPalette', true)
  await page.keyboard.type('fast mode')
  await shot('palette-fast-mode')
  await page.keyboard.press('Enter')
  await page.locator('[data-composer] button[aria-label="Speed: Fast"]').waitFor()
  await settle()

  // GPT-6 Sol's provider refuses Fast: the session falls back to Standard with one notice, and
  // new sessions start at Standard again.
  await chooseModel('openai/gpt-6-sol', 'GPT-6 Sol')
  await page.locator('[data-composer] button[aria-label="Speed: Fast"]').waitFor()
  await dismissToasts()
  await page.evaluate(() =>
    window.vengeance.invoke('mock:play', window.__vengeanceTest.activeAgentId(), {
      script: 'short',
      prompt: 'Summarize the README',
      instant: true
    })
  )
  await page.locator('[data-composer] button[aria-label="Speed: Standard"]').waitFor()
  await page.getByText('Speed set to Standard', { exact: true }).waitFor()
  await settle()
  await shot('composer-speed-notice', { settleMs: 400 })
  const afterRefusal = await test('appState')
  if (afterRefusal.prefs.features.settings?.speedDefault !== 'standard')
    throw new Error('A refusal did not reset the default for new sessions to Standard')
  await dismissToasts()

  await test('openSettings', 'models')
  const row = page.locator('[id="setting-app.speedDefault"]')
  await row.scrollIntoViewIfNeeded()
  await shot('settings-speed-default', { settleMs: 600 })
  await test('closeSettings')
}
