// Window chrome across restarts on ONE persistent temp profile: minimum size, saved size/position,
// maximize restore, off-screen recovery, the frameless titlebar (drag region, caption-button
// reserve, window-controls overlay), sidebar and inspector toggles and resizing (keyboard, pointer,
// double-click, persisted), theme dark/light/system (DOM + native window), text size and zoom.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { startFakeLlm } from '../lib/fake-llm.mjs'
import {
  launchRaw,
  runPalette,
  seedAppState,
  shot,
  sleep,
  tempRoot,
  waitUntil
} from './lib/kit.mjs'

const failures = []
/** QA_ONLY=<regex>: run only the matching steps (debugging). */
const only = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY) : null
async function step(label, action) {
  if (only && !only.test(label)) return
  console.log(`  • ${label}`)
  try {
    await action()
    console.log(`    ✓ ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`    ✗ ${label}\n      ${String(error.message).split('\n').join('\n      ')}`)
  }
}

console.log('▶ shell/window (fake, persistent temp profile)')
const root = await tempRoot('vengeance-qa-window-')
const server = await startFakeLlm()
const agentDir = await createAgentDir({ server })
const userData = root.path('profile', 'user-data')
const workspace = await root.folder('ws', { 'README.md': '# window\n' })
const savedState = async () => JSON.parse(await readFile(join(userData, 'app-state.json'), 'utf8'))
const NORMAL = { x: 120, y: 90, width: 1180, height: 760 }

let run
const launch = () => launchRaw({ userData, agentDir: agentDir.dir })
const openSession = async () => {
  await run.test('openWorkspace', workspace)
  await run.page.getByRole('textbox', { name: 'Message' }).first().waitFor()
}

try {
  run = await launch()

  await step('minimum size 880×560 is enforced', async () => {
    const result = await run.win((win) => {
      win.unmaximize()
      win.setSize(500, 300)
      return { min: win.getMinimumSize(), size: win.getSize() }
    })
    assert.deepEqual(result.min, [880, 560])
    assert.ok(result.size[0] >= 880 && result.size[1] >= 560, `size ${result.size}`)
  })

  const normalOf = (b) => ({ x: b.x, y: b.y, width: b.width, height: b.height })

  await step('size and position persist across a restart', async () => {
    await run.win((win, b) => win.setBounds(b), NORMAL)
    await sleep(1500)
    await run.close()
    const state = await savedState()
    run = await launch()
    // Regression check for shell-0 (fixed in 9472547).
    assert.deepEqual(normalOf(state.window ?? {}), NORMAL)
    assert.equal(state.window.maximized, false)
    const bounds = await run.win((win) => ({ ...win.getBounds(), max: win.isMaximized() }))
    assert.deepEqual(normalOf(bounds), NORMAL)
    assert.equal(bounds.max, false)
  })

  await step(
    'maximized state persists and un-maximizing restores the saved normal bounds',
    async () => {
      await run.win((win) => win.maximize())
      await sleep(1500)
      await run.close()
      const maximized = (await savedState()).window?.maximized
      run = await launch()
      assert.equal(maximized, true)
      assert.equal(await run.win((win) => win.isMaximized()), true)
      await run.win((win) => win.unmaximize())
      await sleep(400)
      assert.deepEqual(normalOf(await run.win((win) => win.getBounds())), NORMAL)
    }
  )

  await step('quitting right after a move/resize still saves the final bounds', async () => {
    const FINAL = { x: 200, y: 120, width: 1000, height: 640 }
    await run.win((win, b) => win.setBounds(b), FINAL)
    await sleep(100)
    await run.close()
    const saved = normalOf((await savedState()).window ?? {})
    run = await launch()
    await run.win((win, b) => win.setBounds(b), NORMAL)
    await sleep(1500)
    assert.deepEqual(saved, FINAL)
  })

  await step('frameless titlebar: drag region, 138px caption reserve, overlay rect', async () => {
    await openSession()
    const info = await run.page.evaluate(() => {
      const header = document.querySelector('header')
      const style = getComputedStyle(header)
      const rect = header.getBoundingClientRect()
      const reserveLeft = window.innerWidth - window.vengeance.platform.captionButtonsWidth
      const interactive = [...header.querySelectorAll('button, [role="button"], a, input')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => {
          const r = el.getBoundingClientRect()
          return {
            name: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30),
            right: r.right,
            region:
              getComputedStyle(el).webkitAppRegion ||
              getComputedStyle(el).getPropertyValue('-webkit-app-region')
          }
        })
      const overlay = navigator.windowControlsOverlay
      return {
        region: style.webkitAppRegion || style.getPropertyValue('-webkit-app-region'),
        height: rect.height,
        paddingRight: parseFloat(style.paddingRight),
        reserveLeft,
        interactive,
        overlayVisible: overlay?.visible ?? null,
        overlayRect: overlay ? overlay.getTitlebarAreaRect().toJSON() : null,
        width: window.innerWidth
      }
    })
    assert.equal(info.region, 'drag')
    assert.equal(info.height, 40)
    assert.ok(info.paddingRight >= 138, `padding-right ${info.paddingRight}`)
    for (const el of info.interactive) {
      assert.ok(
        el.right <= info.reserveLeft,
        `${el.name} overlaps the caption buttons (${el.right} > ${info.reserveLeft})`
      )
      assert.equal(el.region, 'no-drag', `${el.name} must be no-drag to be clickable`)
    }
    assert.equal(info.overlayVisible, true)
    assert.ok(info.overlayRect.width <= info.width - 138 + 1, JSON.stringify(info.overlayRect))
    await shot(run.page, 'window-1-titlebar')
  })

  await step('sidebar: Ctrl+B and the titlebar button toggle it, the state persists', async () => {
    const open = async () => (await run.test('appState')).prefs.sidebar.open
    assert.equal(await open(), true)
    await run.page.keyboard.press('Control+b')
    await waitUntil(async () => (await open()) === false, { label: 'sidebar closed' })
    await run.page.getByRole('button', { name: 'Show sidebar' }).click()
    await waitUntil(async () => (await open()) === true, { label: 'sidebar open' })
    await run.page.getByRole('button', { name: 'Hide sidebar' }).click()
    await waitUntil(async () => (await open()) === false, { label: 'sidebar closed again' })
    await sleep(600)
    const width = await run.page
      .locator('aside')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width)
    assert.equal(width, 0)
    await run.page.keyboard.press('Control+b')
    await waitUntil(async () => (await open()) === true, { label: 'sidebar reopened' })
  })

  await step(
    'sidebar resize: keyboard steps, Home/End limits 208/420, pointer drag, double-click 268',
    async () => {
      const handle = run.page.getByRole('separator', { name: 'Resize sidebar' })
      const width = async () => (await run.test('appState')).prefs.sidebar.width
      await handle.focus()
      const start = await width()
      await run.page.keyboard.press('ArrowRight')
      await waitUntil(async () => (await width()) === start + 16, { label: '+16' })
      await run.page.keyboard.press('Home')
      await waitUntil(async () => (await width()) === 208, { label: 'min 208' })
      await run.page.keyboard.press('End')
      await waitUntil(async () => (await width()) === 420, { label: 'max 420' })
      await sleep(800) // let the width spring settle before grabbing the handle
      const box = await handle.boundingBox()
      // Grab the part of the handle that is not clipped (see the hit-width step below).
      await run.page.mouse.move(box.x + 1.5, box.y + box.height / 2)
      await run.page.mouse.down()
      await run.page.mouse.move(box.x + 1.5 - 100, box.y + box.height / 2, { steps: 8 })
      await run.page.mouse.up()
      await waitUntil(async () => (await width()) === 320, { label: 'dragged to 320' })
      await handle.dblclick()
      await waitUntil(async () => (await width()) === 268, { label: 'reset 268' })
      await run.page.keyboard.press('Shift+Tab')
    }
  )

  await step(
    'inspector: Ctrl+I and the header button toggle it; resize 280..560 and persist',
    async () => {
      const prefs = async () => (await run.test('appState')).prefs.inspector
      await run.page.getByRole('textbox', { name: 'Message' }).first().click()
      await run.page.keyboard.press('Control+i')
      await waitUntil(async () => (await prefs()).open === true, { label: 'inspector open' })
      await run.page.getByRole('button', { name: 'Hide inspector' }).first().click()
      await waitUntil(async () => (await prefs()).open === false, { label: 'inspector closed' })
      await run.page.getByRole('button', { name: 'Show inspector' }).first().click()
      await waitUntil(async () => (await prefs()).open === true, { label: 'inspector reopened' })
      const handle = run.page.getByRole('separator', { name: 'Resize inspector' })
      await handle.focus()
      await run.page.keyboard.press('Home')
      await waitUntil(async () => (await prefs()).width === 280, { label: 'min 280' })
      await run.page.keyboard.press('ArrowLeft')
      await waitUntil(async () => (await prefs()).width === 296, {
        label: 'ArrowLeft grows the right panel'
      })
      await run.page.keyboard.press('End')
      await waitUntil(async () => (await prefs()).width === 560, { label: 'max 560' })
      await sleep(800) // let the width spring settle before grabbing the handle
      const box = await handle.boundingBox()
      await run.page.mouse.move(box.x + box.width - 1.5, box.y + 300)
      await run.page.mouse.down()
      await run.page.mouse.move(box.x + box.width - 1.5 + 160, box.y + 300, { steps: 8 })
      await run.page.mouse.up()
      await waitUntil(async () => (await prefs()).width === 400, { label: 'dragged to 400' })
      await shot(run.page, 'window-2-inspector-open')
      await sleep(500)
      await run.close()
      const saved = (await savedState()).prefs
      run = await launch()
      // Regression check for shell-0 (fixed in 9472547).
      assert.equal(saved.inspector.open, true)
      assert.equal(saved.inspector.width, 400)
      assert.equal(saved.sidebar.width, 268)
      assert.equal((await run.test('appState')).prefs.inspector.width, 400)
    }
  )

  await step(
    'resize handles: the whole 8px grip is hittable (not clipped by the panel)',
    async () => {
      for (const name of ['Resize sidebar', 'Resize inspector']) {
        const box = await run.page.getByRole('separator', { name }).boundingBox()
        const hittable = await run.page.evaluate((b) => {
          let count = 0
          for (let dx = 0; dx < b.width; dx++) {
            const el = document.elementFromPoint(b.x + dx + 0.5, b.y + 300)
            if (el?.getAttribute('role') === 'separator') count++
          }
          return count
        }, box)
        assert.ok(hittable >= 6, `${name}: only ${hittable}px of ${box.width}px can be grabbed`)
      }
    }
  )

  await step('theme: Bone (light) applies to the DOM and the native window, persists', async () => {
    await openSession()
    await run.test('openSettings', 'general')
    await run.page.getByRole('button', { name: /Bone/ }).click()
    await waitUntil(
      async () =>
        (await run.page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
      { label: 'light DOM' }
    )
    const native = await run.app.evaluate(({ BrowserWindow, nativeTheme }) => ({
      source: nativeTheme.themeSource,
      background: BrowserWindow.getAllWindows()[0].getBackgroundColor()
    }))
    assert.equal(native.source, 'light')
    assert.equal(native.background.toUpperCase(), '#F4F2EE')
    await shot(run.page, 'window-3-theme-light-settings')
    await run.test('closeSettings')
    await shot(run.page, 'window-4-theme-light-session')
  })

  await step('theme: System follows the OS color scheme (emulated light → dark)', async () => {
    await run.test('setPrefs', { theme: 'system' })
    await run.page.emulateMedia({ colorScheme: 'light' })
    await waitUntil(
      async () =>
        (await run.page.evaluate(() => document.documentElement.dataset.theme)) === 'light',
      { label: 'system→light' }
    )
    await run.page.emulateMedia({ colorScheme: 'dark' })
    await waitUntil(
      async () =>
        (await run.page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
      { label: 'system→dark' }
    )
    // System never pins nativeTheme to the resolved theme, or Windows theme changes stop arriving (shell-6).
    const source = await run.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
    assert.equal(source, 'system')
    await run.page.emulateMedia({ colorScheme: null })
  })

  await step('theme: a light theme starts with a light native window (no dark flash)', async () => {
    await run.close()
    // Seeded on disk (not through the UI) so this check is independent of shell-0.
    await seedAppState(userData, {
      ...(await savedState()),
      prefs: { ...(await savedState()).prefs, theme: 'light' }
    })
    run = await launch()
    const bg = await run.win((win) => win.getBackgroundColor())
    assert.equal(bg.toUpperCase(), '#F4F2EE')
  })

  await step(
    'theme: System keeps nativeTheme on "system" so Windows theme changes still reach the app',
    async () => {
      await run.close()
      await seedAppState(userData, {
        ...(await savedState()),
        prefs: { ...(await savedState()).prefs, theme: 'system' }
      })
      run = await launch()
      await sleep(500)
      const source = await run.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
      assert.equal(source, 'system', `nativeTheme.themeSource with theme=system: ${source}`)
      await run.test('setPrefs', { theme: 'dark' })
    }
  )

  await step('text size: the slider scales UI and prose, persists (85%..125%)', async () => {
    await openSession()
    await run.test('openSettings', 'general')
    const slider = run.page.getByRole('slider', { name: 'Text size' })
    const fontPx = () =>
      run.page.evaluate(() =>
        parseFloat(
          getComputedStyle(document.querySelector('textarea[aria-label="Message"]')).fontSize
        )
      )
    const before = await fontPx()
    await slider.focus()
    await run.page.keyboard.press('End')
    await waitUntil(async () => (await run.test('appState')).prefs.fontScale === 1.25, {
      label: 'scale 1.25'
    })
    const after = await fontPx()
    assert.ok(after > before * 1.15, `composer font ${before}px → ${after}px`)
    assert.equal(
      await run.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()
      ),
      '1.25'
    )
    await run.test('closeSettings')
    await shot(run.page, 'window-5-text-125')
    await run.page.keyboard.press('Control+,')
    await slider.focus()
    await run.page.keyboard.press('Home')
    await waitUntil(async () => (await run.test('appState')).prefs.fontScale === 0.85, {
      label: 'scale 0.85'
    })
    await run.test('closeSettings')
    await sleep(500)
    await run.close()
    const fontScale = (await savedState()).prefs.fontScale
    run = await launch()
    await run.test('setPrefs', { fontScale: 1 })
    // Regression check for shell-0 (fixed in 9472547).
    assert.equal(fontScale, 0.85)
  })

  await step(
    'page zoom: Ctrl+wheel / Ctrl+= never leave the window zoomed without a way back',
    async () => {
      await openSession()
      const zoom = () => run.win((win) => win.webContents.getZoomFactor())
      await run.page.mouse.move(700, 400)
      await run.page.keyboard.down('Control')
      await run.page.mouse.wheel(0, -400)
      await run.page.keyboard.up('Control')
      await sleep(300)
      await run.page.keyboard.press('Control+=')
      await sleep(300)
      const zoomed = await zoom()
      console.log(`      zoom factor after Ctrl+wheel / Ctrl+= : ${zoomed}`)
      if (zoomed !== 1) {
        await run.page.keyboard.press('Control+0')
        await sleep(300)
        assert.equal(await zoom(), 1, 'Ctrl+0 resets the zoom')
      }
    }
  )

  await step('palette: "Toggle sidebar"/"Toggle inspector" do what they say', async () => {
    const before = (await run.test('appState')).prefs
    await runPalette(run.page, 'Toggle sidebar')
    await waitUntil(
      async () => (await run.test('appState')).prefs.sidebar.open !== before.sidebar.open,
      { label: 'sidebar toggled' }
    )
    await runPalette(run.page, 'Toggle inspector')
    await waitUntil(
      async () => (await run.test('appState')).prefs.inspector.open !== before.inspector.open,
      { label: 'inspector toggled' }
    )
  })

  const errors = run.errors()
  if (errors.length) failures.push(`app errors: ${errors.join(' | ')}`)
  await run.close()

  await step('off-screen saved bounds recover onto a visible display', async () => {
    const state = await savedState()
    await seedAppState(userData, {
      ...state,
      window: { x: -30000, y: -30000, width: 1100, height: 700, maximized: false }
    })
    run = await launch()
    const visible = await run.app.evaluate(({ BrowserWindow, screen }) => {
      const b = BrowserWindow.getAllWindows()[0].getBounds()
      return screen
        .getAllDisplays()
        .some(
          ({ workArea: w }) =>
            b.x >= w.x - 10 && b.y >= w.y - 10 && b.x < w.x + w.width && b.y < w.y + w.height
        )
    })
    assert.equal(visible, true)
    await run.close()
  })
} catch (error) {
  failures.push(error.stack ?? String(error))
  if (run) await shot(run.page, 'window-FAILED', { settleMs: 0 }).catch(() => undefined)
} finally {
  await run?.close().catch(() => undefined)
  await server.close()
  await agentDir.cleanup()
  await root.cleanup()
}

if (failures.length) {
  console.error(`✗ shell/window: ${failures.length} failure(s)\n  ${failures.join('\n  ')}`)
  process.exitCode = 1
} else console.log('✓ shell/window passed')
