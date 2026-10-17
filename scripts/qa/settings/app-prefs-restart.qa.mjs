// App-only settings (Settings → General, Engine → Work offline) and terminal-only engine settings:
// each one is changed in the real UI, checked where it lands (app-state.json / settings.json), checked
// for its effect (DOM + computed style, Engine argv, the Engine's own SettingsManager), then the app
// is quit and relaunched on the same userData and agent dir and every value must be back in the UI.
//
//   node scripts/qa/settings/app-prefs-restart.qa.mjs     (npm run build first)
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createAgentDir } from '../lib/agent-dir.mjs'
import { inspectRequest, startFakeLlm, turn } from '../lib/fake-llm.mjs'
import { importEngine } from './engine-sdk.mjs'
import { createPersistentProfile, launchPersistentApp } from './persistent-app.mjs'
import {
  choose,
  closeSettings,
  dismissToasts,
  fill,
  openSettings,
  readJsonOrNull,
  setSwitch,
  settingRow,
  softSteps,
  toastWith,
  waitFor
} from './settings-ui.mjs'

const SUITE = 'settings-app-prefs-restart'
const FEED_URL = 'https://updates.qa.invalid/vengeance'
const VAULT_SECRET = 'qa-test-value'
const { SettingsManager } = await importEngine('core/settings-manager.js')

/** A global extension that reports whether the Engine process got --offline. */
const ARGV_EXTENSION = `export default function (pi) {
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: event.systemPrompt + '\\nQA_ARGV offline=' + process.argv.includes('--offline')
  }))
}
`

/**
 * Terminal-only settings: the UI action, the JSON value it must write and what the Engine's own
 * SettingsManager must read back. `ui` is the label/text the row shows after a relaunch.
 */
const TERMINAL = [
  {
    key: 'theme',
    set: (app) => choose(app, 'theme', 'Light'),
    json: 'light',
    engine: (s) => s.getTheme()
  },
  {
    key: 'quietStartup',
    set: (app) => choose(app, 'quietStartup', 'Header only'),
    json: 'header',
    engine: (s) => s.getQuietStartup(),
    ui: { radio: 'Header only' }
  },
  {
    key: 'tuiMode',
    set: (app) => choose(app, 'tuiMode', 'Regular'),
    json: 'regular',
    engine: (s) => s.getTuiMode(),
    ui: { radio: 'Regular' }
  },
  {
    key: 'fullscreenCopyOnSelect',
    set: (app) => setSwitch(app, 'fullscreenCopyOnSelect', false),
    json: false,
    engine: (s) => s.getFullscreenCopyOnSelect(),
    ui: { switch: false }
  },
  {
    key: 'outputPad',
    set: (app) => choose(app, 'outputPad', 'None'),
    json: 0,
    engine: (s) => s.getOutputPad(),
    ui: { radio: 'None' }
  },
  {
    key: 'showHardwareCursor',
    set: (app) => setSwitch(app, 'showHardwareCursor', true),
    json: true,
    engine: (s) => s.getShowHardwareCursor(),
    ui: { switch: true }
  },
  {
    key: 'externalEditor',
    set: (app) => fill(app, 'externalEditor', 'code --wait'),
    json: 'code --wait',
    engine: (s) => s.getExternalEditorCommand(),
    ui: { input: 'code --wait' }
  },
  {
    key: 'doubleEscapeAction',
    set: (app) => choose(app, 'doubleEscapeAction', 'Nothing'),
    json: 'none',
    engine: (s) => s.getDoubleEscapeAction(),
    ui: { radio: 'Nothing' }
  },
  {
    key: 'treeFilterMode',
    set: (app) => choose(app, 'treeFilterMode', 'Hide tools'),
    json: 'no-tools',
    engine: (s) => s.getTreeFilterMode(),
    ui: { select: 'Hide tools' }
  },
  {
    key: 'terminal.imageWidthCells',
    set: (app) => fill(app, 'terminal.imageWidthCells', 80),
    json: 80,
    engine: (s) => s.getImageWidthCells(),
    ui: { input: '80' }
  },
  {
    key: 'terminal.hyperlinks',
    set: (app) => choose(app, 'terminal.hyperlinks', 'Off'),
    json: false,
    engine: (s) => s.getTerminalCapabilityOverrides().hyperlinks,
    ui: { radio: 'Off' }
  },
  {
    key: 'terminal.showTerminalProgress',
    set: (app) => setSwitch(app, 'terminal.showTerminalProgress', true),
    json: true,
    engine: (s) => s.getShowTerminalProgress(),
    ui: { switch: true }
  },
  {
    key: 'markdown.mermaid',
    set: (app) => choose(app, 'markdown.mermaid', 'Off'),
    json: 'off',
    engine: (s) => s.getMermaidRenderingMode(),
    ui: { radio: 'Off' }
  }
]

