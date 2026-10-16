import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bundleRoot, engineLock, fingerprint, inventory, sha256 } from './common.mjs'

export async function verifyEngines(directory = bundleRoot) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.platform !== engineLock.platform) {
    throw new Error('Unsupported bundled engine manifest')
  }
  for (const identity of ['pi', 'prime']) {
    const expected = engineLock[identity]
    const shipped = manifest.engines[identity]
    if (
      shipped?.inputHash !== (await fingerprint(expected)) ||
      shipped.version !== expected.version
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
