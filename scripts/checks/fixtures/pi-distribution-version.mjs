import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageDirectory, distributionVersion, upstreamVersion, workspace] = process.argv.slice(2)
const configuration = await import(pathToFileURL(join(packageDirectory, 'dist/config.js')))
const sdk = await import(pathToFileURL(join(packageDirectory, 'dist/index.js')))
const updates = await import(pathToFileURL(join(packageDirectory, 'dist/utils/version-check.js')))
const metadata = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))

assert.equal(metadata.version, upstreamVersion)
assert.equal(sdk.VERSION, upstreamVersion)
assert.equal(configuration.VERSION, upstreamVersion)
assert.equal(metadata.vengeance.version, distributionVersion)
assert.equal(configuration.DISTRIBUTION_VERSION, distributionVersion)
assert.equal(configuration.detectInstallChange(), undefined)

const replacementMetadata = join(workspace, 'replacement-package.json')
const replacementVersion = `${upstreamVersion}+vengeance.999`
await writeFile(
  replacementMetadata,
  JSON.stringify({ ...metadata, vengeance: { ...metadata.vengeance, version: replacementVersion } })
)
assert.deepEqual(configuration.detectInstallChange(replacementMetadata), {
  kind: 'updated',
  version: replacementVersion
})

const nativeUpgrade = '9.0.0'
await writeFile(replacementMetadata, JSON.stringify({ version: nativeUpgrade }))
assert.deepEqual(configuration.detectInstallChange(replacementMetadata), {
  kind: 'updated',
  version: nativeUpgrade
})
assert.deepEqual(configuration.detectInstallChange(join(workspace, 'removed-package.json')), {
  kind: 'removed'
})

let releaseRequests = 0
const fetch = globalThis.fetch
globalThis.fetch = async () => {
  releaseRequests += 1
  throw new Error('A bundled engine must not query upstream self-updates')
}
try {
  delete process.env.PI_SKIP_VERSION_CHECK
  assert.equal(await updates.checkForNewPiVersion(sdk.VERSION), undefined)
  assert.equal(releaseRequests, 0)
} finally {
  globalThis.fetch = fetch
}

console.log('✓ upstream SDK version, distribution identity, replacement detection, update guard')
