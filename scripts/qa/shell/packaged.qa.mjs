// Packaged app identity, native engine and bridge loading, local transport and version UI.
// QA_PACKAGED_EXE selects an unpacked build (macOS: the .app's Contents/MacOS/<name>; default: this
// platform's release/ build); QA_PACKAGED_NAME sets its expected Electron app name (default:
// "Vengeance QA" for the dist:qa executables, "Vengeance" for any other).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { inspectRequest, turn } from '../lib/fake-llm.mjs'
import { reportShotsDir, ROOT } from '../lib/app.mjs'
import { resourcesDirOf } from '../lib/platform.mjs'
import { runSuite } from '../lib/suite.mjs'
import { PACKAGED_EXE as DEFAULT_PACKAGED_EXE, processTable, shot, softSteps } from './lib/kit.mjs'

const PACKAGED_EXE = resolve(process.env.QA_PACKAGED_EXE || DEFAULT_PACKAGED_EXE)
/** scripts/dist-qa.mjs executables: VengeanceQA(.exe) on Windows and macOS, vengeance-qa on Linux. */
const QA_BUILD_EXECUTABLE = /^(VengeanceQA(\.exe)?|vengeance-qa)$/i
const EXPECTED_PRODUCT_NAME =
  process.env.QA_PACKAGED_NAME ??
  (QA_BUILD_EXECUTABLE.test(basename(PACKAGED_EXE)) ? 'Vengeance QA' : 'Vengeance')
const EXPECTED_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const resourcesDir = resourcesDirOf(PACKAGED_EXE)
const engineManifest = JSON.parse(
  readFileSync(join(resourcesDir, 'engines', 'manifest.json'), 'utf8')
)
const engineVersion = engineManifest.engines.pi.version
const sdkVersion = engineManifest.engines.pi.tag.replace(/^v/, '')

if (!existsSync(PACKAGED_EXE)) {
  console.error(`✗ ${PACKAGED_EXE} missing: run \`npm run dist\` first`)
  process.exit(1)
}

