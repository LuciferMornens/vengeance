// Run against the unpacked QA executable printed by `node scripts/dist-qa.mjs --dir`.
// Linux without a display: xvfb-run -a -s '-screen 0 2560x1440x24' node <this script>.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyEngines } from '../../engines/verify.mjs'
import { shutdownOwnedPrimeDaemons } from '../lib/app.mjs'
import { hashFile, PACKAGED_PRODUCT_NAME, validatePackagedTarget } from '../lib/packaged-target.mjs'
import { resourcesDirOf } from '../lib/platform.mjs'
import { killTree, processIdentity, processTable, processWasPresent } from '../lib/processes.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT } from '../lib/tmp.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..', '..')
const QA_DIRECTORY = join(REPOSITORY_ROOT, 'scripts', 'qa')
const PLATFORM = `${process.platform}-${process.arch}`
const SUITE_TIMEOUT_MS = 15 * 60 * 1000
const CLEANUP_TIMEOUT_MS = 30_000
const MAXIMUM_TIMEOUT_MS = 2_147_483_647
const RECEIPT_NAME = 'packaged-target.json'
const SUITE_GROUPS = {
  core: [
    'engines/packaged.qa.mjs',
    'engines/integration.qa.mjs',
    'engines/model-isolation.qa.mjs',
    'settings/system-prompts.qa.mjs',
    'engines/restart-safety.qa.mjs',
    'engines/stop-compaction.qa.mjs',
    'engines/bash-queue.qa.mjs',
    'engines/session-recovery.qa.mjs',
    'engines/resident-close.qa.mjs'
  ],
  upgrade: ['engines/candidate-transition.qa.mjs', 'engines/resident-upgrade.qa.mjs']
}
const SUITE_GROUP = process.env.QA_PLATFORM_GROUP ?? 'core'
assert.ok(Object.hasOwn(SUITE_GROUPS, SUITE_GROUP), 'QA_PLATFORM_GROUP must be core or upgrade')
const SUITES = SUITE_GROUPS[SUITE_GROUP]

async function upgradeEnvironment(executable, manifest) {
  if (SUITE_GROUP !== 'upgrade') return {}
  const environmentPath = process.env.QA_RELEASE_BASELINE_ENV
  assert.ok(environmentPath && isAbsolute(environmentPath), 'Set absolute QA_RELEASE_BASELINE_ENV')
  const environment = JSON.parse(await readFile(environmentPath, 'utf8'))
  const keys = [
    'QA_PRIME_BASELINE_EXECUTABLE',
    'QA_PRIME_BASELINE_SHA256',
    'QA_PRIME_BASELINE_VISION_SWITCH',
    'QA_PRIME_EXECUTABLE',
    'QA_PRIME_SHA256'
  ]
  assert.deepEqual(Object.keys(environment).sort(), keys.sort(), 'Unexpected baseline environment')
  for (const key of keys) assert.equal(typeof environment[key], 'string')
  assert.equal(environment.QA_PRIME_BASELINE_VISION_SWITCH, 'working')
  const candidate = await realpath(
    join(resourcesDirOf(executable), 'engines', manifest.engines.prime.entry)
  )
  assert.equal(await realpath(environment.QA_PRIME_EXECUTABLE), candidate)
  assert.match(environment.QA_PRIME_SHA256, /^[a-f0-9]{64}$/)
  assert.equal(await hashFile(candidate), environment.QA_PRIME_SHA256)
  const baseline = await realpath(environment.QA_PRIME_BASELINE_EXECUTABLE)
  assertOutsideRealHome(baseline)
  assert.ok(isInside(await realpath(QA_TMP_ROOT), baseline), 'The baseline must be in QA_TMP_ROOT')
  assert.match(environment.QA_PRIME_BASELINE_SHA256, /^[a-f0-9]{64}$/)
  assert.equal(await hashFile(baseline), environment.QA_PRIME_BASELINE_SHA256)
  assert.notEqual(environment.QA_PRIME_BASELINE_SHA256, environment.QA_PRIME_SHA256)
  return environment
}

