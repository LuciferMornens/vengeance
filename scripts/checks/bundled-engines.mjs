import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import electron from 'electron'
import { bundleRoot, root } from '../engines/common.mjs'
import { verifyEngines } from '../engines/verify.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const executeFile = promisify(execFile)
const COMMAND_TIMEOUT_MS = 30_000
const manifest = await verifyEngines()
const fixture = await tempRoot('vengeance-native-distribution-')
try {
  const account = await fixture.folder('account', { 'settings.json': { packages: [] } })
  const workspace = await fixture.folder('workspace')
  const home = await fixture.folder('home')
  const sessions = await fixture.folder('sessions')
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(PI_|PRIME_AGENT_|VENGEANCE_)/.test(name)
    )
  )
  assert.ok(process.env.SystemRoot)
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    PATH: join(process.env.SystemRoot, 'System32'),
    Path: join(process.env.SystemRoot, 'System32'),
    PI_CODING_AGENT_DIR: account,
    PRIME_AGENT_CODING_AGENT_DIR: account,
    PRIME_AGENT_SESSION_DIR: sessions,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    ELECTRON_RUN_AS_NODE: '1'
  })
  const settings = await readFile(join(account, 'settings.json'), 'utf8')
  for (const identity of ['pi', 'prime']) {
    const engine = manifest.engines[identity]
    const entry = join(bundleRoot, engine.entry)
    const command = identity === 'pi' ? electron : entry
    const prefix = identity === 'pi' ? [entry] : []
    const options = {
      cwd: workspace,
      env: { ...environment, PI_PACKAGE_DIR: join(bundleRoot, engine.packageDir) },
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS
    }
    const result = await executeFile(command, [...prefix, '--version'], options)
    assert.ok(result.stdout.includes(engine.version))
    if (identity === 'pi') {
      const versionCheck = await executeFile(
        electron,
        [
          join(root, 'scripts', 'checks', 'fixtures', 'pi-distribution-version.mjs'),
          join(bundleRoot, engine.packageDir),
          engine.version,
          engine.tag.replace(/^v/, ''),
          workspace
        ],
        options
      )
      console.log(versionCheck.stdout.trim())
    }
    const argumentsList =
      identity === 'pi'
        ? [['update'], ['update', '--self'], ['update', '--all'], ['update', 'pi']]
        : [
            ['update'],
            ['update', '--check'],
            ['update', '--nightly', '--force'],
            ['package', 'update', '--self']
          ]
    for (const args of argumentsList) {
      await assert.rejects(executeFile(command, [...prefix, ...args], options), (error) => {
        assert.equal(error.killed, false, `${identity} ${args.join(' ')} must reject promptly`)
        assert.equal(error.code, 1)
        const refusal =
          args[0] === 'package'
            ? /Package updates accept only an optional source/
            : /Update Vengeance to update the Engine/
        assert.match(error.stderr + error.stdout, refusal)
        return true
      })
    }
    assert.equal(await readFile(join(account, 'settings.json'), 'utf8'), settings)
    console.log(
      `✓ ${identity} ${engine.version}: system PATH, native self-update refusal, config intact`
    )
  }
  console.log('✓ bundled native engine checks passed')
} finally {
  await fixture.cleanup()
}
