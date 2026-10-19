import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { cargoPath, engineLock, prepareSource, root } from '../engines/common.mjs'
import { executableName } from '../qa/lib/platform.mjs'
import { killTree } from '../qa/lib/processes.mjs'
import { snapshotRealConfig } from '../qa/lib/real-guard.mjs'
import { tempRoot } from '../qa/lib/tmp.mjs'

const timeoutMs = Number(process.env.QA_NATIVE_TIMEOUT_MS ?? 15 * 60 * 1000)
const maximumTimerDelayMs = 2 ** 31 - 1
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maximumTimerDelayMs) {
  throw new Error('QA_NATIVE_TIMEOUT_MS must be an integer between 1 and 2147483647')
}
const buildJobs = Number(process.env.QA_NATIVE_JOBS ?? 4)
if (!Number.isSafeInteger(buildJobs) || buildJobs < 1 || buildJobs > 32) {
  throw new Error('QA_NATIVE_JOBS must be an integer between 1 and 32')
}
const source = process.env.QA_PRIME_SOURCE
  ? resolve(process.env.QA_PRIME_SOURCE)
  : await prepareSource('prime', engineLock.prime)
const fixture = await tempRoot('vengeance-native-workspace-')
const guardedAccounts = await Promise.all(
  ['.pi', '.prime'].map((directory) => snapshotRealConfig(join(homedir(), directory, 'agent')))
)
let activeChild

async function runCargo(args, environment, stdoutMode = 'inherit') {
  const executable = args[0] === '--test-binary' ? resolve(args[1]) : cargoPath()
  const argumentsToRun = args[0] === '--test-binary' ? args.slice(2) : args
  console.log(`> ${executable} ${argumentsToRun.join(' ')}`)
  const child = spawn(executable, argumentsToRun, {
    cwd: source,
    env: environment,
    windowsHide: true,
    stdio: ['inherit', stdoutMode, 'inherit']
  })
  activeChild = child
  let output = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    output += chunk
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    void killTree(child.pid)
  }, timeoutMs)
  try {
    const code = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', resolveExit)
    })
    if (timedOut) throw new Error(`Native command exceeded ${timeoutMs} ms`)
    if (code !== 0) throw new Error(`Native command failed (${code}): cargo ${args.join(' ')}`)
    return output
  } finally {
    clearTimeout(timeout)
    activeChild = undefined
  }
}

async function checkWorkspaceFormatting(environment) {
  const pendingManifests = [join(source, 'Cargo.toml')]
  const visitedManifests = new Set()
  const packages = new Map()
  while (pendingManifests.length) {
    const manifest = realpathSync(pendingManifests.pop())
    if (visitedManifests.has(manifest)) continue
    visitedManifests.add(manifest)
    const metadata = JSON.parse(
      await runCargo(
        [
          'metadata',
          '--format-version',
          '1',
          '--no-deps',
          '--offline',
          '--locked',
          '--manifest-path',
          manifest
        ],
        environment,
        'pipe'
      )
    )
    for (const nativePackage of metadata.packages) {
      const packageManifest = realpathSync(nativePackage.manifest_path)
      visitedManifests.add(packageManifest)
      packages.set(packageManifest, nativePackage)
      for (const dependency of nativePackage.dependencies) {
        if (dependency.path) pendingManifests.push(join(dependency.path, 'Cargo.toml'))
      }
    }
  }

  if (!packages.size) throw new Error('Native workspace metadata did not contain any packages')

  // cargo-fmt canonicalizes every target and exceeds Windows' command-line limit as one batch.
  // Its --all coverage includes each workspace package and recursively declared path dependency.
  for (const [manifest, nativePackage] of packages) {
    await runCargo(
      ['fmt', '--manifest-path', manifest, '--package', nativePackage.name, '--check'],
      environment
    )
  }
  const targetCount = [...packages.values()].reduce(
    (total, nativePackage) => total + nativePackage.targets.length,
    0
  )
  console.log(`✓ native formatting checked ${packages.size} packages and ${targetCount} targets`)
}

try {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(PI_|PRIME_|VENGEANCE_)/.test(name)
    )
  )
  const homeDirectory = await fixture.folder('home')
  const temporaryDirectory = await fixture.folder('temp')
  if (process.platform === 'win32') {
    const bashUtilities = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin')
    if (!existsSync(join(bashUtilities, 'sh.exe'))) {
      throw new Error('Native workspace tests require Git Bash utilities')
    }
    const pathVariable =
      Object.keys(environment).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
    environment[pathVariable] = `${bashUtilities}${delimiter}${environment[pathVariable] ?? ''}`
  }
  Object.assign(environment, {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    PRIME_AGENT_KERNEL_VENV: fixture.path('kernel-venv'),
    DO_NOT_TRACK: '1',
    VENGEANCE_ENGINE_BUILD: engineLock.prime.version
  })
  const buildArguments = [
    '--locked',
    '--target-dir',
    join(root, '.cache', 'prime-auth', 'target'),
    `-j${buildJobs}`
  ]
  const requested = process.argv.slice(2)
  const kernelFlag = requested.indexOf('--with-kernel')
  const withKernel = kernelFlag !== -1
  if (withKernel) requested.splice(kernelFlag, 1)
  if (['test', 'clippy', 'build'].includes(requested[0]) && !requested.includes('--target-dir')) {
    requested.splice(1, 0, ...buildArguments)
  }
  const formattingCheck = ['fmt', '--all', '--check']
  const commands = requested.length
    ? [requested]
    : [
        formattingCheck,
        ['test', ...buildArguments, '--workspace', '--no-fail-fast'],
        ['clippy', ...buildArguments, '--workspace', '--all-targets', '--', '-D', 'warnings']
      ]
  if (withKernel) {
    await runCargo(['build', ...buildArguments, '--workspace', '--bin', 'prime-agent'], environment)
    const nativeExecutable = join(
      root,
      '.cache',
      'prime-auth',
      'target',
      'debug',
      executableName('prime-agent')
    )
    await runCargo(['--test-binary', nativeExecutable, '--prime-agent-bootstrap'], {
      ...environment,
      PI_PACKAGE_DIR: source
    })
    const python = join(
      environment.PRIME_AGENT_KERNEL_VENV,
      ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])
    )
    if (!existsSync(python)) throw new Error('Native kernel bootstrap did not produce Python')
    environment.PA_E2E_KERNEL_PYTHON = python
    environment.PA_CORE_KERNEL_PYTHON = python
  }
  for (const command of commands) {
    if (
      process.platform === 'win32' &&
      command[0] === 'fmt' &&
      command.length === formattingCheck.length &&
      formattingCheck.every((argument) => command.includes(argument))
    ) {
      await checkWorkspaceFormatting(environment)
    } else {
      await runCargo(command, environment)
    }
  }
  console.log('✓ isolated native workspace checks passed')
} finally {
  if (activeChild?.pid) await killTree(activeChild.pid)
  try {
    for (const guard of guardedAccounts) await guard.verify()
    console.log('✓ both real account configurations remained unchanged')
  } finally {
    await fixture.cleanup()
  }
}
