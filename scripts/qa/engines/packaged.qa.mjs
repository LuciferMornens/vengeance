// Packaged native engines: both Engines stream from local fake providers and the Engine 2 helper
// loads with only the OS's own PATH. QA_PACKAGED_EXE is the unpacked app executable (macOS: the
// .app's Contents/MacOS/<name>); QA_PACKAGED_NAME its expected Electron app name.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { systemPath } from '../../engines/common.mjs'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir, ROOT } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { executableName } from '../lib/platform.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'
import { packagedLaunchOptions, recordPackagedTarget } from '../lib/packaged-target.mjs'

const executable = process.env.QA_PACKAGED_EXE
const expectedProductName = process.env.QA_PACKAGED_NAME ?? 'Vengeance QA'
const executeFile = promisify(execFile)
const HELPER_REVISION = '763094e1b6a7c17450ee8399b06cda1853847ca5'
const HELPER_NAME = executableName('vengeance-prime-auth')
const HELPER_PROTOCOL = 1
const HELPER_TIMEOUT_MS = 15_000
const PI_REPLY = 'Packaged Engine works.'
const PRIME_REPLY = 'Packaged Engine2 works.'

async function checkNativeSignInLoading(application, cwd) {
  await application.page.evaluate(
    ([workspace, timeoutMs]) =>
      new Promise((resolveSignIn, rejectSignIn) => {
        let loginId
        const invokeSettings = (channel, args) =>
          window.vengeance.invoke('engine:settings', { engine: 'prime', channel, args })
        const timer = setTimeout(() => {
          unsubscribe()
          if (loginId) void invokeSettings('settings:auth-cancel', [loginId])
          rejectSignIn(new Error('The packaged native helper did not request its API key'))
        }, timeoutMs)
        const unsubscribe = window.vengeance.on('settings:auth-event', (event) => {
          if (event.engine !== 'prime' || (loginId && event.loginId !== loginId)) return
          if (event.kind === 'prompt') {
            clearTimeout(timer)
            unsubscribe()
            void invokeSettings('settings:auth-cancel', [event.loginId]).then(
              resolveSignIn,
              rejectSignIn
            )
          } else if (event.kind === 'done' && !event.ok) {
            clearTimeout(timer)
            unsubscribe()
            rejectSignIn(new Error(event.error ?? 'The native helper exited before prompting'))
          }
        })
        void invokeSettings('settings:auth-login', [
          { providerId: 'prime-inference', method: 'api_key', cwd: workspace }
        ])
          .then((identifier) => {
            loginId = identifier
          })
          .catch((error) => {
            clearTimeout(timer)
            unsubscribe()
            rejectSignIn(error)
          })
      }),
    [cwd, HELPER_TIMEOUT_MS]
  )
}

async function checkEngine(application, server, engine, provider, model, reply) {
  server.queue(turn.text(reply))
  const { agentId, cwd } = await application.openWorkspace({
    args: { engine, provider, model, thinking: 'off', noSession: true }
  })
  const info = (await application.invoke('engine:list')).find((entry) => entry.agentId === agentId)
  assert.equal(info.engine, engine)
  assert.equal(info.status, 'ready', info.error)
  if (engine === 'pi') assert.equal(info.bridge, true, 'The packaged Engine bridge must load')

  await application.send('Reply with one short sentence.')
  await application.waitForSettle()
  const text = await application.test('assistantText')
  assert.ok(text.includes(reply), `${engine} did not display the local provider reply`)
  const tree = await application.rpc({ type: 'get_tree' }, agentId)
  assert.ok(tree.nodes.some((node) => node.entry.type === 'message'))
  await application.screenshot(`packaged-${engine}`)
  return cwd
}

