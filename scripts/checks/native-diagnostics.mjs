import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureFailedNativeDiagnostics } from '../qa/lib/native-diagnostics.mjs'
import { QA_TMP_ROOT, qaTempDir, REAL_HOME } from '../qa/lib/tmp.mjs'

const WORKER_COUNT = 65
const EXPECTED_LOG_LIMIT = 64
const EXPECTED_TAIL_BYTES = 64 * 1024
const LARGE_LOG_BYTES = EXPECTED_TAIL_BYTES * 2
const BOOTSTRAP_ERROR = 'error: Failed to download scipy: TLS fixture failure\n'
const fixture = await qaTempDir('vengeance-qa-engines-')
const linkedFixture = await qaTempDir('vengeance-qa-engines-')
const inheritedPath = process.env.PATH
try {
  const logs = join(fixture, 'prime-agent', 'logs')
  await mkdir(logs, { recursive: true })
  for (let index = 0; index < WORKER_COUNT; index++) {
    const workerId = index.toString(16).padStart(12, '0')
    await writeFile(
      join(logs, `worker-${workerId}.stderr.log`),
      index === 0 ? `${'x'.repeat(LARGE_LOG_BYTES)}${BOOTSTRAP_ERROR}` : 'worker stderr\n'
    )
  }
  await writeFile(join(logs, 'auth.json'), 'unrelated account data must not be copied')
  const sitePackages =
    process.platform === 'win32'
      ? join(fixture, 'kernel-venv', 'Lib', 'site-packages')
      : join(fixture, 'kernel-venv', 'lib', 'python3.11', 'site-packages')
  const packageDirectory = join(sitePackages, 'scipy-1.16.3.dist-info')
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(
    join(packageDirectory, 'METADATA'),
    'Metadata-Version: 2.4\nName: scipy\nVersion: 1.16.3\nPrivate: must not be copied\n'
  )
  await writeFile(
    join(fixture, 'kernel-venv', 'pyvenv.cfg'),
    'implementation = CPython\nversion_info = 3.11.14\nhome = private-interpreter-location\n'
  )
  process.env.PATH = ''
  const outputDirectory = join(fixture, 'report')
  const report = await captureFailedNativeDiagnostics({
    fixtureDirectory: fixture,
    outputDirectory
  })
  assert.equal(report.workerLogs.length, EXPECTED_LOG_LIMIT)
  assert.equal(report.workerLogsTruncated, true)
  assert.equal(report.workerLogs[0].capturedBytes, EXPECTED_TAIL_BYTES)
  assert.equal(report.workerLogs[0].truncated, true)
  assert.deepEqual(report.python, { implementation: 'CPython', version_info: '3.11.14' })
  assert.deepEqual(report.packages, [{ name: 'scipy', version: '1.16.3' }])
  assert.ok(report.uv.code, 'Missing optional uv must not prevent worker capture')
  const destination = join(outputDirectory, 'native-diagnostics')
  const tail = await readFile(join(destination, report.workerLogs[0].name), 'utf8')
  assert.ok(tail.endsWith(BOOTSTRAP_ERROR), 'The actual uv failure stderr must survive truncation')
  assert.equal((await readdir(destination)).length, EXPECTED_LOG_LIMIT + 1)
  const metadata = await readFile(join(destination, 'runtime.json'), 'utf8')
  assert.ok(!metadata.includes('private-interpreter-location'))
  assert.ok(!metadata.includes('must not be copied'))
  console.log('PASS bounded worker tails and allowlisted metadata survive missing uv')

  await mkdir(join(linkedFixture, 'prime-agent'), { recursive: true })
  await symlink(logs, join(linkedFixture, 'prime-agent', 'logs'), 'junction')
  const linkedReport = await captureFailedNativeDiagnostics({
    fixtureDirectory: linkedFixture,
    outputDirectory: join(linkedFixture, 'report')
  })
  assert.deepEqual(linkedReport.workerLogs, [])
  assert.ok(linkedReport.errors.some((error) => error.area === 'worker-logs'))
  console.log('PASS symlinked log directories are refused')

  await assert.rejects(
    captureFailedNativeDiagnostics({
      fixtureDirectory: join(REAL_HOME, 'vengeance-qa-engines-abcdef'),
      outputDirectory: join(QA_TMP_ROOT, 'unused-diagnostic-output')
    }),
    /require a QA fixture/
  )
  console.log('PASS real-profile and outside-root paths are refused before access')
} finally {
  if (inheritedPath === undefined) delete process.env.PATH
  else process.env.PATH = inheritedPath
  await rm(linkedFixture, { recursive: true, force: true })
  await rm(fixture, { recursive: true, force: true })
}
