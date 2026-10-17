import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { buildPi } from './build-pi.mjs'
import { buildPrime } from './build-prime.mjs'
import {
  bundleRoot,
  engineLock,
  fingerprint,
  hostPlatform,
  inventory,
  platformFields,
  prepareSource,
  removeStaged,
  root,
  sha256,
  staging,
  writeJson
} from './common.mjs'

const host = hostPlatform()
const requested = process.argv.find((argument) => argument.startsWith('--engine='))?.split('=')[1]
if (requested && !['pi', 'prime'].includes(requested))
  throw new Error(`Unknown engine: ${requested}`)
const prepareOnly = process.argv.includes('--prepare')
const manifestPath = join(bundleRoot, 'manifest.json')
const staged = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
// Payloads staged for another platform, such as a foreign cache, are rebuilt rather than reused.
const manifest =
  staged?.platform === host.key ? staged : { schemaVersion: 1, platform: host.key, engines: {} }

for (const identity of requested ? [requested] : ['pi', 'prime']) {
  const engine = engineLock[identity]
  const inputHash = await fingerprint(engine)
  const destination = join(bundleRoot, identity)
  const previous = manifest.engines[identity]
  // Reuse reads only the lock, the build scripts and the staged payload: no checkout or network.
  if (!prepareOnly && previous?.inputHash === inputHash && existsSync(destination)) {
    const actual = await inventory(destination)
    if (sha256(JSON.stringify(actual)) === previous.payloadHash) {
      console.log(`${identity}: verified ${engine.version}`)
      continue
    }
    throw new Error(
      `${identity} payload changed. Inspect it and remove its manifest entry to rebuild.`
    )
  }
  const source = await prepareSource(identity, engine)
  console.log(`${identity}: source ready at ${source}`)
  if (prepareOnly) continue
  const candidate = join(staging, `candidate-${identity}`)
  await removeStaged(candidate)
  if (identity === 'pi') await buildPi(source, candidate, engine)
  else await buildPrime(source, candidate, engine, host)
  await mkdir(bundleRoot, { recursive: true })
  await removeStaged(destination)
  await rename(candidate, destination)
  const files = await inventory(destination)
  const patches = await Promise.all(
    engine.patches.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) }))
  )
  manifest.engines[identity] = {
    ...engine,
    ...platformFields(identity, host.key),
    patches,
    inputHash,
    payloadHash: sha256(JSON.stringify(files)),
    node: process.version,
    builtAt: new Date().toISOString()
  }
  await writeJson(manifestPath, manifest)
  await copyFile(join(root, 'engines.lock.json'), join(bundleRoot, 'engines.lock.json'))
  console.log(`${identity}: staged ${engine.version} (${Object.keys(files).length} files)`)
}
