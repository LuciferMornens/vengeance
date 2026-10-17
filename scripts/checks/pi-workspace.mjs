import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { cargoPath, engineLock, prepareSource } from '../engines/common.mjs'
import { killTree } from '../qa/lib/processes.mjs'
import { snapshotRealConfig } from '../qa/lib/real-guard.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const timeoutMs = Number(process.env.QA_NATIVE_TIMEOUT_MS ?? 15 * 60 * 1000)
const maximumTimerDelayMs = 2 ** 31 - 1
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimerDelayMs) {
  throw new Error('QA_NATIVE_TIMEOUT_MS must be an integer between 1 and 2147483647')
}
const buildJobs = Number(process.env.QA_NATIVE_JOBS ?? 4)
if (!Number.isInteger(buildJobs) || buildJobs < 1 || buildJobs > 32) {
  throw new Error('QA_NATIVE_JOBS must be an integer between 1 and 32')
}

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
  // Windows runs test.sh in Git Bash with its POSIX tools first on PATH; elsewhere the system bash.
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
  if (process.platform === 'win32') {
    const pathName =
      Object.keys(environment).find((name) => name.toLowerCase() === 'path') ?? 'PATH'
    environment[pathName] = [join(dirname(dirname(bash)), 'usr', 'bin'), environment[pathName]]
      .filter(Boolean)
      .join(delimiter)
  }
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
  // The npm that ships with this Node: beside node.exe on Windows, under <prefix>/lib elsewhere.
  const npmCli =
    process.platform === 'win32'
      ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(dirname(dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const command = workspace ? process.execPath : bash
  const args = !workspace
    ? ['--noprofile', '--norc', './test.sh']
    : workspace === 'check'
      ? [npmCli, 'run', 'check']
      : [join(source, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...tests]
  const cwd = !workspace || workspace === 'check' ? source : join(source, 'packages', workspace)
  const commands = []
  if (!workspace || workspace === 'env') {
    const daemon = join(source, 'packages', 'env', 'daemon')
    commands.push({
      command: cargoPath(),
      args: [
        'build',
        '--locked',
        '--jobs',
        String(buildJobs),
        '--manifest-path',
        join(daemon, 'Cargo.toml'),
        '--target-dir',
        join(daemon, 'target')
      ],
      cwd: source
    })
  }
  commands.push({ command, args, cwd })

  let timedOut = false
  timeout = setTimeout(() => {
    timedOut = true
    if (child?.pid) void killTree(child.pid)
  }, timeoutMs)
  for (const step of commands) {
    console.log(`> ${[step.command, ...step.args].join(' ')}`)
    child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: environment,
      windowsHide: true,
      stdio: 'inherit'
    })
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', resolveExit)
    })
    if (timedOut) throw new Error(`Native Engine suite exceeded ${timeoutMs} ms`)
    if (code !== 0) throw new Error(`Native Engine suite failed (${code})`)
  }
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
