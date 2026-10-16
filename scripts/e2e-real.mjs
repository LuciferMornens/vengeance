// Real-engine smoke test: launches the app against the installed engine in a temp workspace,
// types one tiny prompt into the composer, waits for agent_settled and asserts the reply.
// Uses an ephemeral session (--no-session) and a temp Electron profile; engine config is only read.
//
//   npm run e2e:real                                   BUILT app (out/, npm run build first)
//   npm run e2e:packaged                               release/win-unpacked/Vengeance.exe (npm run dist first)
//   node scripts/e2e-real.mjs --exe <path-to-exe>      any packaged executable
//
// With --exe it also checks what only a packaged build can get wrong: app version and name, the bridge
// extension loading from <resources>/bridge, and the single-instance lock (a second launch exits).
import { _electron as electron } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const exeFlag = process.argv.indexOf('--exe')
const exe = exeFlag >= 0 ? resolve(process.argv[exeFlag + 1] ?? '') : null
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (exe && !existsSync(exe)) {
  console.error(`Executable not found: ${exe} — run \`npm run dist\` first.`)
  process.exit(1)
}
if (!exe && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build output missing — run `npm run build` first.')
  process.exit(1)
}

const workspace = await mkdtemp(join(tmpdir(), 'vengeance-e2e-ws-'))
const userData = await mkdtemp(join(tmpdir(), 'vengeance-e2e-profile-'))
await writeFile(join(workspace, 'README.md'), '# e2e scratch workspace\n')

/** The composer's running glow fades over --dur-slow (420ms in tokens.css), plus a frame of slack. */
const COMPOSER_GLOW_FADE_MS = 500

const env = { ...process.env, VENGEANCE_TEST: '1', VENGEANCE_NO_MICA: '1', VENGEANCE_USER_DATA: userData }
delete env.VENGEANCE_MOCK

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
  console.log(`  ✓ ${message}`)
}

