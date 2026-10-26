import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inventory, sha256 } from '../../engines/common.mjs'
import { ROOT } from './app.mjs'
import { inspectRequest, turn } from './fake-llm.mjs'
import { hashFile } from './packaged-target.mjs'
import { executableName, resourcesDirOf } from './platform.mjs'
import { killTree, processIdentity, processTable, processWasPresent } from './processes.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT } from './tmp.mjs'

const INTEL_MAC = process.platform === 'darwin' && process.arch === 'x64'
const KERNEL_TIMEOUT_MS = 180_000
const CLEANUP_TIMEOUT_MS = 30_000
const MAXIMUM_OUTPUT_BYTES = 256 * 1024
const BASELINE_VERSION = '0.10.0+vengeance.10'
const KERNEL_EVIDENCE_PREFIX = 'QA_NATIVE_KERNEL='
const KERNEL_OVERRIDE_NAMES = [
  'PRIME_AGENT_KERNEL_PYTHON',
  'UV_CONSTRAINT',
  'UV_FIND_LINKS',
  'UV_OVERRIDE'
]

export function nativeKernelCode(code, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin' || arch !== 'x64') return code
  const overrideNames = JSON.stringify(KERNEL_OVERRIDE_NAMES)
  return [
    code,
    'def _qa_native_kernel_evidence():',
    '    import hashlib, importlib.metadata, json, os, pathlib, platform, sys',
    '    import cryptography',
    '    from cryptography.hazmat.bindings import _rust',
    '    from cryptography.hazmat.backends.openssl.backend import backend',
    '    native_path = pathlib.Path(_rust.__file__).resolve()',
    '    site = pathlib.Path(cryptography.__file__).resolve().parent.parent',
    '    distribution = importlib.metadata.distribution("cryptography")',
    '    direct_url = json.loads(distribution.read_text("direct_url.json") or "{}")',
    '    return {',
    '        "version": cryptography.__version__,',
    '        "opensslVersion": backend.openssl_version_text(),',
    '        "machine": platform.machine(),',
    '        "pythonPrefix": sys.prefix, "pythonExecutable": sys.executable,',
    '        "nativeModule": str(native_path),',
    '        "nativeRelativePath": native_path.relative_to(site).as_posix(),',
    '        "nativeSha256": hashlib.sha256(native_path.read_bytes()).hexdigest(),',
    '        "directUrl": direct_url,',
    `        "overrides": {key: os.environ.get(key) for key in ${overrideNames}}`,
    '    }',
    `print(${JSON.stringify(KERNEL_EVIDENCE_PREFIX)} + ` +
      '__import__("json").dumps(_qa_native_kernel_evidence()))',
    'del _qa_native_kernel_evidence'
  ].join('\n')
}

export async function nativePackageIdentity(executable) {
  const path = await realpath(executable)
  const metadata = JSON.parse(await readFile(join(dirname(path), 'package.json'), 'utf8'))
  return { executablePath: path, version: metadata.version, sha256: await hashFile(path) }
}

/** Engine 2's Python tool: `python_repl` since upstream 0.10.1, `ipython` (and `python`) before. */
export const PYTHON_TOOLS = ['python_repl', 'ipython', 'python']

export async function runNativePythonProbe(application, server, agentId, options) {
  const { toolCallId, code, prompt, toolName = PYTHON_TOOLS[0], timeoutMs = KERNEL_TIMEOUT_MS } = options
  const from = server.requests.length
  server.queue(
    turn.toolCalls([{ id: toolCallId, name: toolName, args: { code } }]),
    turn.text(`The ${toolCallId} probe settled.`)
  )
  await application.send(prompt)
  const request = await server.waitForRequest(
    (entry) => inspectRequest(entry).toolResults.some((result) => result.toolCallId === toolCallId),
    { from, timeoutMs }
  )
  await application.waitForSettle({ timeoutMs })
  const firstRequest = server.requests
    .slice(from)
    .find((entry) => entry.api && entry.method === 'POST')
  const result = inspectRequest(request).toolResults.find(
    (entry) => entry.toolCallId === toolCallId
  )
  const { messages } = await application.rpc({ type: 'get_messages' }, agentId)
  const nativeResult = messages.findLast(
    (message) => message.role === 'toolResult' && message.toolCallId.split('|')[0] === toolCallId
  )
  assert.ok(nativeResult, 'The public transcript contains the native Python result')
  return { request, firstRequest, result, nativeResult }
}

