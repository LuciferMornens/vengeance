import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { engineLock, prepareSource } from '../engines/common.mjs'
import { killTree } from '../qa/lib/processes.mjs'
import { snapshotRealConfig } from '../qa/lib/real-guard.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const source = process.env.QA_PI_SOURCE
  ? resolve(process.env.QA_PI_SOURCE)
  : await prepareSource('pi', engineLock.pi)
const fixture = await tempRoot('vengeance-pi-workspace-')
const guards = await Promise.all(
  ['.pi', '.prime'].map((directory) => snapshotRealConfig(join(homedir(), directory, 'agent')))
)
let child
let timeout

try {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(PI_|PRIME_|VENGEANCE_)/.test(name)
    )
  )
  const home = await fixture.folder('home')
  const temporary = (await fixture.folder('temp')).replaceAll('\\', '/')
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    PI_CODING_AGENT_DIR: await fixture.folder('account'),
    PI_NO_LOCAL_LLM: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
    DO_NOT_TRACK: '1'
  })
  const [workspace, ...tests] = process.argv.slice(2)
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const command = workspace ? process.execPath : 'C:/Program Files/Git/bin/bash.exe'
  const args = !workspace
    ? ['--noprofile', '--norc', './test.sh']
    : workspace === 'check'
      ? [npmCli, 'run', 'check']
      : [join(source, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...tests]
  const cwd = !workspace || workspace === 'check' ? source : join(source, 'packages', workspace)
  console.log(`> ${workspace ? args.join(' ') : './test.sh'}`)
  child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: 'inherit' })
  let timedOut = false
  timeout = setTimeout(
    () => {
      timedOut = true
      void killTree(child.pid)
    },
    15 * 60 * 1000
  )
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  if (timedOut) throw new Error('Native Engine suite exceeded 15 minutes')
  if (code !== 0) throw new Error(`Native Engine suite failed (${code})`)
  console.log('✓ isolated native Engine checks passed')
} finally {
  clearTimeout(timeout)
  if (child?.pid) await killTree(child.pid)
  try {
    for (const guard of guards) await guard.verify()
    console.log('✓ both real account configurations remained unchanged')
  } finally {
    await fixture.cleanup()
  }
}
