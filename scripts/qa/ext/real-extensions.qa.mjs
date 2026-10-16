// REAL mode, read-only, no model calls: open a temp workspace against the user's real engine config
// and record which real extensions load (commands, tools, statuses, widgets), any extension_error
// events, and how their UI shows up. The inventory goes to reports/qa/ext-real-inventory.json; the
// real-config guard (checked when the app closes) must stay clean.
//
//   node scripts/qa/ext/real-extensions.qa.mjs
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REAL_AGENT_DIR } from '../lib/agent-dir.mjs'
import { runSuite } from '../lib/suite.mjs'
import { reportShot, runPaletteAction, SHOTS_DIR, until } from './lib/ext-helpers.mjs'

const INVENTORY = join(SHOTS_DIR, '..', 'ext-real-inventory.json')
/** Extensions settle their statuses and widgets after session_start; give them this long. */
const EXTENSION_SETTLE_MS = 8000

/** Package or file an extension resource came from (`npm:pi-lens` → `pi-lens`). */
function owner(sourceInfo) {
  if (!sourceInfo) return 'unknown'
  if (sourceInfo.source && sourceInfo.source !== 'local')
    return sourceInfo.source.replace(/^npm:/, '')
  return sourceInfo.baseDir ?? sourceInfo.path ?? 'unknown'
}

await runSuite(
  'ext-real-extensions',
  async ({ app, step }) => {
    const { page } = app
    let agentId
    const inventory = { capturedAt: new Date().toISOString() }

    await step('open a temp workspace with the real config (no session file)', async () => {
      const settings = JSON.parse(await readFile(join(REAL_AGENT_DIR, 'settings.json'), 'utf8'))
      inventory.configuredPackages = (settings.packages ?? []).map((entry) =>
        typeof entry === 'string' ? entry : entry.source
      )
      inventory.configuredExtensions = settings.extensions ?? []
      ;({ agentId } = await app.openWorkspace())
      await page.waitForTimeout(EXTENSION_SETTLE_MS)
      await reportShot(app, 'ext-real-workspace')
    })

    await step('inventory: extension commands, tools, statuses, widgets and errors', async () => {
      const state = await app.agentState(agentId)
      const commands = await app.rpc({ type: 'get_commands' }, agentId)
      const { active, tools } = await app.invoke('engine:bridge', agentId, { op: 'tools-get' })
      const byOwner = {}
      const entry = (name) => (byOwner[name] ??= { commands: [], tools: [] })
      for (const command of commands.commands.filter((c) => c.source === 'extension')) {
        entry(owner(command.sourceInfo)).commands.push(command.name)
      }
      for (const tool of tools) {
        if (tool.sourceInfo?.source === 'builtin') continue
        entry(owner(tool.sourceInfo)).tools.push(
          `${tool.name} (${tool.exposure}${active.includes(tool.name) ? ', active' : ''})`
        )
      }
      Object.assign(inventory, {
        extensions: byOwner,
        builtinTools: tools.filter((t) => t.sourceInfo?.source === 'builtin').map((t) => t.name),
        statuses: state.ext.statuses,
        widgets: Object.fromEntries(
          Object.entries(state.ext.widgets).map(([key, w]) => [
            key,
            { placement: w.placement, lines: w.lines.length }
          ])
        ),
        machinePayloads: Object.keys(state.ext.machine),
        title: state.ext.title ?? null,
        notifications: state.ext.notifications.map(({ level, message }) => ({ level, message })),
        pendingDialogs: state.ext.dialogs.map((d) => d.request.method),
        extensionErrors: state.extensionErrors,
        appErrors: app.errors()
      })
      await writeFile(INVENTORY, `${JSON.stringify(inventory, null, 2)}\n`)
      console.log(`    extensions: ${Object.keys(byOwner).join(', ')}`)
      console.log(
        `    extension errors: ${state.extensionErrors.length}, notifications: ${state.ext.notifications.length}`
      )
      assert.ok(Object.keys(byOwner).length > 0, 'at least one real extension registered something')
    })

    await step('the slash menu lists extension commands', async () => {
      const composer = page.getByRole('textbox', { name: 'Message' })
      await composer.fill('/')
      await page.getByRole('listbox').first().waitFor()
      await reportShot(app, 'ext-real-slash-menu')
      await composer.fill('/vengeance-')
      await page.waitForTimeout(300)
      const bridgeRows = await page.getByRole('option', { name: /vengeance-/ }).count()
      assert.equal(bridgeRows, 0, 'the internal bridge commands stay out of the slash menu')
      await composer.fill('')
    })

    await step('inspector: Extensions and Tools tabs', async () => {
      await page.keyboard.press('Control+i')
      await page.locator('[data-tab="extensions"]').click()
      await page.waitForTimeout(500)
      await reportShot(app, 'ext-real-inspector-extensions')
      await page.locator('[data-tab="tools"]').click()
      await until(async () => (await page.getByText('Loading').count()) === 0, {
        label: 'tools loaded'
      })
      await reportShot(app, 'ext-real-inspector-tools')
      await page.keyboard.press('Control+i')
    })

    await step('Settings → Packages lists the configured packages (read-only)', async () => {
      await app.test('openSettings', 'packages')
      await page.locator('[id^="setting-package."]').first().waitFor({ timeout: 30_000 })
      await page.waitForTimeout(1000)
      inventory.packageRows = await page.locator('[id^="setting-package."]').evaluateAll((rows) =>
        rows.map((row) =>
          row.innerText
            .split(/\s*\n\s*/)
            .filter(Boolean)
            .join(' · ')
        )
      )
      await reportShot(app, 'ext-real-settings-packages')
      await app.test('closeSettings')
    })

    await step(
      'Launch options show the real extension flags (dialog closed without starting)',
      async () => {
        const launchDialog = page.getByRole('dialog', { name: 'New session with options' })
        await runPaletteAction(app, 'New session with options…')
        await launchDialog.waitFor()
        await launchDialog.locator('[data-section="flags"]').click()
        await page.waitForTimeout(5000)
        inventory.launchFlags = (await launchDialog.innerText()).split(/\n/).filter(Boolean)
        await writeFile(INVENTORY, JSON.stringify(inventory, null, 2))
        await reportShot(app, 'ext-real-launch-flags')
        await page.keyboard.press('Escape')
        await launchDialog.waitFor({ state: 'detached' })
      }
    )
  },
  { mode: 'real' }
)