/** Launch the packaged exe twice on one profile (test mode off): the second instance must exit on its own. */
async function checkSingleInstance() {
  const profile = await mkdtemp(join(tmpdir(), 'vengeance-e2e-single-'))
  const plainEnv = { ...process.env, VENGEANCE_USER_DATA: profile, VENGEANCE_NO_MICA: '1' }
  delete plainEnv.VENGEANCE_TEST
  delete plainEnv.VENGEANCE_MOCK
  const first = spawn(exe, [], { env: plainEnv, stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 4000))
    assert(first.exitCode === null, 'first instance keeps running')
    const second = spawn(exe, [], { env: plainEnv, stdio: 'ignore' })
    const exitCode = await new Promise((r) => {
      const timer = setTimeout(() => r('timeout'), 15_000)
      second.on('exit', (c) => {
        clearTimeout(timer)
        r(c)
      })
    })
    if (exitCode === 'timeout') second.kill()
    assert(exitCode !== 'timeout', `second instance exits (code ${exitCode})`)
    assert(first.exitCode === null, 'first instance survives the second launch')
  } finally {
    if (first.pid) spawn('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 1500))
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
}

let app
let code = 1
try {
  app = exe
    ? await electron.launch({ executablePath: exe, args: [], env, timeout: 60_000 })
    : await electron.launch({ args: [root], env, timeout: 60_000 })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('[renderer]', error.message))
  await page.waitForFunction(() => !!window.__vengeanceTest, null, { timeout: 30_000 })
  const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.vengeance.invoke(c, ...a), [channel, args])

  const about = await app.evaluate(({ app: electronApp }) => ({
    version: electronApp.getVersion(),
    name: electronApp.getName(),
    packaged: electronApp.isPackaged,
    resources: process.resourcesPath
  }))
  console.log(`• app ${about.name} ${about.version} (packaged: ${about.packaged})`)
  assert(about.version === pkg.version, `app version is ${pkg.version}`)
  assert(about.name === pkg.productName, `app name is ${pkg.productName}`)
  if (exe) assert(about.packaged, 'running as a packaged app')

  const engine = await invoke('engine:info')
  console.log(`• engine ${engine.version} at ${engine.packageDir} (${engine.runtime}, sdk ${engine.sdkVersion ?? '—'})`)
  assert(engine.found, 'installed engine found')

  console.log(`• opening ${workspace}`)
  const started = Date.now()
  const agentId = await page.evaluate((cwd) => window.__vengeanceTest.openWorkspace(cwd, { noSession: true, thinking: 'low' }), workspace)
  console.log(`• engine ready in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  const info = (await invoke('engine:list')).find((a) => a.agentId === agentId)
  const stderr = await invoke('engine:stderr', agentId)
  if (exe) {
    assert(info.bridge === true, `bridge extension loaded from ${join(about.resources, 'bridge')}`)
    assert(!/Failed to load extension/.test(stderr), 'no extension load errors on stderr')
  } else {
    console.log(`• bridge loaded: ${info.bridge}`)
  }

  const composer = page.locator('textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 30_000 })
  await composer.fill('Reply with exactly: ok')
  await composer.press('Enter')

  await page.waitForFunction(() => window.__vengeanceTest.assistantText().length > 0 || false, null, { timeout: 180_000 })
  await page.evaluate(() => window.__vengeanceTest.waitForIdle(180_000))
  const text = await page.evaluate(() => window.__vengeanceTest.assistantText())
  console.log(`• reply: ${JSON.stringify(text.trim())}`)
  if (!/\bok\b/i.test(text)) throw new Error('Assistant reply did not contain "ok"')
  // The composer leaves its running state a beat after the agent settles, then fades its glow out.
  await page.locator('[data-composer]:not([data-running])').waitFor({ timeout: 30_000 })
  await page.waitForTimeout(COMPOSER_GLOW_FADE_MS)
  await page.screenshot({ path: join(root, '.shots', exe ? 'e2e-packaged.png' : 'e2e-real.png') }).catch(() => undefined)

  // pi-subagents through the bridge and the inspect command: no model turn, no tokens, no child spawned.
  const commands = await invoke('engine:command', agentId, { type: 'get_commands' })
  const hasSubagents = commands.success && commands.data.commands.some((command) => command.name === 'subagents-inspect-rpc')
  if (!hasSubagents || !info.bridge) {
    console.log('• subagents smoke skipped (pi-subagents or the bridge is not loaded; pi-subagents stays off under an inherited PI_SUBAGENT_CHILD=1)')
  } else {
    const ping = await invoke('engine:bridge', agentId, { op: 'subagents', method: 'ping' })
    assert(ping.success === true && ping.data?.capabilities?.nonRecoveringSteer === true, 'subagents ping answers with capabilities through the bridge')
    const probe = await invoke('engine:subagents-inspect', agentId, { asyncId: '00000000-0000-0000-0000-000000000000' })
    console.log(`• inspect probe: ${JSON.stringify(probe)}`)
    assert(probe.error?.code === 'not_found' && /^vi-/.test(probe.requestId), 'inspect of an unknown run comes back not_found with our request id')
  }

  // The session tree crosses the contextBridge flat; the Branches tab renders it.
  const tree = await invoke('engine:command', agentId, { type: 'get_tree' })
  assert(tree.success && Array.isArray(tree.data.nodes), 'get_tree reaches the renderer as a flat node list')
  const prompt = tree.data.nodes.find((node) => node.entry.type === 'message' && node.entry.message.role === 'user')
  const replies = tree.data.nodes.filter((node) => node.parentId === prompt?.entry.id && node.entry.message?.role === 'assistant')
  assert(replies.length === 1, 'the reply hangs off the prompt in the tree')
  await page.evaluate(() => window.__vengeanceTest.setPrefs({ inspector: { open: true, width: 360, tab: 'branches' } }))
  await page.getByText('Session tree').waitFor({ timeout: 30_000 })
  assert((await page.getByText('Could not load the session tree').count()) === 0, 'the Branches tab shows the session tree')
  await app.close()
  app = undefined

  if (exe) {
    console.log('• single instance')
    await checkSingleInstance()
  }
  console.log(exe ? '✓ e2e:packaged passed' : '✓ e2e:real passed')
  code = 0
} catch (error) {
  console.error(`✗ ${exe ? 'e2e:packaged' : 'e2e:real'} failed: ${error.stack ?? error}`)
} finally {
  await app?.close().catch(() => undefined)
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  await rm(userData, { recursive: true, force: true }).catch(() => undefined)
}
process.exit(code)
