// Settings lane scenarios: onboarding steps, every settings section, search, project scope,
// provider dialogs, packages live log, the extension gallery (details, topic search, card install),
// raw JSON diff, MCP server editor + log, terminal keybindings, system prompt files, saved trust
// decisions, model overrides, updates pill + full sheet, offline mode, the engine changelog, the
// "Engine updated" toast (over the Updates sheet at full and narrow width, and over the workbench),
// a settings error toast over the sheet and the light theme. All config writes land in the mock
// engine's seeded temp agent dir (never the real ~/.pi/agent).
import { mockHomePath } from './lib/mock-paths.mjs'

/** A window narrower than the Updates column plus a toast on either side (it clears both from ~1280px). */
const UPDATES_NARROW_WIDTH = 1100

const SECTIONS = [
  'general',
  'models',
  'providers',
  'custom-models',
  'agent',
  'extensions',
  'packages',
  'resources',
  'mcp',
  'sessions',
  'terminal',
  'keybindings',
  'shortcuts',
  'engine',
  'raw'
]

export async function scenarios(page, { app, shot, test, wait, MOCK_WORKSPACE }) {
  const sheet = page.locator('[role="dialog"]').first()
  const dialog = page.locator('[role="dialog"]').last()
  const escape = async () => {
    await page.keyboard.press('Escape')
    await wait(250)
  }
  const dismissToasts = async () => {
    for (const dismiss of await page.getByRole('button', { name: 'Dismiss' }).all())
      await dismiss.click().catch(() => undefined)
  }
  /**
   * Inject a resource-toggle failure at the settings gateway, then drive the resource switch through the UI.
   */
  const errorToastShot = async (name) => {
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      globalThis.__shotEngineSettings = handlers.get('engine:settings')
      ipcMain.removeHandler('engine:settings')
      ipcMain.handle('engine:settings', (event, request) => {
        if (request.engine === 'pi' && request.channel === 'settings:resource-toggle') {
          return { ok: false, error: { message: 'settings.json is locked by another program.' } }
        }
        return globalThis.__shotEngineSettings(event, request)
      })
    })
    try {
      await test('openSettings', 'resources')
      // A resource row's switch, once the list has loaded (the Skill commands switch below it is a setting).
      await sheet.getByRole('switch', { name: /^Enable / }).first().click()
      await page.getByText('Could not change resource').waitFor()
      await shot(name, { settleMs: 600 })
    } finally {
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('engine:settings')
        ipcMain._invokeHandlers.set('engine:settings', globalThis.__shotEngineSettings)
        delete globalThis.__shotEngineSettings
      })
    }
    await dismissToasts()
  }
  /** The engine changed on disk outside the app (e.g. a terminal update): main reports it and a toast shows. */
  const announceEngineUpdate = async () => {
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('updates:engine-changed', { from: '1.1.0', to: '1.2.0' })
    })
    await page.getByText('Engine updated').first().waitFor()
  }
  /** Resize the window's content width (height unchanged); resolves to the previous width. */
  const setWindowWidth = (width) =>
    app.evaluate(({ BrowserWindow }, w) => {
      const win = BrowserWindow.getAllWindows()[0]
      const [previous, height] = win.getContentSize()
      win.setContentSize(w, height)
      return previous
    }, width)
  /**
   * Scroll an element into view once the section around it has stopped changing height: rows that load
   * asynchronously (skeletons, trust entries, diagnostics) would otherwise push it after the scroll.
   */
  const scrollIntoViewSettled = (locator, block) =>
    locator.evaluate(
      async (el, { block, quietMs, timeoutMs }) => {
        let scroller = el.parentElement
        while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))
          scroller = scroller.parentElement
        const target = scroller ?? document.documentElement
        const loading = () => target.querySelector('[class*="v-shimmer"]') !== null
        const deadline = performance.now() + timeoutMs
        let height = target.scrollHeight
        let quietSince = performance.now()
        while (performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          if (target.scrollHeight !== height || loading()) {
            height = target.scrollHeight
            quietSince = performance.now()
          } else if (performance.now() - quietSince >= quietMs) break
        }
        el.scrollIntoView({ block })
      },
      { block, quietMs: 300, timeoutMs: 5000 }
    )
  /** Scroll a settings row (by its setting key) to the top of the sheet. */
  const reveal = async (key, block = 'start') => {
    const row = sheet.locator(`[id="setting-${key}"]`)
    await row.waitFor()
    await scrollIntoViewSettled(row, block)
    return row
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────
  test('setPrefs', {
    workspaces: [
      {
        path: mockHomePath('projects', 'nightshade'),
        name: 'nightshade',
        lastOpenedAt: Date.now() - 3_600_000
      },
      {
        path: mockHomePath('projects', 'ember-api'),
        name: 'ember-api',
        lastOpenedAt: Date.now() - 86_400_000 * 2
      }
    ]
  })
  await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 15_000 })
  await shot('settings-onboarding-1-engine', { settleMs: 1800 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('You’re connected').waitFor({ timeout: 15_000 })
  await shot('settings-onboarding-2-provider', { settleMs: 700 })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('Drop a folder here').waitFor()
  await shot('settings-onboarding-3-project', { settleMs: 700 })

  // ─── Settings sections ────────────────────────────────────────────────────
  await test('openWorkspace', MOCK_WORKSPACE)
  for (const section of SECTIONS) {
    await test('openSettings', section)
    await shot(`settings-section-${section}`, {
      settleMs: ['mcp', 'providers', 'packages', 'extensions'].includes(section) ? 1400 : 800
    })
  }

  await errorToastShot('settings-error-toast')

  // Search jumps to live, editable rows with highlighted matches.
  await test('openSettings', 'general')
  await sheet.getByLabel('Search settings').fill('compaction')
  await shot('settings-search', { settleMs: 700 })
  await sheet.getByLabel('Search settings').fill('')

  // Project scope with overrides (and global scope showing "Overridden in project").
  await test('openSettings', 'agent')
  await shot('settings-agent-global-overrides', { settleMs: 700 })
  await sheet.getByText('aurora', { exact: true }).click()
  await shot('settings-project-scope', { settleMs: 800 })
  await test('openSettings', 'models')
  await shot('settings-project-scope-models', { settleMs: 1000 })
  await sheet.getByText('Global', { exact: true }).first().click()

  // Provider sign-in (device code) and API key dialogs.
  await test('openSettings', 'providers')
  await sheet.getByRole('heading', { name: 'Subscriptions' }).waitFor()
  const copilot = sheet.locator('#setting-provider\\.github-copilot')
  await copilot.getByRole('button', { name: /sign in/i }).click()
  await page.getByText('WDJB-MJHT').waitFor()
  await shot('settings-provider-signin', { settleMs: 600 })
  await escape()
  const oauth = sheet.locator('#setting-provider\\.kimi-coding, #setting-provider\\.xai').first()
  if (await oauth.count()) {
    await oauth.getByRole('button', { name: /sign in/i }).click()
    await page.getByText('Your browser opened the sign-in page').waitFor()
    await shot('settings-provider-oauth-browser', { settleMs: 600 })
    await escape()
  }
  await sheet.getByPlaceholder('Filter providers').fill('groq')
  await sheet
    .locator('[id="setting-provider.groq"]')
    .getByRole('button', { name: 'Add key' })
    .click()
  await page.getByRole('button', { name: 'Save key' }).waitFor()
  await page.keyboard.type('sk-demo-not-a-real-key-123456')
  await shot('settings-provider-apikey', { settleMs: 500 })
  await escape()

  // Packages: streamed install log.
  await test('openSettings', 'packages')
  await sheet.getByPlaceholder(/npm:@scope\/pkg/).fill('npm:pi-web-tools')
  await sheet.getByRole('button', { name: 'Install', exact: true }).click()
  await wait(1600)
  await shot('settings-packages-live-log', { settleMs: 200 })
  await sheet.getByText(/^Done · /).waitFor({ timeout: 20_000 })
  await shot('settings-packages-installed', { settleMs: 600 })

  // Extensions: a package's details, a topic search, then a one-click install from a card.
  await test('openSettings', 'extensions')
  await sheet.getByRole('button', { name: 'About Git guard' }).click()
  await dialog.getByText('Extensions run with your permissions').waitFor()
  await shot('settings-extensions-details', { settleMs: 900 })
  await escape()
  await sheet.getByRole('button', { name: 'Memory', exact: true }).click()
  await sheet.getByText(/results? for “memory”/).waitFor()
  await shot('settings-extensions-search', { settleMs: 600 })
  await sheet.getByRole('button', { name: 'Popular', exact: true }).click()
  await sheet.getByRole('button', { name: 'About MCP bridge' }).waitFor()
  await sheet.getByRole('button', { name: 'Install', exact: true }).first().click()
  await sheet.getByText(/^Done · /).waitFor({ timeout: 20_000 })
  await shot('settings-extensions-installed', { settleMs: 600 })

  // Raw JSON: edit → review diff.
  await test('openSettings', 'raw')
  const editor = sheet.getByLabel('settings.json')
  const text = await editor.inputValue()
  await editor.fill(
    text
      .replace(/"defaultThinkingLevel": "[a-z]+"/, '"defaultThinkingLevel": "high"')
      .replace(/\n}\s*$/, ',\n  "quietStartup": true\n}\n')
  )
  await shot('settings-raw-edited', { settleMs: 600 })
  await sheet.getByRole('button', { name: 'Review & save' }).click()
  await shot('settings-raw-diff', { settleMs: 600 })
  await escape()

  // MCP: stdio editor (masked secret env/header values), HTTP editor with OAuth, server log.
  await test('openSettings', 'mcp')
  await sheet.getByRole('button', { name: 'github', exact: true }).click()
  await dialog.getByText('Per-tool exposure').waitFor()
  await shot('settings-mcp-editor', { settleMs: 600 })
  await escape()
  await sheet.getByRole('button', { name: 'sentry', exact: true }).click()
  await dialog.getByText('Client ID').waitFor()
  await shot('settings-mcp-editor-http', { settleMs: 600 })
  await escape()
  await sheet.getByRole('button', { name: 'Show log' }).click()
  await sheet.getByText('Hide', { exact: true }).waitFor()
  await sheet
    .getByText('Configuration', { exact: true })
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot('settings-mcp-log', { settleMs: 600 })

  // Terminal keybindings: capture a new key, which saves to keybindings.json (temp agent dir).
  await test('openSettings', 'keybindings')
  const followUp = await reveal('keybinding.app.message.followUp', 'center')
  await followUp.getByRole('button', { name: /^Add a key/ }).click()
  await shot('settings-keybindings-capture', { settleMs: 400 })
  await page.keyboard.press('Control+Shift+KeyJ')
  await followUp.getByRole('button', { name: 'Remove ctrl+shift+j' }).waitFor()
  await shot('settings-keybindings-custom', { settleMs: 600 })

  // Sessions & context: saved trust decisions, SYSTEM/APPEND_SYSTEM/AGENTS editors.
  await test('openSettings', 'sessions')
  await scrollIntoViewSettled(sheet.getByText('Saved trust decisions'), 'center')
  await shot('settings-trust-list', { settleMs: 600 })
  const append = await reveal('instructions.APPEND_SYSTEM.md')
  await append.getByRole('button', { name: 'Global' }).click()
  await dialog.getByRole('button', { name: 'Save' }).waitFor()
  await shot('settings-instructions-editor', { settleMs: 600 })
  await escape()

  // models.json modelOverrides for a built-in provider.
  await test('openSettings', 'custom-models')
  await sheet
    .getByText('Model overrides')
    .first()
    .evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot('settings-model-overrides', { settleMs: 700 })
  // Visual editors for headers, compatibility and sampling (provider level, then one model).
  await sheet.getByRole('button', { name: 'Headers and compatibility' }).first().click()
  await sheet
    .getByText('Request headers')
    .first()
    .evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await shot('settings-custom-models-advanced', { settleMs: 700 })
  await sheet
    .getByRole('button', { name: /^Headers, compatibility and sampling of/ })
    .first()
    .click()
  await sheet
    .getByText('Sampling defaults')
    .first()
    .evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot('settings-custom-models-model-advanced', { settleMs: 700 })

  // Engine: catalog refresh, reinstall, changelog, offline.
  await test('openSettings', 'engine')
  await reveal('engine.changelog')
  await shot('settings-engine-actions', { settleMs: 600 })
  await sheet
    .locator('[id="setting-engine.changelog"]')
    .getByRole('button', { name: 'Changelog' })
    .click()
  await page.getByRole('button', { name: 'Show file' }).waitFor()
  await shot('settings-changelog', { settleMs: 800 })
  await escape()
  await test('closeSettings')
  await wait(300)

  // ─── Updates ──────────────────────────────────────────────────────────────
  await page.evaluate(() => window.vengeance.invoke('updates:check', 'pi'))
  await page
    .getByRole('button', { name: /updates?$/ })
    .first()
    .waitFor({ timeout: 20_000 })
  await shot('settings-updates-pill', { settleMs: 900 })
  await page
    .getByRole('button', { name: /updates?$/ })
    .first()
    .click()
  await shot('settings-updates-sheet', { settleMs: 700 })
  await page.getByRole('button', { name: 'Update all' }).click()
  await wait(1500)
  await shot('settings-updates-running', { settleMs: 200 })
  await page.getByText('Updated', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('switch', { name: 'Work offline' }).click()
  await page.getByText('Working offline.').waitFor()
  await page.getByText('Working offline.').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot('settings-updates-offline', { settleMs: 500 })
  await page.getByRole('button', { name: 'Go online' }).click()

  // A toast over the nav-less Updates sheet stays bottom-right; the scroll column's tail clears it.
  await dismissToasts()
  await announceEngineUpdate()
  await sheet
    .locator('.overflow-y-auto')
    .first()
    .evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await shot('settings-updates-toast', { settleMs: 500 })
  const fullWidth = await setWindowWidth(UPDATES_NARROW_WIDTH)
  await shot('settings-updates-toast-narrow', { settleMs: 600 })
  await setWindowWidth(fullWidth)
  await dismissToasts()
  await escape()

  await announceEngineUpdate()
  await shot('settings-engine-updated-toast', { settleMs: 500 })
  await dismissToasts()

  // ─── Light theme ──────────────────────────────────────────────────────────
  test('setPrefs', { theme: 'light' })
  await test('openSettings', 'general')
  await shot('settings-light-general', { settleMs: 800 })
  await test('openSettings', 'providers')
  await shot('settings-light-providers', { settleMs: 1000 })
  await test('openSettings', 'agent')
  await shot('settings-light-agent', { settleMs: 800 })
  await errorToastShot('settings-light-error-toast')
  await test('closeSettings')
}
