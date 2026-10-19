import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT } from './app.mjs'
import { resourcesDirOf } from './platform.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT } from './tmp.mjs'

const PLATFORM = `${process.platform}-${process.arch}`
export const PACKAGED_PRODUCT_NAME = 'Vengeance QA'

export function packagedLaunchOptions(environment) {
  const executable = process.env.QA_PACKAGED_EXE
  return {
    exe: executable,
    env: {
      ...environment,
      ...(executable
        ? {
            PI_PACKAGE_DIR: undefined,
            VENGEANCE_PRIME_EXECUTABLE: undefined,
            VENGEANCE_BUNDLED_ENGINES: undefined
          }
        : {})
    }
  }
}

async function canonicalPath(path) {
  const canonical = await realpath(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export async function validatePackagedTarget(target, expectedExecutable) {
  assert.equal(target.application.packaged, true, 'Qualification requires a packaged app')
  assert.equal(
    target.application.name,
    PACKAGED_PRODUCT_NAME,
    'Use the isolated Vengeance QA package'
  )
  assert.equal(target.application.platform, process.platform)
  assert.equal(target.application.arch, process.arch)
  assert.equal(
    await canonicalPath(target.application.executable),
    await canonicalPath(expectedExecutable),
    'The suite launched a different executable'
  )
  assert.equal(
    await canonicalPath(target.application.resources),
    await canonicalPath(resourcesDirOf(expectedExecutable)),
    'The suite loaded another package resource directory'
  )
  const metadata = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(target.application.version, metadata.version)
  const manifest = JSON.parse(
    await readFile(join(target.application.resources, 'engines', 'manifest.json'), 'utf8')
  )
  assert.equal(manifest.platform, PLATFORM)
  for (const engine of ['pi', 'prime']) {
    const descriptor = target.engines[engine]
    assert.equal(descriptor.found, true, descriptor.error)
    assert.equal(descriptor.mock, false, `${engine} must use its native backend`)
    assert.equal(descriptor.source, 'bundled', `${engine} must come from the package`)
    assert.match(descriptor.version, /\+vengeance\./)
    const identity = target.identities[engine]
    assert.equal(identity.version, descriptor.version)
    assert.equal(identity.version, manifest.engines[engine].version)
    assert.equal(identity.revision, manifest.engines[engine].revision)
    assert.equal(identity.payloadHash, manifest.engines[engine].payloadHash)
    const entry = join(target.application.resources, 'engines', manifest.engines[engine].entry)
    assert.equal(identity.entrySha256, await hashFile(entry), `${engine} loaded another entry`)
  }
  assert.equal(target.engines.pi.runtime, 'electron')
  assert.ok(isInside(target.application.resources, target.engines.pi.cliPath))
  assert.ok(isInside(target.application.userData, target.engines.prime.cliPath))
  assertOutsideRealHome(target.piAgentDirectory)
  assertOutsideRealHome(target.primeAgentDirectory)
  assert.ok(isInside(QA_TMP_ROOT, target.piAgentDirectory))
  assert.ok(isInside(QA_TMP_ROOT, target.primeAgentDirectory))
}

// The receipt comes from the running app, so development output cannot qualify as a package.
export async function recordPackagedTarget(application) {
  const executable = process.env.QA_PACKAGED_EXE
  if (!executable) return
  const target = await application.app.evaluate(({ app }) => ({
    application: {
      packaged: app.isPackaged,
      name: app.getName(),
      version: app.getVersion(),
      pid: process.pid,
      executable: process.execPath,
      resources: process.resourcesPath,
      userData: app.getPath('userData'),
      platform: process.platform,
      arch: process.arch
    },
    piAgentDirectory: process.env.PI_CODING_AGENT_DIR,
    primeAgentDirectory: process.env.PRIME_AGENT_CODING_AGENT_DIR
  }))
  target.engines = {}
  target.identities = {}
  const manifest = JSON.parse(
    await readFile(join(target.application.resources, 'engines', 'manifest.json'), 'utf8')
  )
  for (const engine of ['pi', 'prime']) {
    const descriptor = await application.invoke('engine:describe', engine)
    target.engines[engine] = descriptor
    target.identities[engine] = {
      version: descriptor.version,
      revision: manifest.engines[engine].revision,
      payloadHash: manifest.engines[engine].payloadHash,
      entrySha256: await hashFile(descriptor.cliPath)
    }
  }
  await validatePackagedTarget(target, executable)
  if (process.env.QA_PLATFORM_RECEIPT) {
    target.suite = process.env.QA_PLATFORM_SUITE
    await writeFile(process.env.QA_PLATFORM_RECEIPT, `${JSON.stringify(target, null, 2)}\n`)
  }
}

export async function hashFile(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}