/** Agent-section settings the Engine only reads outside RPC (round trip only). */
const NO_RPC = [
  {
    key: 'collapseChangelog',
    set: (app) => setSwitch(app, 'collapseChangelog', true),
    json: true,
    engine: (s) => s.getCollapseChangelog(),
    ui: { switch: true }
  },
  {
    key: 'enableAnalytics',
    set: (app) => setSwitch(app, 'enableAnalytics', true),
    json: true,
    engine: (s) => s.getEnableAnalytics(),
    ui: { switch: true }
  },
  {
    key: 'enableInstallTelemetry',
    set: (app) => setSwitch(app, 'enableInstallTelemetry', false),
    json: false,
    engine: (s) => s.getEnableInstallTelemetry(),
    ui: { switch: false }
  },
  {
    key: 'warnings.anthropicExtraUsage',
    set: (app) => setSwitch(app, 'warnings.anthropicExtraUsage', false),
    json: false,
    engine: (s) => s.getWarnings().anthropicExtraUsage,
    ui: { switch: false }
  }
]

const at = (data, key) => key.split('.').reduce((value, part) => value?.[part], data)
const rootData = (app, name) =>
  app.page.evaluate((n) => document.documentElement.dataset[n] ?? null, name)
const rootVar = (app, name) =>
  app.page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name
  )
const radioChecked = (app, key, label) =>
  settingRow(app, key).getByRole('radio', { name: label, exact: true }).getAttribute('aria-checked')

/** What a row shows: `{ radio }` checked segment, `{ switch }` state, `{ input }` value, `{ select }` text. */
async function assertRowShows(app, key, ui) {
  const row = settingRow(app, key)
  if (ui.radio)
    assert.equal(await radioChecked(app, key, ui.radio), 'true', `${key}: ${ui.radio} checked`)
  if (ui.switch !== undefined) {
    assert.equal(await row.getByRole('switch').getAttribute('aria-checked'), String(ui.switch), key)
  }
  if (ui.input !== undefined)
    assert.equal(await row.locator('input').first().inputValue(), ui.input, key)
  if (ui.select)
    assert.match(await row.getByRole('combobox').first().innerText(), new RegExp(ui.select), key)
}

function stepRunner() {
  return async function step(label, action) {
    const started = performance.now()
    console.log(`  • ${label}`)
    const result = await action()
    console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
    return result
  }
}

const started = performance.now()
console.log(`▶ ${SUITE} (fake)`)
const server = await startFakeLlm()
const agentDir = await createAgentDir({
  server,
  files: { 'extensions/qa-argv.ts': ARGV_EXTENSION }
})
const profile = await createPersistentProfile()
const cwd = join(profile.root, 'workspace')
await mkdir(cwd)
const settingsPath = agentDir.path('settings.json')
const appStatePath = join(profile.userData, 'app-state.json')
let app = null
// softSteps screenshots through whichever app run is current.
const current = { screenshot: async (...args) => app?.screenshot(...args) }
const { check: step, finish } = softSteps({ step: stepRunner(), app: current }, SUITE)
let failed = null

