// Stage complete, checksum-pinned release packages without launching their production app.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { hostKey, inventory, sha256 } from '../../engines/common.mjs'
import { verifyEngines } from '../../engines/verify.mjs'
import { reportShotsDir } from '../lib/app.mjs'
import { hashFile } from '../lib/packaged-target.mjs'
import { resourcesDirOf } from '../lib/platform.mjs'
import { assertOutsideRealHome, isInside, qaTempDir } from '../lib/tmp.mjs'

const RELEASE_VERSION = '0.3.2'
const BASELINE_PRIME_VERSION = '0.10.0+vengeance.10'
const BASELINE_PI_VERSION = '1.3.0+vengeance.2'
const RELEASE_COMMIT = '8b2319880580893356d7cc7d2fbc721c08936bf9'
const RELEASE_URL =
  'https://github.com/LuciferMornens/vengeance/releases/download/' + `v${RELEASE_VERSION}`
const CHECKSUMS_SHA256 = '75ae76fa7bd831e97ad7a0f7d6f00a345a7d2587c1d89f5792425bc1f3f0811b'
const DOWNLOAD_TIMEOUT_MS = 180_000
const EXTRACTION_TIMEOUT_MS = 120_000
const MAXIMUM_DOWNLOAD_BYTES = 300 * 1024 * 1024
const MAXIMUM_COMMAND_OUTPUT = 1024 * 1024
const MAXIMUM_TOP_LEVEL_ENTRIES = 256
const executeFile = promisify(execFile)
const ASSETS = {
  'darwin-arm64': {
    name: 'Vengeance-0.3.2-mac-arm64.zip',
    sha256: '96270f4c74015edf2f21228d3983376cc7ebbf029620c821fde08e2568777b7a'
  },
  'darwin-x64': {
    name: 'Vengeance-0.3.2-mac-x64.zip',
    sha256: '0133acbf561d3c8aa858ce934784822365459a3462ff09a97fa55f8a8964739d'
  },
  'linux-x64': {
    name: 'Vengeance-0.3.2-linux-x64.tar.gz',
    sha256: '80f5343f3d63e37d11525a1c8ef420077f1fef95866999735751e2f48edeff6c'
  },
  'linux-arm64': {
    name: 'Vengeance-0.3.2-linux-arm64.tar.gz',
    sha256: '213f9b8679f775f0c4fe36880a7aa2c251028bb96e793042e5512e81c32be9d7'
  }
}

async function downloadAsset(name, target, expectedHash) {
  const response = await fetch(`${RELEASE_URL}/${name}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Release download failed: ${name} (${response.status})`)
  }
  let receivedBytes = 0
  async function* boundedDownload() {
    for await (const chunk of Readable.fromWeb(response.body)) {
      receivedBytes += chunk.length
      assert.ok(receivedBytes <= MAXIMUM_DOWNLOAD_BYTES, 'Release download is too large')
      yield chunk
    }
  }
  await pipeline(boundedDownload(), createWriteStream(target))
  assert.equal(await hashFile(target), expectedHash, `Release checksum mismatch: ${name}`)
  return { name, sha256: expectedHash, bytes: receivedBytes, path: target }
}

async function extractPackage(archive, destination) {
  const command = process.platform === 'darwin' ? 'ditto' : 'tar'
  const argumentsList =
    process.platform === 'darwin'
      ? ['-x', '-k', archive, destination]
      : ['-xzf', archive, '-C', destination]
  const result = await executeFile(command, argumentsList, {
    timeout: EXTRACTION_TIMEOUT_MS,
    maxBuffer: MAXIMUM_COMMAND_OUTPUT,
    windowsHide: true
  })
  return { command, arguments: argumentsList, stdout: result.stdout, stderr: result.stderr }
}

async function verifyBaseline(resources) {
  const directory = join(resources, 'engines')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.platform, hostKey)
  for (const [engine, version] of [
    ['pi', BASELINE_PI_VERSION],
    ['prime', BASELINE_PRIME_VERSION]
  ]) {
    const descriptor = manifest.engines[engine]
    assert.equal(descriptor.version, version)
    assert.equal(descriptor.packageDir.startsWith(engine), true)
    const packageDirectory = resolve(directory, descriptor.packageDir)
    assert.ok(isInside(join(directory, engine), packageDirectory))
    assert.equal(
      sha256(JSON.stringify(await inventory(join(directory, engine)))),
      descriptor.payloadHash
    )
  }
  const primeEntry = resolve(directory, manifest.engines.prime.entry)
  assert.ok(isInside(join(directory, 'prime'), primeEntry))
  await access(primeEntry, constants.X_OK)
  const metadata = JSON.parse(await readFile(join(directory, 'prime', 'package.json'), 'utf8'))
  assert.equal(metadata.version, BASELINE_PRIME_VERSION)
  return { resources, manifest, primeEntry, primeSha256: await hashFile(primeEntry) }
}

