import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT } from './tmp.mjs'

const executeFile = promisify(execFile)
const MAXIMUM_WORKER_LOGS = 64
const WORKER_TAIL_BYTES = 64 * 1024
const MAXIMUM_DIRECTORY_ENTRIES = 512
const MAXIMUM_PACKAGES = 128
const MAXIMUM_SITE_DIRECTORIES = 4
const MAXIMUM_DIAGNOSTIC_ERRORS = 32
const METADATA_HEADER_BYTES = 4096
const COMMAND_TIMEOUT_MS = 3000
const WORKER_LOG_NAME = /^worker-[a-f0-9]{12}\.stderr\.log$/i

function pathKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function diagnosticError(area, error) {
  return { area, code: typeof error.code === 'string' ? error.code : error.name }
}

function recordError(report, area, error) {
  if (report.errors.length < MAXIMUM_DIAGNOSTIC_ERRORS) {
    report.errors.push(diagnosticError(area, error))
  }
}

async function assertPhysicalDirectory(directory) {
  const information = await lstat(directory)
  assert.ok(information.isDirectory() && !information.isSymbolicLink(), 'Expected a real directory')
  assert.equal(
    pathKey(await realpath(directory)),
    pathKey(directory),
    'Symlinked directory refused'
  )
}

async function assertOwnedDirectory(fixtureDirectory, directory) {
  assert.ok(isInside(fixtureDirectory, directory), 'Native diagnostics escaped the fixture')
  await assertPhysicalDirectory(fixtureDirectory)
  let current = fixtureDirectory
  for (const component of relative(fixtureDirectory, directory).split(sep).filter(Boolean)) {
    current = join(current, component)
    await assertPhysicalDirectory(current)
  }
}

async function boundedEntries(directory) {
  const entries = []
  for await (const entry of await opendir(directory)) {
    if (entries.length === MAXIMUM_DIRECTORY_ENTRIES) return { entries, truncated: true }
    entries.push(entry)
  }
  return { entries, truncated: false }
}

async function readOwnedBytes(fixtureDirectory, path, maximumBytes, tail = false) {
  await assertOwnedDirectory(fixtureDirectory, dirname(path))
  const before = await lstat(path)
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Non-regular diagnostic file refused')
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(path, flags)
  try {
    const information = await handle.stat()
    assert.ok(information.isFile(), 'Non-regular diagnostic file refused')
    assert.equal(information.dev, before.dev, 'Diagnostic file changed while opening')
    assert.equal(information.ino, before.ino, 'Diagnostic file changed while opening')
    assert.equal(pathKey(await realpath(path)), pathKey(path), 'Symlinked file refused')
    const bytes = Buffer.alloc(Math.min(information.size, maximumBytes))
    const offset = tail ? Math.max(0, information.size - bytes.length) : 0
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset)
    return {
      bytes: bytes.subarray(0, bytesRead),
      sourceBytes: information.size,
      truncated: information.size > bytesRead
    }
  } finally {
    await handle.close()
  }
}

async function captureWorkerLogs(fixtureDirectory, destination, report) {
  const directory = join(fixtureDirectory, 'prime-agent', 'logs')
  await assertOwnedDirectory(fixtureDirectory, directory)
  const listing = await boundedEntries(directory)
  const candidates = listing.entries.filter((entry) => WORKER_LOG_NAME.test(entry.name))
  report.workerLogsTruncated = listing.truncated || candidates.length > MAXIMUM_WORKER_LOGS
  const selected = candidates
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAXIMUM_WORKER_LOGS)
  for (const entry of selected) {
    try {
      const captured = await readOwnedBytes(
        fixtureDirectory,
        join(directory, entry.name),
        WORKER_TAIL_BYTES,
        true
      )
      await writeFile(join(destination, entry.name), captured.bytes, { flag: 'wx' })
      report.workerLogs.push({
        name: entry.name,
        sourceBytes: captured.sourceBytes,
        capturedBytes: captured.bytes.length,
        truncated: captured.truncated
      })
    } catch (error) {
      recordError(report, entry.name, error)
    }
  }
}