await runSuite(
  'shell-packaged',
  async ({ server, app, step: hardStep }) => {
    const { check: step, finish } = softSteps(hardStep)
    await step(
      `packaged build: isPackaged, app version ${EXPECTED_VERSION} in main and in the preload`,
      async () => {
        const main = await app.app.evaluate(({ app: electronApp }) => ({
          version: electronApp.getVersion(),
          packaged: electronApp.isPackaged,
          name: electronApp.getName(),
          resourcesPath: process.resourcesPath
        }))
        assert.equal(main.packaged, true)
        assert.equal(main.version, EXPECTED_VERSION)
        assert.equal(main.name, EXPECTED_PRODUCT_NAME)
        assert.equal(main.resourcesPath.toLowerCase(), resourcesDir.toLowerCase())
        const platform = await app.page.evaluate(() => window.vengeance.platform)
        assert.equal(platform.appVersion, EXPECTED_VERSION)
        assert.equal(platform.test, true)
        assert.equal(platform.mock, false)
      }
    )

    await step('packaged layout: bridge outside app.asar, no dev menu, no devtools', async () => {
      assert.ok(existsSync(join(resourcesDir, 'bridge', 'vengeance-bridge.ts')))
      assert.ok(existsSync(join(resourcesDir, 'app.asar')))
      const chrome = await app.app.evaluate(({ BrowserWindow, Menu }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const roles = []
        const collectRoles = (menu) => {
          for (const item of menu?.items ?? []) {
            if (item.role) roles.push(item.role.toLowerCase())
            collectRoles(item.submenu)
          }
        }
        collectRoles(Menu.getApplicationMenu())
        return {
          menu: Menu.getApplicationMenu() !== null,
          devMenuItems: roles.filter((role) =>
            ['reload', 'forcereload', 'toggledevtools'].includes(role)
          ),
          devTools: win.webContents.isDevToolsOpened(),
          canOpenDevTools: (() => {
            win.webContents.openDevTools()
            const opened = win.webContents.isDevToolsOpened()
            win.webContents.closeDevTools()
            return opened
          })()
        }
      })
      // macOS keeps an application menu for its App, Edit and Window roles (quit, copy, paste);
      // no platform has a reload or devtools item.
      assert.deepEqual(chrome, {
        menu: process.platform === 'darwin',
        devMenuItems: [],
        devTools: false,
        canOpenDevTools: false
      })
    })

    await step(
      'engine locate from the packaged app: bundled distribution and upstream SDK',
      async () => {
        const info = await app.invoke('engine:info')
        assert.equal(info.found, true)
        assert.equal(info.source, 'bundled')
        assert.equal(info.runtime, 'electron')
        assert.equal(info.version, engineVersion)
        assert.match(info.packageDir.split('\\').join('/'), /pi-coding-agent$/)
        assert.equal(info.sdkVersion, sdkVersion, 'config SDK loads from the packaged app')
      }
    )

    let agentId
    await step('session starts with the bridge loaded from <resources>/bridge', async () => {
      ;({ agentId } = await app.openWorkspace({
        args: { model: `${FAKE_PROVIDER}/${FAKE_MODELS.reasoning}`, thinking: 'off' }
      }))
      const [engine] = await app.invoke('engine:list')
      assert.equal(engine.bridge, true, 'bridge commands registered')
      const table = await processTable()
      const proc = table.find((p) => p.pid === engine.pid)
      assert.ok(proc, `engine pid ${engine.pid} running`)
      const bridgeArg = join(resourcesDir, 'bridge', 'vengeance-bridge.ts')
      assert.ok(
        proc.commandLine.toLowerCase().includes(bridgeArg.toLowerCase()),
        `engine command line loads ${bridgeArg}: ${proc.commandLine}`
      )
      const { commands } = await app.rpc({ type: 'get_commands' })
      const bridge = commands.filter((c) => c.name.startsWith('vengeance-'))
      assert.deepEqual(bridge.map((command) => command.name).sort(), [
        'vengeance-label',
        'vengeance-reload',
        'vengeance-speed',
        'vengeance-subagents',
        'vengeance-system-prompt',
        'vengeance-tools',
        'vengeance-tree'
      ])
      for (const command of bridge) {
        assert.equal(
          command.sourceInfo.path.toLowerCase(),
          bridgeArg.toLowerCase(),
          `${command.name} from the packaged bridge`
        )
      }
    })

    await step('bridge round trip works in the packaged app (tools-get)', async () => {
      const tools = await app.invoke('engine:bridge', agentId, { op: 'tools-get' })
      assert.ok(
        Array.isArray(tools.active ?? tools.tools ?? tools),
        JSON.stringify(tools).slice(0, 200)
      )
    })

    await step(
      'a real turn through the packaged app reaches the fake LLM and renders',
      async () => {
        const from = server.requests.length
        server.queue(turn.text('Packaged build says hi.'))
        await app.send('hello from packaged')
        await app.waitForSettle()
        const sent = inspectRequest(await server.waitForRequest(undefined, { from }))
        assert.equal(sent.lastUserText, 'hello from packaged')
        await app.page.getByText('Packaged build says hi.').waitFor()
        await shot(app.page, 'packaged-1-session')
      }
    )

    await step(
      `version display: Updates sheet shows "Vengeance ${EXPECTED_VERSION}" and the engine version`,
      async () => {
        await app.page.keyboard.press('ControlOrMeta+k')
        await app.page.getByRole('combobox').fill('Check for updates')
        await app.page.keyboard.press('Enter')
        await app.page.getByRole('heading', { name: 'Updates', exact: true }).last().waitFor()
        await app.page.getByText(`Vengeance ${EXPECTED_VERSION}`).first().waitFor()
        await shot(app.page, 'packaged-2-updates-version')
        await app.page.keyboard.press('Escape')
      }
    )

    await step(
      'version display: Settings → Engine shows the engine version and the config SDK',
      async () => {
        await app.test('openSettings', 'engine')
        await app.page.getByText(`Engine ${engineVersion}`).first().waitFor()
        await shot(app.page, 'packaged-3-settings-engine')
        await app.test('closeSettings')
      }
    )

    await step('About (palette and titlebar mark) shows the app and Engine versions', async () => {
      await app.page.keyboard.press('ControlOrMeta+k')
      await app.page.getByRole('combobox').fill('About')
      await app.page.getByRole('option', { name: /About Vengeance/ }).waitFor()
      await app.page.keyboard.press('Enter')
      const about = app.page.getByRole('dialog', { name: 'Vengeance' })
      await about.getByText(`Version ${EXPECTED_VERSION}`).waitFor()
      await about.getByText(engineVersion, { exact: true }).waitFor()
      await shot(app.page, 'packaged-4-about')
      await app.page.keyboard.press('Escape')
      await about.waitFor({ state: 'detached' })
      await app.page.getByRole('button', { name: 'About Vengeance' }).click()
      await about.getByText(`Version ${EXPECTED_VERSION}`).waitFor()
      await app.page.keyboard.press('Escape')
    })
    finish()
  },
  { launch: { exe: PACKAGED_EXE, outDir: reportShotsDir('shell') } }
)