async function discoverPackage(extracted) {
  const entries = await readdir(extracted, { withFileTypes: true })
  assert.ok(entries.length <= MAXIMUM_TOP_LEVEL_ENTRIES, 'Unexpected release archive layout')
  const candidates = [
    extracted,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(extracted, entry.name))
  ]
  const matches = []
  for (const appRoot of candidates) {
    const resources =
      process.platform === 'darwin'
        ? join(appRoot, 'Contents', 'Resources')
        : join(appRoot, 'resources')
    const manifest = await stat(join(resources, 'engines', 'manifest.json')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (manifest?.isFile()) {
      const canonicalResources = await realpath(resources)
      assert.ok(isInside(extracted, canonicalResources), 'Release resources escaped their package')
      matches.push({ appRoot, resources: canonicalResources })
    }
  }
  assert.equal(matches.length, 1, 'Expected exactly one complete release app at the archive root')
  return matches[0]
}

async function baselineRoot() {
  const root = await realpath(await qaTempDir('b-'))
  assertOutsideRealHome(root)
  for (let ancestor = root; ; ancestor = dirname(ancestor)) {
    const gitEntry = await stat(join(ancestor, '.git')).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    assert.equal(gitEntry, null, 'QA_TMP_ROOT must be outside every Git checkout')
    if (dirname(ancestor) === ancestor) break
  }
  return root
}

async function stageBaseline() {
  assert.equal(
    process.argv.length,
    2,
    'Use QA_PACKAGED_EXE and QA_REPORT_DIR; no arguments are needed'
  )
  const asset = ASSETS[hostKey]
  assert.ok(asset, `Release baseline extraction is supported on macOS and Linux (${hostKey})`)
  const configuredExecutable = process.env.QA_PACKAGED_EXE
  assert.ok(
    configuredExecutable && isAbsolute(configuredExecutable),
    'Set an absolute QA_PACKAGED_EXE'
  )
  const candidateExecutable = await realpath(configuredExecutable)
  const outputDirectory = process.env.QA_REPORT_DIR
    ? resolve(process.env.QA_REPORT_DIR)
    : reportShotsDir('release-baseline')
  await mkdir(outputDirectory, { recursive: true })
  const reportPath = join(outputDirectory, 'release-baseline.json')
  const environmentPath = join(outputDirectory, 'release-baseline-env.json')
  const report = {
    platform: hostKey,
    release: RELEASE_VERSION,
    releaseCommit: RELEASE_COMMIT,
    startedAt: new Date().toISOString(),
    asset,
    downloadUrl: `${RELEASE_URL}/${asset.name}`,
    passed: false
  }
  console.log(`▶ Stage native upgrade baseline: Vengeance ${RELEASE_VERSION} (${hostKey})`)
  try {
    const root = await baselineRoot()
    report.temporaryRoot = root
    const checksums = join(root, 'SHA256SUMS')
    await downloadAsset('SHA256SUMS', checksums, CHECKSUMS_SHA256)
    const checksumLines = (await readFile(checksums, 'utf8')).trimEnd().split(/\r?\n/)
    assert.equal(
      checksumLines.filter((line) => line === `${asset.sha256}  ${asset.name}`).length,
      1
    )
    const archive = join(root, asset.name)
    report.archive = await downloadAsset(asset.name, archive, asset.sha256)
    const extracted = join(root, 'package')
    await mkdir(extracted)
    report.extraction = await extractPackage(archive, extracted)
    const { appRoot, resources } = await discoverPackage(extracted)
    report.appRoot = appRoot
    if (process.platform === 'darwin') {
      report.signature = await executeFile(
        'codesign',
        ['--verify', '--deep', '--strict', appRoot],
        {
          timeout: EXTRACTION_TIMEOUT_MS,
          maxBuffer: MAXIMUM_COMMAND_OUTPUT
        }
      )
    }
    report.baseline = await verifyBaseline(resources)
    const candidateResources = resourcesDirOf(candidateExecutable)
    const candidateManifest = await verifyEngines({
      directory: join(candidateResources, 'engines')
    })
    const candidatePrime = join(
      candidateResources,
      'engines',
      candidateManifest.engines.prime.entry
    )
    report.candidate = {
      executable: candidateExecutable,
      executableSha256: await hashFile(candidateExecutable),
      manifest: candidateManifest,
      primeEntry: candidatePrime,
      primeSha256: await hashFile(candidatePrime)
    }
    assert.notEqual(report.candidate.primeSha256, report.baseline.primeSha256)
    const environment = {
      QA_PRIME_BASELINE_EXECUTABLE: report.baseline.primeEntry,
      QA_PRIME_BASELINE_SHA256: report.baseline.primeSha256,
      QA_PRIME_BASELINE_VISION_SWITCH: 'working',
      QA_PRIME_EXECUTABLE: candidatePrime,
      QA_PRIME_SHA256: report.candidate.primeSha256
    }
    await writeFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`)
    report.environment = environment
    report.passed = true
  } catch (error) {
    report.failure = error.stack ?? String(error)
    report.extractStderr = error.stderr
    process.exitCode = 1
    console.error(report.failure)
  } finally {
    report.finishedAt = new Date().toISOString()
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Baseline report: ${reportPath}`)
    if (report.passed) console.log(`Baseline environment: ${environmentPath}`)
  }
}

if (process.argv[2] === '--help' && process.argv.length === 3) {
  console.log('QA_PACKAGED_EXE=<QA executable> node scripts/qa/engines/release-baseline.mjs')
  console.log('Writes release-baseline-env.json and release-baseline.json under QA_REPORT_DIR.')
  console.log(
    'Complete baseline packages stay under QA_TMP_ROOT for the upgrade suites and diagnosis.'
  )
} else {
  await stageBaseline()
}
