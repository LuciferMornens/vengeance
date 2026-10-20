// Records the packaged native payloads and release files after the packaged smoke check succeeds.
// --engines-cache-key names the Actions cache entry a pull request dry run restored its staged
// engines and helper from; empty or absent, the run built them itself, as every tag run does.
import asar from '@electron/asar'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { engineLock, executableName, hostKey, root, systemPath } from '../engines/common.mjs'
import { verifyEngines } from '../engines/verify.mjs'

const HELPER_PROTOCOL = 1
const HELPER_TIMEOUT_MS = 15_000
const executeFile = promisify(execFile)
const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    artifacts: { type: 'string' },
    'engines-cache-key': { type: 'string' },
    output: { type: 'string' },
    revision: { type: 'string' }
  }
})

try {
  for (const option of ['app', 'artifacts', 'output']) {
    if (!values[option] || !isAbsolute(values[option])) {
      throw new Error(`--${option} requires an absolute path`)
    }
  }
  if (!/^[a-f0-9]{40}$/.test(values.revision ?? '')) {
    throw new Error('--revision requires the full checked-out commit SHA')
  }
  const cacheKey = values['engines-cache-key'] || null
  if (cacheKey && process.env.GITHUB_EVENT_NAME !== 'pull_request') {
    throw new Error('Only pull request dry runs may restore their native payloads')
  }
  if (cacheKey && !new RegExp(`^engines-v\\d+-${hostKey}-[a-f0-9]{64}$`).test(cacheKey)) {
    throw new Error(`--engines-cache-key ${cacheKey} is not a ${hostKey} engine payload key`)
  }
  await recordReceipt({ ...values, cacheKey })
} catch (error) {
  console.error(`Release receipt failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function recordReceipt(options) {
  const artifacts = await releaseArtifacts(options.artifacts)
  const resources =
    process.platform === 'darwin'
      ? join(options.app, 'Contents', 'Resources')
      : join(options.app, 'resources')
  const packagedApp = JSON.parse(asar.extractFile(join(resources, 'app.asar'), 'package.json'))
  const sourceApp = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (packagedApp.version !== sourceApp.version) {
    throw new Error(`Packaged app version ${packagedApp.version} differs from ${sourceApp.version}`)
  }
  const enginesRoot = join(resources, 'engines')
  const manifest = await verifyEngines({ directory: enginesRoot, platform: hostKey })
  const engines = {}
  for (const identity of ['pi', 'prime']) {
    const engine = manifest.engines[identity]
    if (engine.revision !== engineLock[identity].revision) {
      throw new Error(`${identity}: packaged upstream revision differs from engines.lock.json`)
    }
    engines[identity] = {
      version: engine.version,
      revision: engine.revision,
      inputHash: engine.inputHash,
      payloadHash: engine.payloadHash,
      entrySha256: await fileHash(join(enginesRoot, engine.entry))
    }
  }
  const helperPath = join(resources, 'prime-auth', executableName('vengeance-prime-auth', hostKey))
  const helperVersion = await executeFile(helperPath, ['--version'], {
    windowsHide: true,
    timeout: HELPER_TIMEOUT_MS,
    env: { ...process.env, ...systemPath() }
  })
  const helper = JSON.parse(helperVersion.stdout)
  if (helper.protocol !== HELPER_PROTOCOL || helper.revision !== engineLock.prime.revision) {
    throw new Error('Packaged helper protocol or upstream revision differs from the engine lock')
  }
  const receipt = {
    schemaVersion: 1,
    platform: hostKey,
    app: { name: packagedApp.name, version: packagedApp.version, revision: options.revision },
    workflow: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? null
    },
    nativePayloads: options.cacheKey
      ? { source: 'restored', cacheKey: options.cacheKey }
      : { source: 'built' },
    engines,
    helper: {
      protocol: helper.protocol,
      revision: helper.revision,
      sha256: await fileHash(helperPath)
    },
    artifacts
  }
  const text = JSON.stringify(receipt, null, 2) + '\n'
  await writeFile(options.output, text)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release provenance (${hostKey})\n\n\`\`\`json\n${text}\`\`\`\n`
    )
  }
  console.log(text)
  console.log(`Release receipt: ${options.output}`)
}

async function releaseArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && /^(Vengeance-|latest.*\.yml$)/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (!names.some((name) => name.startsWith('Vengeance-'))) {
    throw new Error('The artifact directory contains no Vengeance release packages')
  }
  const artifacts = []
  for (const name of names) {
    const path = join(directory, name)
    artifacts.push({ name, bytes: (await stat(path)).size, sha256: await fileHash(path) })
  }
  return artifacts
}

async function fileHash(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) hash.update(chunk)
    return hash.digest('hex')
  } finally {
    stream.destroy()
  }
}
