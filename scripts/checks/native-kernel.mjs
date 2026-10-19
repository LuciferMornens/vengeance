import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  nativeKernelCode,
  snapshotNativeBaseline,
  verifyKernelEvidence,
  verifyNativeBaseline
} from '../qa/lib/native-kernel.mjs'
import { hashFile } from '../qa/lib/packaged-target.mjs'
import { executableName } from '../qa/lib/platform.mjs'
import { qaTempDir } from '../qa/lib/tmp.mjs'

const directory = await qaTempDir('qa-native-kernel-check-')
let escapedDirectory
const executeFile = promisify(execFile)
const CHILD_TIMEOUT_MS = 10_000
const MAXIMUM_CHILD_OUTPUT_BYTES = 64 * 1024
const WHEEL_NAME = 'cryptography-50.0.2-cp311-abi3-macosx_13_0_x86_64.whl'
const NATIVE_MODULE = 'cryptography/hazmat/bindings/_rust.abi3.so'
const OPENSSL_VERSION = 'OpenSSL 4.0.3 fixture'
const KERNEL_PREFIX = 'QA_NATIVE_KERNEL='
const baselineDirectory = join(directory, 'baseline', 'engines')
const executable = join(directory, 'candidate', executableName('prime-agent'))
const wheelDirectory = join(directory, 'candidate', 'prime-agent-runtime', 'wheels')
const kernelDirectory = join(directory, 'kernel-venv')
const nativeModule = join(kernelDirectory, 'lib', 'python3.11', 'site-packages', NATIVE_MODULE)
const outputDirectory = join(directory, 'receipts')