try {
  app = await launchPersistentApp({ profile, agentDir: agentDir.dir })

  await step(
    'run 1: General → Theme "Bone" switches <html data-theme> and the page colors',
    async () => {
      await app.test('openWorkspace', cwd)
      const darkBg = await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      await openSettings(app, 'General')
      await app.page.getByRole('button', { name: /Bone/ }).click()
      await waitFor(async () => (await rootData(app, 'theme')) === 'light', 'data-theme=light')
      const lightBg = await app.page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      assert.notEqual(lightBg, darkBg)
      const [r, g, b] = lightBg.match(/\d+/g).map(Number)
      assert.ok(r + g + b > 600, `light background, got ${lightBg}`)
    }
  )

  await step(
    'run 1: Accent "Violet", Text size 110%, Density Compact, Motion Reduced apply live',
    async () => {
      const emberAccent = await rootVar(app, '--accent')
      await settingRow(app, 'app.accent').getByRole('button', { name: 'Violet' }).click()
      await waitFor(async () => (await rootData(app, 'accent')) === 'violet', 'data-accent=violet')
      // Bone uses a deeper violet (#7c3aed) than Obsidian (#8b5cf6).
      assert.equal((await rootVar(app, '--accent')).toLowerCase(), '#7c3aed')
      assert.notEqual(await rootVar(app, '--accent'), emberAccent)
      const textBefore = await rootVar(app, '--text-sm')
      const slider = settingRow(app, 'app.fontScale').getByRole('slider')
      await slider.focus()
      await app.page.keyboard.press('ArrowRight')
      await app.page.keyboard.press('ArrowRight')
      await waitFor(async () => (await rootVar(app, '--font-scale')) === '1.1', '--font-scale 1.1')
      await settingRow(app, 'app.fontScale').getByText('110%').waitFor()
      assert.notEqual(await rootVar(app, '--text-sm'), textBefore)
      await choose(app, 'app.density', 'Compact')
      await waitFor(async () => (await rootData(app, 'density')) === 'compact', 'data-density')
      assert.equal(await rootVar(app, '--row-h'), '28px')
      await choose(app, 'app.motion', 'Reduced')
      await waitFor(async () => (await rootData(app, 'motion')) === 'reduce', 'data-motion')
      await app.screenshot('settings-app-prefs-run1')
    }
  )

  await step(
    'run 1: Updates Off dims "Check for updates"; interval and feed URL are set',
    async () => {
      await choose(app, 'app.updates', 'Off')
      await settingRow(app, 'app.updateInterval').locator('.opacity-55').first().waitFor()
      await choose(app, 'app.updateInterval', 'Every 12 hours')
      await fill(app, 'app.feedUrl', FEED_URL)
    }
  )

  await step(
    'run 1: Apply engine changes "Later": an engine setting change offers no restart',
    async () => {
      await closeSettings(app)
      server.queue(turn.text('ok'))
      await app.send('first prompt')
      await openSettings(app, 'General')
      await choose(app, 'app.restartPolicy', 'Later')
      await dismissToasts(app)
      const before = (await app.invoke('engine:list')).map((e) => e.pid)
      await openSettings(app, 'Agent behavior')
      await choose(app, 'transport', 'Server-sent events')
      await app.page.waitForTimeout(1500)
      assert.equal(await toastWith(app, 'Restart to apply').count(), 0, 'no restart toast')
      assert.deepEqual(
        (await app.invoke('engine:list')).map((e) => e.pid),
        before
      )
    }
  )

  await step(
    'run 1: Apply engine changes "Restart": the next change restarts the engine itself',
    async () => {
      await openSettings(app, 'General')
      await choose(app, 'app.restartPolicy', 'Restart')
      const [before] = (await app.invoke('engine:list')).map((e) => e.pid)
      await openSettings(app, 'Agent behavior')
      await choose(app, 'transport', 'Automatic')
      await waitFor(
        async () => {
          const pids = (await app.invoke('engine:list')).map((e) => e.pid)
          return pids.length > 0 && !pids.includes(before)
        },
        'engine restarted',
        60_000
      )
      assert.equal(await toastWith(app, 'Restart to apply').count(), 0, 'restarted without asking')
    }
  )

  await step('run 1: Engine → Work offline: new sessions start with --offline', async () => {
    await openSettings(app, 'Engine')
    await settingRow(app, 'engine.offline').getByRole('switch').click()
    await waitFor(
      async () =>
        (await settingRow(app, 'engine.offline')
          .getByRole('switch')
          .getAttribute('aria-checked')) === 'true',
      'offline on'
    )
    await closeSettings(app)
    await app.test('openWorkspace', cwd)
    const composer = app.page.getByRole('textbox', { name: 'Message' })
    await waitFor(async () => (await composer.count()) === 1, 'one composer')
    const from = server.requests.length
    server.queue(turn.text('ok'))
    await app.send('offline?')
    const request = await server.waitForRequest(undefined, { from })
    assert.match(inspectRequest(request).system, /QA_ARGV offline=true/)
  })

  await step(
    'run 1: terminal-only and no-RPC settings write their JSON and the Engine reads them',
    async () => {
      await openSettings(app, 'Terminal mode')
      for (const setting of TERMINAL) await setting.set(app)
      await openSettings(app, 'Agent behavior')
      for (const setting of NO_RPC) await setting.set(app)
      const all = [...TERMINAL, ...NO_RPC]
      const wrongOnDisk = (json) =>
        all
          .filter((s) => JSON.stringify(at(json, s.key)) !== JSON.stringify(s.json))
          .map((s) => `${s.key}=${JSON.stringify(at(json, s.key))}`)
      const data = await waitFor(async () => {
        const json = await readJsonOrNull(settingsPath)
        return json && wrongOnDisk(json).length === 0 ? json : null
      }, 'every value in settings.json').catch(async (error) => {
        throw new Error(
          `${error.message.split(' (last')[0]}: ${wrongOnDisk(await readJsonOrNull(settingsPath))}`
        )
      })
      const engine = SettingsManager.create(cwd, agentDir.dir)
      const mismatches = all.filter(
        (s) => JSON.stringify(s.engine(engine)) !== JSON.stringify(s.json)
      )
      assert.deepEqual(
        mismatches.map(
          (s) =>
            `${s.key}: engine ${JSON.stringify(s.engine(engine))}, json ${JSON.stringify(at(data, s.key))}`
        ),
        []
      )
    }
  )

  await step(
    'run 1: doubleEscapeAction "Nothing" ignores Esc Esc; "Tree" opens the Branches tab',
    async () => {
      await closeSettings(app)
      const composer = app.page.getByRole('textbox', { name: 'Message' })
      const inspectorTab = async () => (await app.test('appState')).prefs.inspector
      await app.test('setPrefs', {
        inspector: { ...(await inspectorTab()), open: false, tab: 'overview' }
      })
      await composer.click()
      await composer.press('Escape')
      await composer.press('Escape')
      await app.page.waitForTimeout(300)
      assert.equal((await inspectorTab()).tab, 'overview', '"Nothing" did something')
      await openSettings(app, 'Terminal mode')
      await choose(app, 'doubleEscapeAction', 'Tree')
      await closeSettings(app)
      await composer.click()
      await composer.press('Escape')
      await composer.press('Escape')
      await waitFor(
        async () => (await inspectorTab()).tab === 'branches',
        'Branches tab after Esc Esc'
      )
      // treeFilterMode "Hide tools" is the tree's initial filter.
      await app.page.getByRole('radiogroup', { name: 'Show in tree' }).waitFor()
      const checked = await app.page
        .getByRole('radiogroup', { name: 'Show in tree' })
        .locator('[aria-checked="true"]')
        .innerText()
      assert.match(checked, /tools/i)
      await openSettings(app, 'Terminal mode')
      await choose(app, 'doubleEscapeAction', 'Nothing')
      await waitFor(
        async () => at(await readJsonOrNull(settingsPath), 'doubleEscapeAction') === 'none',
        'none'
      )
    }
  )

  await step('run 1: a workspace launch env value is saved for the folder', async () => {
    // Through the same app:set-state path the Launch options dialog uses (UI covered by launch-options.qa).
    const { features } = (await app.test('appState')).prefs
    await app.test('setPrefs', {
      features: {
        ...features,
        launch: { workspaces: { [cwd]: { env: { QA_VAULT: VAULT_SECRET } } } }
      }
    })
    await waitFor(
      async () => (await app.invoke('launch:reveal-env', cwd, 'QA_VAULT')) === VAULT_SECRET,
      'main holds the env value'
    )
  })

  await step('quit: app-state.json holds every app preference', async () => {
    await closeSettings(app)
    const { sealsSecrets } = app
    await app.close()
    app = null
    const prefs = JSON.parse(await readFile(appStatePath, 'utf8')).prefs
    assert.equal(prefs.theme, 'light')
    assert.equal(prefs.accent, 'violet')
    assert.equal(prefs.fontScale, 1.1)
    assert.equal(prefs.density, 'compact')
    assert.equal(prefs.features.settings.motion, 'reduce')
    assert.equal(prefs.features.settings.restartPolicy, 'always')
    assert.equal(prefs.features.updates.mode, 'off')
    assert.equal(prefs.features.updates.intervalHours, 12)
    assert.equal(prefs.features.updates.feedUrl, FEED_URL)
    assert.equal(prefs.features.updates.offline, true)
    const vault = prefs.features.launch.workspaces[cwd].env.QA_VAULT
    if (sealsSecrets) {
      const raw = await readFile(appStatePath, 'utf8')
      assert.ok(!raw.includes(VAULT_SECRET), 'env value in clear text on disk')
      assert.match(vault, /^vengeance-sealed:v1:/)
    } else {
      // Without OS encryption (Linux's basic password store) the value stays plain at rest.
      assert.equal(vault, VAULT_SECRET)
    }
  })

  app = await launchPersistentApp({ profile, agentDir: agentDir.dir })

  await step(
    'run 2: theme, accent, text size, density and motion are applied at startup',
    async () => {
      assert.equal(await rootData(app, 'theme'), 'light')
      assert.equal(await rootData(app, 'accent'), 'violet')
      assert.equal(await rootVar(app, '--font-scale'), '1.1')
      assert.equal(await rootData(app, 'density'), 'compact')
      assert.equal(await rootData(app, 'motion'), 'reduce')
    }
  )

  await step('run 2: General shows every saved choice', async () => {
    await openSettings(app, 'General')
    await app.page.getByRole('button', { name: /Bone/ }).locator('svg.lucide-check').waitFor()
    await settingRow(app, 'app.fontScale').getByText('110%').waitFor()
    await assertRowShows(app, 'app.density', { radio: 'Compact' })
    await assertRowShows(app, 'app.motion', { radio: 'Reduced' })
    await assertRowShows(app, 'app.restartPolicy', { radio: 'Restart' })
    await assertRowShows(app, 'app.updates', { radio: 'Off' })
    await assertRowShows(app, 'app.updateInterval', { select: 'Every 12 hours' })
    await assertRowShows(app, 'app.feedUrl', { input: FEED_URL })
    await app.screenshot('settings-app-prefs-run2')
    await openSettings(app, 'Engine')
    await assertRowShows(app, 'engine.offline', { switch: true })
  })

  await step(
    'run 2: terminal-only and no-RPC settings come back in the UI, file untouched',
    async () => {
      const before = await readFile(settingsPath, 'utf8')
      await openSettings(app, 'Terminal mode')
      for (const setting of TERMINAL) {
        if (setting.key === 'doubleEscapeAction')
          await assertRowShows(app, setting.key, { radio: 'Nothing' })
        else if (setting.ui) await assertRowShows(app, setting.key, setting.ui)
      }
      assert.match(
        await settingRow(app, 'theme').getByRole('combobox').first().innerText(),
        /Light/
      )
      await openSettings(app, 'Agent behavior')
      for (const setting of NO_RPC) await assertRowShows(app, setting.key, setting.ui)
      assert.equal(await readFile(settingsPath, 'utf8'), before, 'relaunch rewrote settings.json')
    }
  )

  await step('run 2: the sealed env value opens again and reaches a new engine', async () => {
    assert.equal(await app.invoke('launch:reveal-env', cwd, 'QA_VAULT'), VAULT_SECRET)
    await closeSettings(app)
    await app.test('openWorkspace', cwd)
    const composer = app.page.getByRole('textbox', { name: 'Message' })
    await waitFor(async () => (await composer.count()) === 1, 'one composer')
    const from = server.requests.length
    server.queue(turn.toolCall('bash', { command: 'echo "QA_VAULT=$QA_VAULT"' }), turn.text('done'))
    await app.send('vault?')
    const request = await server.waitForRequest(
      (r) => inspectRequest(r).toolResults.some((m) => m.text.includes('QA_VAULT=')),
      { from }
    )
    const output = inspectRequest(request).toolResults.find((m) =>
      m.text.includes('QA_VAULT=')
    ).text
    assert.equal(output.trim(), `QA_VAULT=${VAULT_SECRET}`)
  })

  await step('run 2: no renderer errors in either run', async () => {
    assert.deepEqual(app.errors(), [])
  })
} catch (error) {
  failed = error
} finally {
  await app?.close().catch(() => undefined)
  await server.close().catch(() => undefined)
  await agentDir.cleanup().catch(() => undefined)
  await profile.dispose().catch(() => undefined)
}

try {
  if (failed) throw failed
  finish()
  console.log(`✓ ${SUITE} passed (${((performance.now() - started) / 1000).toFixed(1)}s)`)
} catch (error) {
  console.error(`  ✗ ${error.stack ?? error}`)
  console.error(`✗ ${SUITE} failed (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  process.exitCode = 1
}