async function captureInstalledPackages(fixtureDirectory, report) {
  const kernelDirectory = join(fixtureDirectory, 'kernel-venv')
  const configuration = await readOwnedBytes(
    fixtureDirectory,
    join(kernelDirectory, 'pyvenv.cfg'),
    METADATA_HEADER_BYTES
  )
  report.python = Object.fromEntries(
    [
      ...configuration.bytes
        .toString('utf8')
        .matchAll(/^(implementation|version|version_info)\s*=\s*([\w.+-]+)\s*$/gm)
    ].map((match) => [match[1], match[2]])
  )
  let siteDirectories
  if (process.platform === 'win32') {
    siteDirectories = [join(kernelDirectory, 'Lib', 'site-packages')]
  } else {
    const libraryDirectory = join(kernelDirectory, 'lib')
    await assertOwnedDirectory(fixtureDirectory, libraryDirectory)
    const listing = await boundedEntries(libraryDirectory)
    siteDirectories = listing.entries
      .filter((entry) => /^python3\.\d+$/.test(entry.name))
      .slice(0, MAXIMUM_SITE_DIRECTORIES)
      .map((entry) => join(libraryDirectory, entry.name, 'site-packages'))
  }
  for (const directory of siteDirectories) {
    await assertOwnedDirectory(fixtureDirectory, directory)
    const listing = await boundedEntries(directory)
    report.packagesTruncated ||= listing.truncated
    for (const entry of listing.entries) {
      if (!/^[\w.+-]+\.dist-info$/.test(entry.name)) continue
      if (report.packages.length === MAXIMUM_PACKAGES) {
        report.packagesTruncated = true
        break
      }
      try {
        const metadata = await readOwnedBytes(
          fixtureDirectory,
          join(directory, entry.name, 'METADATA'),
          METADATA_HEADER_BYTES
        )
        const text = metadata.bytes.toString('utf8')
        const name = /^Name: ([\w.-]+)\r?$/m.exec(text)?.[1]
        const version = /^Version: ([\w.+!-]+)\r?$/m.exec(text)?.[1]
        if (name && version) report.packages.push({ name, version })
      } catch (error) {
        recordError(report, 'package-metadata', error)
      }
    }
  }
}

async function uvVersion() {
  try {
    const { stdout } = await executeFile(
      process.platform === 'win32' ? 'uv.exe' : 'uv',
      ['--version'],
      {
        timeout: COMMAND_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: METADATA_HEADER_BYTES,
        windowsHide: true,
        env: { ...process.env, UV_OFFLINE: '1', UV_NO_CONFIG: '1' }
      }
    )
    return { version: /^uv ([\w.+-]+)/.exec(stdout.trim())?.[1] ?? 'unrecognized' }
  } catch (error) {
    return diagnosticError('uv-version', error)
  }
}

export async function captureFailedNativeDiagnostics({ fixtureDirectory, outputDirectory }) {
  assert.ok(isAbsolute(fixtureDirectory) && isAbsolute(outputDirectory), 'Absolute paths required')
  assert.match(basename(fixtureDirectory), /^vengeance-qa-engines-[a-z0-9]{6}$/i)
  assert.ok(isInside(QA_TMP_ROOT, fixtureDirectory), 'Native diagnostics require a QA fixture')
  assertOutsideRealHome(fixtureDirectory)
  await assertPhysicalDirectory(QA_TMP_ROOT)
  await assertPhysicalDirectory(fixtureDirectory)
  await mkdir(outputDirectory, { recursive: true })
  await assertPhysicalDirectory(outputDirectory)
  const destination = join(outputDirectory, 'native-diagnostics')
  await mkdir(destination)
  await assertPhysicalDirectory(destination)
  const report = {
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    limits: { workerLogs: MAXIMUM_WORKER_LOGS, workerTailBytes: WORKER_TAIL_BYTES },
    workerLogs: [],
    packages: [],
    packagesTruncated: false,
    errors: []
  }
  try {
    await captureWorkerLogs(fixtureDirectory, destination, report)
  } catch (error) {
    recordError(report, 'worker-logs', error)
  }
  try {
    await captureInstalledPackages(fixtureDirectory, report)
  } catch (error) {
    recordError(report, 'python-metadata', error)
  }
  report.uv = await uvVersion()
  await writeFile(join(destination, 'runtime.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx'
  })
  return report
}
