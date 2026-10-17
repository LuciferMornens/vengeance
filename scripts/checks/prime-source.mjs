import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cargoPath, engineLock, hostPlatform, prepareSource, root } from '../engines/common.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const source = await prepareSource('prime', engineLock.prime)
const fixture = await tempRoot('vengeance-native-regressions-')
try {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(PI_|PRIME_AGENT_|VENGEANCE_)/.test(name)
    )
  )
  Object.assign(environment, {
    HOME: await fixture.folder('home'),
    USERPROFILE: fixture.path('home'),
    TEMP: await fixture.folder('temp'),
    TMP: fixture.path('temp'),
    TMPDIR: fixture.path('temp'),
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    PRIME_AGENT_CODING_AGENT_DIR: await fixture.folder('account'),
    PRIME_AGENT_SESSION_DIR: await fixture.folder('sessions'),
    PRIME_AGENT_KERNEL_VENV: fixture.path('kernel'),
    DO_NOT_TRACK: '1',
    VENGEANCE_ENGINE_BUILD: engineLock.prime.version
  })
  const buildArguments = [
    '--locked',
    '--target',
    hostPlatform().rustTarget,
    '--target-dir',
    join(root, '.cache/prime-auth/target'),
    '-j4'
  ]
  const commands = [
    ['fmt', '--all', '--check'],
    [
      'test',
      ...buildArguments,
      '--release',
      '-p',
      'pa-daemon',
      '--lib',
      'user_bash::',
      '--',
      '--test-threads=1'
    ],
    [
      'test',
      ...buildArguments,
      '--release',
      '-p',
      'pa-daemon',
      '--lib',
      'replacement_gate_tests',
      '--',
      '--test-threads=1'
    ],
    ['test', ...buildArguments, '--release', '-p', 'pa-core', '--test', 'compaction_http_abort'],
    [
      'clippy',
      ...buildArguments,
      '-p',
      'pa-cli',
      '-p',
      'pa-daemon',
      '--all-targets',
      '--',
      '-D',
      'warnings'
    ]
  ]
  for (const args of commands) {
    console.log(`> cargo ${args.join(' ')}`)
    const result = spawnSync(cargoPath(), args, {
      cwd: source,
      env: environment,
      windowsHide: true,
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Native check failed: cargo ${args.join(' ')}`)
  }
  console.log('✓ native Prime source regressions and clippy passed')
} finally {
  await fixture.cleanup()
}