async function runPackagedChecks() {
  const fixture = await createEngineFixture()
  const systemOnlyPath = systemPath()
  let application
  try {
    application = await launchApp({
      ...packagedLaunchOptions({ ...fixture.environment, ...systemOnlyPath }),
      agentDir: fixture.piDirectory.dir,
      outDir: reportShotsDir('packaged')
    })
    await recordPackagedTarget(application)
    const packageMetadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    const about = await application.app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      version: app.getVersion(),
      resources: process.resourcesPath
    }))
    assert.equal(about.packaged, true)
    assert.equal(about.name, expectedProductName)
    assert.equal(about.version, packageMetadata.version)

    for (const engine of ['pi', 'prime']) {
      const location = await application.invoke('engine:describe', engine)
      assert.equal(location.found, true, location.error)
      assert.equal(location.source, 'bundled')
      assert.match(location.version, /\+vengeance\./)
      if (engine === 'pi') assert.equal(location.runtime, 'electron')
      else
        assert.ok(
          location.cliPath.startsWith(application.userData),
          'Resident Engine 2 must run from its versioned app cache'
        )
    }

    const helper = join(about.resources, 'prime-auth', HELPER_NAME)
    const stagedHelper = join(ROOT, 'resources', 'prime-auth', 'bin', HELPER_NAME)
    const helperBytes = await readFile(helper)
    const stagedBytes = await readFile(stagedHelper)
    const helperHash = createHash('sha256').update(helperBytes).digest('hex')
    const stagedHash = createHash('sha256').update(stagedBytes).digest('hex')
    assert.equal(helperHash, stagedHash, 'The packaged helper must match the final staged binary')
    const result = await executeFile(helper, ['--version'], {
      windowsHide: true,
      timeout: HELPER_TIMEOUT_MS,
      env: { ...process.env, ...systemOnlyPath }
    })
    const metadata = JSON.parse(result.stdout)
    assert.equal(metadata.protocol, HELPER_PROTOCOL)
    assert.equal(metadata.revision, HELPER_REVISION)
    assert.ok(metadata.providers.includes('prime-inference'))
    assert.ok(metadata.providers.includes('prime-agent-traces'))
    for (const capability of [
      'mcp',
      'resources',
      'sessions',
      'traces',
      'restartConfig',
      'restartCapture'
    ]) {
      assert.equal(metadata[capability], true, `The packaged helper must provide ${capability}`)
    }
    const notices = await readFile(join(about.resources, 'prime-auth', 'THIRD-PARTY-NOTICES.txt'))
    assert.ok(notices.length > 0)
    const system = process.platform === 'win32' ? 'Windows' : 'OS'
    console.log(`  ✓ packaged native helper loads with only the ${system} system PATH`)
    console.log(`    SHA-256 ${helperHash}`)
    const license = await readFile(join(about.resources, 'LICENSE.md'), 'utf8')
    assert.match(
      license,
      /^# Vengeance License 1\.0\r?\n/,
      'The package must ship the Vengeance License'
    )
    console.log('  ✓ packaged app ships LICENSE.md')

    await checkEngine(
      application,
      fixture.piServer,
      'pi',
      FAKE_PROVIDER,
      FAKE_MODELS.reasoning,
      PI_REPLY
    )
    console.log('  ✓ packaged Engine streams and loads its external bridge')
    const cwd = await checkEngine(
      application,
      fixture.primeServer,
      'prime',
      PRIME_PROVIDER,
      PRIME_MODELS.reasoning,
      PRIME_REPLY
    )
    console.log('  ✓ packaged Engine2 streams through its native resident API')
    await checkNativeSignInLoading(application, cwd)
    console.log('  ✓ public Engine2 sign-in loads the packaged helper and cancels before a key')
    application.assertNoErrors()
  } finally {
    try {
      await application?.close({ beforeCleanup: fixture.stopNativeDaemon })
    } finally {
      await fixture.cleanup()
    }
  }
}

if (executable) {
  console.log('▶ packaged-engines (isolated native engines with local fake providers)')
  await runPackagedChecks()
  console.log('✓ packaged-engines passed')
} else {
  console.log('○ packaged-engines skipped; set QA_PACKAGED_EXE to an unpacked QA executable')
}