async function candidateExecutable() {
  const directory = process.env.QA_PACKAGED_EXE
    ? join(resourcesDirOf(resolve(process.env.QA_PACKAGED_EXE)), 'engines', 'prime')
    : join(ROOT, '.engine-staging', 'bundled', 'prime')
  return realpath(process.env.QA_PRIME_EXECUTABLE ?? join(directory, executableName('prime-agent')))
}

async function wheelIdentity(executable) {
  const directory = join(dirname(executable), 'prime-agent-runtime', 'wheels')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const build = JSON.parse(await readFile(join(directory, 'build.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.platform, 'darwin-x64')
  assert.equal(manifest.wheels.length, 1)
  const wheel = manifest.wheels[0]
  assert.equal(wheel.distribution, 'cryptography')
  assert.equal(wheel.version, '50.0.2')
  assert.equal(basename(wheel.file), wheel.file, 'The wheel filename stays inside its payload')
  assert.match(wheel.sha256, /^[a-f0-9]{64}$/)
  const path = await realpath(join(directory, wheel.file))
  assert.ok(isInside(await realpath(directory), path), 'The wheel stays inside its payload')
  assert.equal(await hashFile(path), wheel.sha256)
  assert.equal(build.schemaVersion, 1)
  assert.equal(build.platform, 'darwin-x64')
  assert.deepEqual(build.wheel, { file: wheel.file, sha256: wheel.sha256 })
  assert.equal(build.inputs.cryptography.version, wheel.version)
  assert.ok(build.opensslVersion.startsWith(`OpenSSL ${build.inputs.openssl.version} `))
  return { directory, path, wheel, build }
}

export async function assertFreshIntelKernel(fixture) {
  if (!INTEL_MAC) return
  await assert.rejects(stat(fixture.environment.PRIME_AGENT_KERNEL_VENV), { code: 'ENOENT' })
}

export async function verifyIntelKernel(text, fixture, outputDirectory, label = 'intel-kernel') {
  if (!INTEL_MAC) return undefined
  return verifyKernelEvidence(text, {
    executable: await candidateExecutable(),
    kernelDirectory: fixture.environment.PRIME_AGENT_KERNEL_VENV,
    outputDirectory,
    label
  })
}

function verifyArchiveHashes(archiveInfo, wheelBytes) {
  assert.ok(
    archiveInfo && typeof archiveInfo === 'object' && !Array.isArray(archiveInfo),
    'The installed wheel records archive_info metadata'
  )
  const suppliedHashes = []
  if (archiveInfo.hashes !== undefined) {
    assert.ok(
      archiveInfo.hashes &&
        typeof archiveInfo.hashes === 'object' &&
        !Array.isArray(archiveInfo.hashes),
      'Archive hashes must be a digest dictionary'
    )
    suppliedHashes.push(...Object.entries(archiveInfo.hashes))
  }
  if (archiveInfo.hash !== undefined) {
    assert.equal(typeof archiveInfo.hash, 'string')
    assert.match(archiveInfo.hash, /^[a-z0-9_-]+=[a-f0-9]+$/i)
    const separator = archiveInfo.hash.indexOf('=')
    suppliedHashes.push([
      archiveInfo.hash.slice(0, separator),
      archiveInfo.hash.slice(separator + 1)
    ])
  }
  for (const [algorithm, digest] of suppliedHashes) {
    assert.match(algorithm, /^[a-z0-9_-]+$/i)
    assert.equal(typeof digest, 'string')
    assert.match(digest, /^[a-f0-9]+$/i)
    assert.equal(
      createHash(algorithm).update(wheelBytes).digest('hex'),
      digest.toLowerCase(),
      `The installed wheel's ${algorithm} metadata matches its archive`
    )
  }
}

export async function verifyKernelEvidence(text, options) {
  const { executable, kernelDirectory, outputDirectory, label = 'intel-kernel' } = options
  const line = text.split('\n').find((entry) => entry.startsWith(KERNEL_EVIDENCE_PREFIX))
  assert.ok(line, 'The native Python tool reports its loaded cryptography implementation')
  const actual = JSON.parse(line.slice(KERNEL_EVIDENCE_PREFIX.length))
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    join(outputDirectory, `${label}-observed.json`),
    `${JSON.stringify({ verified: false, actual }, null, 2)}\n`
  )
  const expected = await wheelIdentity(executable)
  assert.equal(actual.version, expected.wheel.version)
  assert.equal(actual.opensslVersion, expected.build.opensslVersion)
  assert.equal(actual.machine, 'x86_64')
  const canonicalKernel = await realpath(kernelDirectory)
  assert.equal(await realpath(actual.pythonPrefix), canonicalKernel)
  assert.ok(isInside(canonicalKernel, actual.pythonExecutable))
  const nativeModule = await realpath(actual.nativeModule)
  assert.ok(isInside(canonicalKernel, nativeModule))
  assert.deepEqual(
    actual.overrides,
    Object.fromEntries(KERNEL_OVERRIDE_NAMES.map((key) => [key, null]))
  )
  const native = expected.build.nativeFiles.find(
    (entry) => entry.path === actual.nativeRelativePath
  )
  assert.ok(native, 'The loaded extension is recorded by the packaged wheel build')
  assert.deepEqual(native.architectures, ['x86_64'])
  assert.equal(actual.nativeSha256, native.sha256)
  assert.equal(
    await hashFile(nativeModule),
    native.sha256,
    'The installed extension matches its receipt'
  )
  const sourceUrl = new URL(actual.directUrl.url)
  assert.equal(sourceUrl.protocol, 'file:')
  assert.ok(
    sourceUrl.hostname === '' || sourceUrl.hostname === 'localhost',
    'The installed wheel records a local archive'
  )
  const sourceWheelPath = await realpath(fileURLToPath(sourceUrl))
  assert.equal(basename(sourceWheelPath), expected.wheel.file)
  const wheelBytes = await readFile(sourceWheelPath)
  const sourceWheelSha256 = sha256(wheelBytes)
  assert.equal(
    sourceWheelSha256,
    expected.wheel.sha256,
    'The direct URL archive matches the verified packaged wheel'
  )
  // PEP 610 makes archive digests optional, including uv's direct local wheel records.
  verifyArchiveHashes(actual.directUrl.archive_info, wheelBytes)
  const evidence = {
    actual,
    sourceWheel: { path: sourceWheelPath, sha256: sourceWheelSha256 },
    wheel: expected.wheel,
    build: expected.build
  }
  await writeFile(join(outputDirectory, `${label}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}

function bootstrapEnvironment(fixture, directory, constraint) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(PRIME_|PI_|VENGEANCE_|UV_|PYTHON|RUSTUP_HOME$|CARGO_HOME$)/.test(name)
    )
  )
  Object.assign(environment, fixture.environment, {
    HOME: join(directory, 'home'),
    TEMP: join(directory, 'tmp'),
    TMP: join(directory, 'tmp'),
    TMPDIR: QA_TMP_ROOT,
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'),
    UV_CONSTRAINT: constraint,
    UV_NO_CONFIG: '1',
    UV_CACHE_DIR: join(directory, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(directory, 'python')
  })
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name]
  }
  return environment
}

async function withDeadline(action, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function bootstrapIdentity(pid, executable) {
  const [identity, table] = await Promise.all([processIdentity(pid), processTable()])
  assert.equal(await realpath(identity.executablePath), executable)
  const entry = table.find((record) => record.pid === pid)
  assert.ok(entry?.createdMs > 0, 'The baseline bootstrap has a verifiable creation time')
  assert.ok(entry.commandLine.includes(executable))
  assert.ok(entry.commandLine.includes('--prime-agent-bootstrap'))
  return { ...entry, executablePath: identity.executablePath }
}

async function runBaselineBootstrap(executable, environment, cwd, receipt) {
  const child = spawn(executable, ['--prime-agent-bootstrap'], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let exited = false
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  const lengths = { stdout: 0, stderr: 0 }
  for (const name of Object.keys(output)) {
    child[name].on('data', (chunk) => {
      lengths[name] += chunk.length
      output[name] = Buffer.concat([output[name], chunk]).subarray(-MAXIMUM_OUTPUT_BYTES)
    })
  }
  const completion = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (code, signal) => {
      exited = true
      resolveExit({ code, signal })
    })
  })
  const captured = bootstrapIdentity(child.pid, executable).then(
    (identity) => ({ identity }),
    (error) => ({ error })
  )
  let failure
  try {
    const status = await withDeadline(
      () => completion,
      KERNEL_TIMEOUT_MS,
      'The isolated baseline kernel bootstrap timed out'
    )
    Object.assign(receipt, status)
    assert.equal(
      status.code,
      0,
      `The baseline kernel bootstrap failed (${status.signal ?? status.code})`
    )
  } catch (error) {
    failure = error
  } finally {
    if (!exited && child.exitCode === null && child.signalCode === null) {
      await withDeadline(
        async () => {
          const original = await captured
          if (exited) return
          if (original.error) throw original.error
          const current = await bootstrapIdentity(child.pid, executable)
          if (exited) return
          assert.ok(processWasPresent(current, [original.identity]), 'The bootstrap PID was reused')
          await killTree(child.pid)
          await completion
        },
        CLEANUP_TIMEOUT_MS,
        'The isolated baseline bootstrap process tree did not stop'
      ).catch((error) => {
        receipt.cleanupFailure = error.stack ?? String(error)
        failure ??= error
      })
    }
    receipt.stdout = output.stdout.toString('utf8')
    receipt.stderr = output.stderr.toString('utf8')
    receipt.outputBytes = lengths
    const original = await captured
    if (original.identity) receipt.process = original.identity
  }
  if (failure) throw failure
}

export async function snapshotNativeBaseline(executable, outputDirectory) {
  const canonical = await realpath(executable)
  const directory = await realpath(dirname(dirname(canonical)))
  assertOutsideRealHome(directory)
  const ownershipRoot = await realpath(
    assertOutsideRealHome(process.env.QA_RELEASE_BASELINE_TMP_ROOT ?? QA_TMP_ROOT)
  )
  const suiteTemporaryRoot = await realpath(assertOutsideRealHome(QA_TMP_ROOT))
  assertOutsideRealHome(ownershipRoot)
  assertOutsideRealHome(suiteTemporaryRoot)
  assert.ok(
    isInside(ownershipRoot, suiteTemporaryRoot),
    'The baseline ownership root must contain the suite temporary root'
  )
  assert.ok(isInside(ownershipRoot, directory), 'The baseline escaped its verified ownership root')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  assert.equal(manifest.platform, `${process.platform}-${process.arch}`)
  assert.equal(manifest.engines.prime.version, BASELINE_VERSION)
  assert.equal(await realpath(join(directory, manifest.engines.prime.entry)), canonical)
  const before = await inventory(directory)
  const evidence = {
    directory,
    ownershipRoot,
    suiteTemporaryRoot,
    before,
    beforeSha256: sha256(JSON.stringify(before))
  }
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    join(outputDirectory, 'baseline-inventory.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  return evidence
}

async function assertWritableFixturePath(root, path) {
  assert.equal(typeof path, 'string', 'The writable kernel fixture path is required')
  assert.ok(isAbsolute(path), 'The writable kernel fixture path must be absolute')
  const target = assertOutsideRealHome(path)
  assert.ok(isInside(root, target), 'A writable kernel path escaped its suite fixture')
  let parent = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    parent = join(parent, part)
    const entry = await lstat(parent).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!entry) break
    assert.equal(entry.isSymbolicLink(), false, 'Writable kernel paths cannot contain links')
    assert.ok(entry.isDirectory(), 'Writable kernel paths must be directories')
  }
}

export async function validateNativeKernelFixture(fixture) {
  const suiteRoot = await realpath(assertOutsideRealHome(QA_TMP_ROOT))
  const root = await realpath(assertOutsideRealHome(fixture.root.dir))
  assertOutsideRealHome(suiteRoot)
  assertOutsideRealHome(root)
  assert.ok(isInside(suiteRoot, root), 'The writable kernel fixture escaped its suite temp root')
  const environment = fixture.environment
  assert.equal(environment.PRIME_AGENT_CODING_AGENT_DIR, fixture.primeDirectory)
  assert.equal(environment.PRIME_AGENT_KERNEL_PYTHON, undefined)
  for (const path of [
    environment.PRIME_AGENT_CODING_AGENT_DIR,
    environment.PRIME_AGENT_KERNEL_VENV,
    environment.PYTHONPYCACHEPREFIX,
    join(root, 'baseline-kernel-bootstrap')
  ]) {
    await assertWritableFixturePath(root, path)
  }
  assert.ok(
    isInside(environment.PRIME_AGENT_KERNEL_VENV, environment.PYTHONPYCACHEPREFIX),
    'Python bytecode must stay inside the fixture kernel directory'
  )
  return root
}

export async function prepareNativeBaseline(fixture, executable, outputDirectory) {
  if (!process.env.QA_PACKAGED_EXE && !INTEL_MAC) return undefined
  const evidence = await snapshotNativeBaseline(executable, outputDirectory)
  if (!INTEL_MAC) return evidence
  const canonical = await realpath(executable)
  evidence.prewarm = { executable: canonical, executableSha256: await hashFile(canonical) }
  let failure
  try {
    const fixtureRoot = await validateNativeKernelFixture(fixture)
    await assertFreshIntelKernel(fixture)
    const wheel = await wheelIdentity(await candidateExecutable())
    const temporary = join(fixtureRoot, 'baseline-kernel-bootstrap')
    await mkdir(temporary)
    await mkdir(join(temporary, 'home'))
    await mkdir(join(temporary, 'tmp'))
    const constraint = join(temporary, 'constraint.txt')
    assert.ok(!/\s/.test(constraint), 'Use a QA_TMP_ROOT without spaces for UV_CONSTRAINT')
    await writeFile(
      constraint,
      `cryptography @ ${pathToFileURL(wheel.path).href}#sha256=${wheel.wheel.sha256}\n`
    )
    const environment = bootstrapEnvironment(fixture, temporary, constraint)
    await runBaselineBootstrap(canonical, environment, fixture.root.dir, evidence.prewarm)
    const pythonLine = evidence.prewarm.stdout
      .split('\n')
      .find((line) => line.startsWith('kernel python: '))
    assert.ok(pythonLine, 'The baseline bootstrap reports its selected Python')
    assert.equal(
      resolve(pythonLine.slice('kernel python: '.length).trim()),
      resolve(join(fixture.environment.PRIME_AGENT_KERNEL_VENV, 'bin', 'python'))
    )
    const versionPath = join(fixture.environment.PRIME_AGENT_KERNEL_VENV, '.bootstrap-version')
    evidence.prewarm.readiness = JSON.parse(await readFile(versionPath, 'utf8'))
    assert.match(evidence.prewarm.readiness.runtime, /^sha256:[a-f0-9]{64}$/)
    evidence.prewarm.wheel = wheel.wheel
    console.log('    Intel baseline kernel prewarmed through the immutable .10 executable')
  } catch (error) {
    failure = error
    evidence.prewarm.failure = error.stack ?? String(error)
  } finally {
    await writeFile(
      join(outputDirectory, 'baseline-prewarm.json'),
      `${JSON.stringify(evidence.prewarm, null, 2)}\n`
    ).catch((error) => {
      failure ??= error
    })
    await verifyNativeBaseline(evidence, outputDirectory).catch((error) => {
      failure ??= error
    })
  }
  if (failure) throw failure
  return evidence
}

export async function verifyNativeBaseline(evidence, outputDirectory) {
  if (!evidence) return
  evidence.after = await inventory(evidence.directory)
  evidence.afterSha256 = sha256(JSON.stringify(evidence.after))
  await writeFile(
    join(outputDirectory, 'baseline-inventory.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  assert.deepEqual(
    evidence.after,
    evidence.before,
    'The complete baseline engine payload stays immutable'
  )
}

export async function verifyIntelKernelUpgrade(
  application,
  fixture,
  agentId,
  baseline,
  outputDirectory
) {
  if (!INTEL_MAC) return undefined
  assert.ok(
    baseline?.prewarm?.readiness,
    'The Intel upgrade starts with genuine .10 kernel readiness'
  )
  const probe = await runNativePythonProbe(application, fixture.primeServer, agentId, {
    toolCallId: 'intel-upgraded-kernel',
    code: nativeKernelCode('print("Intel candidate kernel ready")'),
    prompt: 'Run the brief upgraded kernel probe.'
  })
  assert.notEqual(probe.result.isError, true, probe.result.text)
  const result = await verifyIntelKernel(
    probe.result.text,
    fixture,
    outputDirectory,
    'intel-upgraded-kernel'
  )
  const versionPath = join(fixture.environment.PRIME_AGENT_KERNEL_VENV, '.bootstrap-version')
  result.readiness = JSON.parse(await readFile(versionPath, 'utf8'))
  assert.match(result.readiness.runtime, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(
    result.readiness.runtime,
    baseline.prewarm.readiness.runtime,
    'The candidate invalidates the baseline kernel readiness with its packaged wheel identity'
  )
  await writeFile(
    join(outputDirectory, 'intel-upgraded-kernel.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
  return result
}