async function validateTemporaryRoot() {
  await mkdir(assertOutsideRealHome(QA_TMP_ROOT), { recursive: true })
  const temporaryRoot = await realpath(QA_TMP_ROOT)
  assertOutsideRealHome(temporaryRoot)
  assert.ok(!isInside(REPOSITORY_ROOT, temporaryRoot), 'QA_TMP_ROOT must be outside the repository')
  for (let ancestor = temporaryRoot; ; ancestor = dirname(ancestor)) {
    const gitEntry = await stat(join(ancestor, '.git')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    assert.equal(gitEntry, null, 'QA_TMP_ROOT must be outside every Git checkout')
    if (dirname(ancestor) === ancestor) break
  }
  return temporaryRoot
}

function suiteTimeout() {
  const configured = process.env.QA_PLATFORM_TIMEOUT_MS
  if (configured === undefined) return SUITE_TIMEOUT_MS
  assert.match(configured, /^\d+$/, 'QA_PLATFORM_TIMEOUT_MS must be an integer in milliseconds')
  const timeout = Number(configured)
  assert.ok(timeout > 0 && timeout <= MAXIMUM_TIMEOUT_MS, 'QA_PLATFORM_TIMEOUT_MS is out of range')
  return timeout
}

async function withDeadline(action, timeout, message) {
  let timer
  try {
    return await Promise.race([
      action(),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function cleanNativeDaemons(temporaryRoot, protectedProcesses) {
  for (const entry of await readdir(temporaryRoot, { recursive: true })) {
    if (!entry.endsWith('vengeance-daemons.json')) continue
    const agentDirectory = await realpath(dirname(join(temporaryRoot, entry)))
    assert.ok(isInside(temporaryRoot, agentDirectory), 'QA registry escaped its temporary root')
    await shutdownOwnedPrimeDaemons(agentDirectory, protectedProcesses)
  }
}

async function closeLog(stream) {
  if (stream.errored) throw stream.errored
  if (stream.writableFinished) return
  await new Promise((resolveClosed, rejectClose) => {
    stream.once('error', rejectClose)
    stream.end(resolveClosed)
  })
}

async function identifyChild(pid, processToken) {
  const [identity, table] = await Promise.all([processIdentity(pid), processTable()])
  const entry = table.find((process) => process.pid === pid)
  assert.ok(entry?.createdMs > 0, 'The QA child has no verifiable creation time')
  // macOS creation times are coarse; the unique command argument also distinguishes PID reuse.
  assert.ok(entry.commandLine.includes(processToken), 'The QA child process token changed')
  const executablePath = await realpath(identity.executablePath)
  const expectedExecutable = await realpath(process.execPath)
  const normalize = (path) => (process.platform === 'win32' ? path.toLowerCase() : path)
  assert.equal(normalize(executablePath), normalize(expectedExecutable))
  return {
    ...entry,
    executablePath: normalize(executablePath),
    createdMs: identity.createdMs ?? entry.createdMs
  }
}

async function runSuite(
  suite,
  index,
  outputDirectory,
  temporaryBase,
  executable,
  timeout,
  baselineEnvironment
) {
  const name = suite
    .replace(/\.qa\.mjs$/, '')
    .split('/')
    .join('-')
  const reportDirectory = join(outputDirectory, `${index + 1}-${name}`)
  await mkdir(reportDirectory)
  const temporaryRoot = await mkdtemp(join(temporaryBase, 'p-'))
  const receiptPath = join(reportDirectory, RECEIPT_NAME)
  const protectedProcesses = await withDeadline(
    processTable,
    CLEANUP_TIMEOUT_MS,
    'Could not identify the protected processes before QA startup'
  )
  const environment = {
    ...process.env,
    QA_PACKAGED_EXE: executable,
    QA_PACKAGED_NAME: PACKAGED_PRODUCT_NAME,
    QA_TMP_ROOT: temporaryRoot,
    QA_REPORT_DIR: reportDirectory,
    QA_PLATFORM_SUITE: suite,
    QA_PLATFORM_RECEIPT: receiptPath
  }
  // This run qualifies the shipped builds, independently of authoring-shell engine overrides.
  for (const name of [
    'QA_PRIME_EXECUTABLE',
    'QA_PRIME_SHA256',
    'PI_PACKAGE_DIR',
    'VENGEANCE_PRIME_EXECUTABLE',
    'VENGEANCE_BUNDLED_ENGINES',
    'VENGEANCE_MOCK',
    'ELECTRON_RUN_AS_NODE',
    'QA_RELEASE_BASELINE_TMP_ROOT'
  ]) {
    delete environment[name]
  }
  Object.assign(environment, baselineEnvironment)
  if (SUITE_GROUP === 'upgrade') environment.QA_RELEASE_BASELINE_TMP_ROOT = temporaryBase
  const stdout = createWriteStream(join(reportDirectory, 'stdout.log'))
  const stderr = createWriteStream(join(reportDirectory, 'stderr.log'))
  const result = { suite, reportDirectory, temporaryRoot, startedAt: new Date().toISOString() }
  for (const stream of [stdout, stderr]) {
    stream.on('error', (error) => {
      result.failure ??= error.stack ?? String(error)
    })
  }
  const processToken = `--vengeance-qa-process=${randomUUID()}`
  const child = spawn(process.execPath, [join(QA_DIRECTORY, ...suite.split('/')), processToken], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let timedOut = false
  let timer
  let termination
  let childExited = false
  child.once('exit', () => {
    childExited = true
  })
  const capturedIdentity = withDeadline(
    () => identifyChild(child.pid, processToken),
    CLEANUP_TIMEOUT_MS,
    'Could not identify the QA child at startup'
  ).then(
    (identity) => ({ identity }),
    (error) => ({ error })
  )
  const hasExited = () => childExited || child.exitCode !== null || child.signalCode !== null
  const stopChild = () => {
    if (!child.pid || hasExited()) return Promise.resolve()
    termination ??= withDeadline(
      async () => {
        const captured = await capturedIdentity
        if (hasExited()) return
        if (captured.error) throw captured.error
        const current = await identifyChild(child.pid, processToken)
        if (hasExited()) return
        assert.equal(current.executablePath, captured.identity.executablePath)
        assert.ok(processWasPresent(current, [captured.identity]), 'The QA child PID was reused')
        await killTree(child.pid)
      },
      CLEANUP_TIMEOUT_MS,
      'The timed-out QA process tree did not stop'
    )
    return termination
  }
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  try {
    const status = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit)
      child.once('close', (code, signal) => resolveExit({ code, signal }))
      timer = setTimeout(() => {
        timedOut = true
        void stopChild().then(
          () => rejectExit(new Error(`Suite exceeded ${timeout} ms`)),
          rejectExit
        )
      }, timeout)
    })
    Object.assign(result, status)
    const captured = await capturedIdentity
    if (captured.identity) result.childIdentity = captured.identity
    else throw captured.error
    if (termination) await termination
    assert.equal(timedOut, false, `Suite exceeded ${timeout} ms`)
    assert.equal(status.code, 0, `Suite failed (${status.signal ?? status.code})`)
    const target = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(target.suite, suite, 'The suite did not record its own packaged target')
    await validatePackagedTarget(target, executable)
    assert.ok(isInside(temporaryRoot, target.piAgentDirectory))
    assert.ok(isInside(temporaryRoot, target.primeAgentDirectory))
    result.target = target
  } catch (error) {
    result.failure = error.stack ?? String(error)
  } finally {
    clearTimeout(timer)
    if (!hasExited())
      await stopChild().catch((error) => {
        result.failure ??= error.stack ?? String(error)
      })
    await withDeadline(
      () => cleanNativeDaemons(temporaryRoot, protectedProcesses),
      CLEANUP_TIMEOUT_MS,
      'The isolated native daemons did not stop'
    ).catch((error) => {
      result.failure ??= error.stack ?? String(error)
    })
    child.stdout.unpipe(stdout)
    child.stderr.unpipe(stderr)
    await Promise.all([closeLog(stdout), closeLog(stderr)]).catch((error) => {
      result.failure ??= error.stack ?? String(error)
    })
    result.timedOut = timedOut
    result.finishedAt = new Date().toISOString()
    result.passed = !result.failure
    if (result.passed) {
      assert.ok(isInside(temporaryBase, temporaryRoot))
      await rm(temporaryRoot, { recursive: true, force: true })
    }
    await writeFile(join(reportDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  }
  return result
}

async function qualifyPlatform() {
  assert.equal(
    process.argv.length,
    2,
    'This runner accepts only --help; use QA_* environment variables'
  )
  const configuredExecutable = process.env.QA_PACKAGED_EXE
  assert.ok(
    configuredExecutable && isAbsolute(configuredExecutable),
    'Set an absolute QA_PACKAGED_EXE'
  )
  const executable = await realpath(configuredExecutable)
  assert.ok((await stat(executable)).isFile(), 'QA_PACKAGED_EXE must name a file')
  await access(executable, constants.X_OK)
  if (process.platform === 'linux') {
    assert.ok(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
      'Run under Xvfb or a desktop display'
    )
  }
  const timeout = suiteTimeout()
  const temporaryBase = await validateTemporaryRoot()
  const reportBase = resolve(
    process.env.QA_REPORT_DIR ?? join(REPOSITORY_ROOT, '.shots', 'qa', `platform-${PLATFORM}`)
  )
  await mkdir(reportBase, { recursive: true })
  const outputDirectory = await mkdtemp(join(reportBase, 'run-'))
  const reportPath = join(outputDirectory, 'qualification.json')
  const report = {
    platform: PLATFORM,
    suiteGroup: SUITE_GROUP,
    startedAt: new Date().toISOString(),
    executable,
    timeoutMs: timeout,
    selectedSuites: SUITES,
    results: [],
    limits: [
      ...(SUITE_GROUP === 'core'
        ? ['No baseline executable transition or mixed-version resident-upgrade qualification.']
        : ['Upgrade coverage is limited to the explicitly identified baseline and candidate.']),
      'No paid-provider inference or completed external OAuth sign-in.',
      'No installer, desktop window-manager, Dock or AppImage-mount lifecycle qualification.'
    ]
  }
  console.log(`▶ Packaged platform qualification: ${PLATFORM}`)
  console.log(`  Evidence: ${outputDirectory}`)
  try {
    report.executableSha256 = await hashFile(executable)
    report.manifest = await verifyEngines({
      directory: join(resourcesDirOf(executable), 'engines')
    })
    const baselineEnvironment = await upgradeEnvironment(executable, report.manifest)
    if (SUITE_GROUP === 'upgrade') report.baselineEnvironment = baselineEnvironment
    for (const [index, suite] of SUITES.entries()) {
      console.log(`\n▶ ${index + 1}/${SUITES.length}: ${suite}`)
      const result = await runSuite(
        suite,
        index,
        outputDirectory,
        temporaryBase,
        executable,
        timeout,
        baselineEnvironment
      )
      report.results.push(result)
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      assert.equal(result.passed, true, `${suite} failed; see ${result.reportDirectory}`)
    }
    assert.equal(await hashFile(executable), report.executableSha256, 'The QA executable changed')
    await verifyEngines({ directory: join(resourcesDirOf(executable), 'engines') })
    report.passed = true
  } catch (error) {
    report.passed = false
    report.failure = error.stack ?? String(error)
    process.exitCode = 1
    console.error(report.failure)
  } finally {
    report.finishedAt = new Date().toISOString()
    report.unrunSuites = SUITES.slice(report.results.length)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`${report.passed ? '✓' : '✗'} Packaged platform qualification: ${reportPath}`)
  }
  // A timed-out native cleanup must not keep the runner alive or admit another GUI suite.
  if (!report.passed) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv[2] === '--help' && process.argv.length === 3) {
    console.log(
      'QA_PACKAGED_EXE=<absolute QA executable> node scripts/qa/engines/platform-qualification.mjs'
    )
    console.log(
      'Optional: QA_TMP_ROOT, QA_REPORT_DIR, QA_PLATFORM_TIMEOUT_MS (per suite; default 900000).'
    )
    console.log(
      'QA_PLATFORM_GROUP=upgrade requires QA_RELEASE_BASELINE_ENV from release-baseline.mjs.'
    )
    console.log(`Suites: ${SUITES.join(', ')}`)
  } else {
    await qualifyPlatform()
  }
}