try {
  await mkdir(wheelDirectory, { recursive: true })
  await mkdir(join(baselineDirectory, 'prime'), { recursive: true })
  await mkdir(join(baselineDirectory, 'pi'), { recursive: true })
  await mkdir(
    join(
      kernelDirectory,
      'lib',
      'python3.11',
      'site-packages',
      'cryptography',
      'hazmat',
      'bindings'
    ),
    { recursive: true }
  )
  await writeFile(executable, 'owned fixture executable; never launched')
  await writeFile(nativeModule, 'owned fixture native extension; never loaded')
  await writeFile(join(wheelDirectory, WHEEL_NAME), 'owned fixture wheel; never installed')
  const wheelHash = await hashFile(join(wheelDirectory, WHEEL_NAME))
  const nativeHash = await hashFile(nativeModule)
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin-x64',
    wheels: [
      { distribution: 'cryptography', version: '50.0.2', file: WHEEL_NAME, sha256: wheelHash }
    ]
  }
  const build = {
    schemaVersion: 1,
    platform: 'darwin-x64',
    inputs: { cryptography: { version: '50.0.2' }, openssl: { version: '4.0.3' } },
    opensslVersion: OPENSSL_VERSION,
    wheel: { file: WHEEL_NAME, sha256: wheelHash },
    nativeFiles: [{ path: NATIVE_MODULE, sha256: nativeHash, architectures: ['x86_64'] }]
  }
  const metadataPath = join(wheelDirectory, 'manifest.json')
  await writeFile(metadataPath, JSON.stringify(manifest))
  await writeFile(join(wheelDirectory, 'build.json'), JSON.stringify(build))
  const actual = {
    version: '50.0.2',
    opensslVersion: OPENSSL_VERSION,
    machine: 'x86_64',
    pythonPrefix: kernelDirectory,
    pythonExecutable: join(kernelDirectory, 'bin', 'python'),
    nativeModule,
    nativeRelativePath: NATIVE_MODULE,
    nativeSha256: nativeHash,
    directUrl: {
      url: pathToFileURL(join(wheelDirectory, WHEEL_NAME)).href,
      archive_info: { hashes: { sha256: wheelHash } }
    },
    overrides: {
      PRIME_AGENT_KERNEL_PYTHON: null,
      UV_CONSTRAINT: null,
      UV_FIND_LINKS: null,
      UV_OVERRIDE: null
    }
  }
  const verify = (value) =>
    verifyKernelEvidence(KERNEL_PREFIX + JSON.stringify(value), {
      executable,
      kernelDirectory,
      outputDirectory
    })
  await verify(actual)
  const receipt = JSON.parse(await readFile(join(outputDirectory, 'intel-kernel.json'), 'utf8'))
  assert.equal(receipt.actual.nativeSha256, nativeHash)
  await assert.rejects(verify({ ...actual, version: '48.0.0' }))
  await assert.rejects(verify({ ...actual, opensslVersion: 'OpenSSL unrelated' }))
  await assert.rejects(verify({ ...actual, nativeSha256: '0'.repeat(nativeHash.length) }))
  await assert.rejects(verify({ ...actual, pythonPrefix: directory }))
  await assert.rejects(verify({ ...actual, pythonExecutable: executable }))
  await assert.rejects(verify({ ...actual, nativeModule: executable }))
  await assert.rejects(
    verify({ ...actual, overrides: { ...actual.overrides, UV_CONSTRAINT: 'leak' } })
  )
  await assert.rejects(
    verify({
      ...actual,
      directUrl: {
        ...actual.directUrl,
        archive_info: { hashes: { sha256: '0'.repeat(wheelHash.length) } }
      }
    })
  )
  await assert.rejects(
    verify({ ...actual, directUrl: { ...actual.directUrl, url: 'https://invalid/wheel' } })
  )
  await writeFile(nativeModule, 'different installed native bytes')
  await assert.rejects(verify(actual), /installed extension matches its receipt/)
  await writeFile(nativeModule, 'owned fixture native extension; never loaded')
  await writeFile(join(wheelDirectory, WHEEL_NAME), 'different archive bytes')
  await assert.rejects(verify(actual))
  await writeFile(join(wheelDirectory, WHEEL_NAME), 'owned fixture wheel; never installed')
  await writeFile(metadataPath, JSON.stringify({ ...manifest, platform: 'darwin-arm64' }))
  await assert.rejects(verify(actual))
  await writeFile(
    metadataPath,
    JSON.stringify({ ...manifest, wheels: [{ ...manifest.wheels[0], file: '../escape.whl' }] })
  )
  await assert.rejects(verify(actual), /filename stays inside/)

  const prompt = 'print("owned kernel probe")'
  assert.equal(nativeKernelCode(prompt, { platform: 'win32', arch: 'x64' }), prompt)
  assert.equal(nativeKernelCode(prompt, { platform: 'darwin', arch: 'arm64' }), prompt)
  const intelCode = nativeKernelCode(prompt, { platform: 'darwin', arch: 'x64' })
  assert.ok(intelCode.startsWith(prompt))
  assert.ok(intelCode.includes('direct_url.json'))
  assert.ok(intelCode.endsWith('del _qa_native_kernel_evidence'))

  const baselineExecutable = join(baselineDirectory, 'prime', executableName('prime-agent'))
  await writeFile(baselineExecutable, 'immutable older native executable; never launched')
  await writeFile(join(baselineDirectory, 'pi', 'entry.js'), 'immutable other engine')
  await writeFile(
    join(baselineDirectory, 'manifest.json'),
    JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      engines: {
        prime: { version: '0.10.0+vengeance.10', entry: `prime/${executableName('prime-agent')}` }
      }
    })
  )
  const baseline = await snapshotNativeBaseline(baselineExecutable, outputDirectory)
  await verifyNativeBaseline(baseline, outputDirectory)

  const suiteRoot = join(directory, 'p-suite')
  const fixtureRoot = join(suiteRoot, 'native-fixture')
  const accountDirectory = join(fixtureRoot, 'prime-agent')
  const kernel = join(fixtureRoot, 'kernel-venv')
  await mkdir(accountDirectory, { recursive: true })
  const fixture = {
    root: { dir: fixtureRoot },
    primeDirectory: accountDirectory,
    environment: {
      PRIME_AGENT_CODING_AGENT_DIR: accountDirectory,
      PRIME_AGENT_KERNEL_VENV: kernel,
      PYTHONPYCACHEPREFIX: join(kernel, 'pycache')
    }
  }
  const childCode = [
    'const helper = await import(process.argv[1])',
    'const options = JSON.parse(process.argv[2])',
    'await helper.snapshotNativeBaseline(options.executable, options.outputDirectory)',
    'await helper.validateNativeKernelFixture(options.fixture)',
    'console.log("Sibling baseline and nested writable fixture: PASS")'
  ].join('\n')
  const childOptions = {
    executable: baselineExecutable,
    outputDirectory: join(outputDirectory, 'nested-suite'),
    fixture
  }
  async function nestedSuite(options, ownershipRoot) {
    const environment = { ...process.env, QA_TMP_ROOT: suiteRoot }
    if (ownershipRoot === undefined) delete environment.QA_RELEASE_BASELINE_TMP_ROOT
    else environment.QA_RELEASE_BASELINE_TMP_ROOT = ownershipRoot
    return executeFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        childCode,
        new URL('../qa/lib/native-kernel.mjs', import.meta.url).href,
        JSON.stringify(options)
      ],
      { env: environment, timeout: CHILD_TIMEOUT_MS, maxBuffer: MAXIMUM_CHILD_OUTPUT_BYTES }
    )
  }
  await assert.rejects(nestedSuite(childOptions), /baseline escaped its verified ownership root/)
  await nestedSuite(childOptions, directory)
  const nestedReceipt = JSON.parse(
    await readFile(join(childOptions.outputDirectory, 'baseline-inventory.json'), 'utf8')
  )
  assert.equal(nestedReceipt.ownershipRoot, await realpath(directory))
  assert.equal(nestedReceipt.suiteTemporaryRoot, await realpath(suiteRoot))
  const containedBaseline = join(suiteRoot, 'baseline', 'engines')
  await cp(baselineDirectory, containedBaseline, { recursive: true })
  await nestedSuite({
    ...childOptions,
    executable: join(containedBaseline, 'prime', executableName('prime-agent'))
  })
  const fallbackReceipt = JSON.parse(
    await readFile(join(childOptions.outputDirectory, 'baseline-inventory.json'), 'utf8')
  )
  assert.equal(fallbackReceipt.ownershipRoot, fallbackReceipt.suiteTemporaryRoot)
  await assert.rejects(
    nestedSuite(childOptions, baselineDirectory),
    /must contain the suite temporary root/
  )
  escapedDirectory = await qaTempDir('qa-native-kernel-outside-')
  const escapedExecutable = join(escapedDirectory, 'prime', executableName('prime-agent'))
  await mkdir(join(escapedDirectory, 'prime'))
  await writeFile(escapedExecutable, 'outside the explicit baseline ownership root')
  await assert.rejects(
    nestedSuite({ ...childOptions, executable: escapedExecutable }, directory),
    /baseline escaped its verified ownership root/
  )
  const escapedKernel = join(directory, 'outside-suite-kernel')
  await assert.rejects(
    nestedSuite(
      {
        ...childOptions,
        fixture: {
          ...fixture,
          environment: { ...fixture.environment, PRIME_AGENT_KERNEL_VENV: escapedKernel }
        }
      },
      directory
    ),
    /writable kernel path escaped its suite fixture/
  )
  await assert.rejects(
    nestedSuite(
      {
        ...childOptions,
        fixture: {
          ...fixture,
          primeDirectory: escapedDirectory,
          environment: { ...fixture.environment, PRIME_AGENT_CODING_AGENT_DIR: escapedDirectory }
        }
      },
      directory
    ),
    /writable kernel path escaped its suite fixture/
  )
  const linkedDirectory = join(fixtureRoot, 'linked-kernel')
  await symlink(escapedDirectory, linkedDirectory, 'junction')
  await assert.rejects(
    nestedSuite(
      {
        ...childOptions,
        fixture: {
          ...fixture,
          environment: {
            ...fixture.environment,
            PRIME_AGENT_KERNEL_VENV: join(linkedDirectory, 'kernel')
          }
        }
      },
      directory
    ),
    /Writable kernel paths cannot contain links/
  )
  await rm(linkedDirectory, { recursive: true, force: true })

  const factoryCode = [
    'import assert from "node:assert/strict"',
    'import { stat } from "node:fs/promises"',
    'const helper = await import(process.argv[1])',
    'const { createEngineFixture } = await import(process.argv[2])',
    'const fixture = await createEngineFixture()',
    'try {',
    '  await helper.validateNativeKernelFixture(fixture)',
    '  await assert.rejects(stat(fixture.environment.PRIME_AGENT_KERNEL_VENV), {code: "ENOENT"})',
    '  console.log("Actual engine fixture has scoped bytecode and a fresh kernel: PASS")',
    '} finally { await fixture.cleanup() }'
  ].join('\n')
  const factoryResult = await executeFile(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      factoryCode,
      new URL('../qa/lib/native-kernel.mjs', import.meta.url).href,
      new URL('../qa/engines/integration-fixture.mjs', import.meta.url).href
    ],
    {
      env: {
        ...process.env,
        QA_TMP_ROOT: suiteRoot,
        QA_PRIME_EXECUTABLE: executable,
        QA_PRIME_SHA256: await hashFile(executable)
      },
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: MAXIMUM_CHILD_OUTPUT_BYTES
    }
  )
  process.stdout.write(factoryResult.stdout)

  await writeFile(join(baselineDirectory, 'pi', 'entry.js'), 'mutated other engine')
  await assert.rejects(
    verifyNativeBaseline(baseline, outputDirectory),
    /complete baseline engine payload/
  )
  console.log(
    '✓ native kernel receipts, sibling baseline scopes, real fixtures and corruption guards passed'
  )
} finally {
  if (escapedDirectory) await rm(escapedDirectory, { recursive: true, force: true })
  await rm(directory, { recursive: true, force: true })
}
