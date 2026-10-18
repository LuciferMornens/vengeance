import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bundleRoot,
  engineLock,
  fingerprint,
  hostKey,
  inventory,
  platformFields,
  sha256
} from './common.mjs'

/** Verifies a staged or packaged payload built for `platform` (`<os>-<arch>`, default this host). */
export async function verifyEngines({ directory = bundleRoot, platform = hostKey } = {}) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (!engineLock.platforms[platform]) {
    throw new Error(`Vengeance has no engine build for ${platform}`)
  }
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported bundled engine manifest')
  if (manifest.platform !== platform) {
    throw new Error(`Bundled engines target ${manifest.platform}; this package needs ${platform}`)
  }
  for (const identity of ['pi', 'prime']) {
    const expected = engineLock[identity]
    const shipped = manifest.engines[identity]
    if (
      shipped?.inputHash !== (await fingerprint(expected)) ||
      shipped.version !== expected.version ||
      Object.entries(platformFields(identity, platform)).some(
        ([field, value]) => shipped[field] !== value
      )
    ) {
      throw new Error(`${identity}: engine inputs changed; run npm run build:engines`)
    }
    const actual = await inventory(join(directory, identity))
    if (sha256(JSON.stringify(actual)) !== shipped.payloadHash) {
      throw new Error(`${identity}: engine payload is incomplete or modified`)
    }
    console.log(`${identity}: verified ${shipped.version} (${Object.keys(actual).length} files)`)
  }
  return manifest
}
