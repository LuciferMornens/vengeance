import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  await writeFile(join(baselineDirectory, 'pi', 'entry.js'), 'mutated other engine')
  await assert.rejects(
    verifyNativeBaseline(baseline, outputDirectory),
    /complete baseline engine payload/
  )
  console.log(
    '✓ native kernel receipts reject wrong wheels, loaded bytes, overrides and baseline mutation'
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
