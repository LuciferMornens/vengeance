import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNativeWorkerSocketBudget } from '../qa/lib/app.mjs'
import { recordPackagedTarget } from '../qa/lib/packaged-target.mjs'
import { qaTempDir } from '../qa/lib/tmp.mjs'

const RUN_TEMP_DIRECTORY = '/private/tmp/vq/p-abcdef/vengeance-qa-run-abcdef/tmp'
const BENCHMARK_TEMP_DIRECTORY = '/private/tmp/vq/vengeance-first-navigation-abcdef/tmp'
const SUITE_TEMP_DIRECTORY = '/private/tmp/vq/p-abcdef'

for (const platform of ['darwin', 'linux']) {
  assert.doesNotThrow(() =>
    assertNativeWorkerSocketBudget(SUITE_TEMP_DIRECTORY, { platform, userId: 501 })
  )
  assert.throws(
    () => assertNativeWorkerSocketBudget(undefined, { platform, userId: 501 }),
    /requires an absolute TMPDIR/
  )
  assert.throws(
    () => assertNativeWorkerSocketBudget('relative', { platform, userId: 501 }),
    /requires an absolute TMPDIR/
  )
  assert.throws(
    () => assertNativeWorkerSocketBudget(`/tmp/${'é'.repeat(30)}`, { platform, userId: 501 }),
    /worker socket needs .* Set a shorter QA_TMP_ROOT/
  )
}
assert.throws(
  () => assertNativeWorkerSocketBudget(RUN_TEMP_DIRECTORY, { platform: 'darwin', userId: 501 }),
  /worker socket needs 107 bytes; darwin allows 104/
)
assert.throws(
  () =>
    assertNativeWorkerSocketBudget(BENCHMARK_TEMP_DIRECTORY, { platform: 'darwin', userId: 501 }),
  /worker socket needs 108 bytes; darwin allows 104/
)
assert.doesNotThrow(() =>
  assertNativeWorkerSocketBudget(RUN_TEMP_DIRECTORY, { platform: 'linux', userId: 501 })
)
assert.doesNotThrow(() => assertNativeWorkerSocketBudget('C:\\temporary', { platform: 'win32' }))

const fixture = await qaTempDir('qa-native-temp-check-')
const inheritedExecutable = process.env.QA_PACKAGED_EXE
try {
  const resources = join(fixture, 'resources')
  await mkdir(join(resources, 'engines'), { recursive: true })
  await writeFile(join(resources, 'engines', 'manifest.json'), '{}')
  process.env.QA_PACKAGED_EXE = join(fixture, 'unused-executable')
  const applicationWithDescriptor = (descriptor) => ({
    app: { evaluate: async () => ({ application: { resources } }) },
    invoke: async () => descriptor
  })
  await assert.rejects(
    recordPackagedTarget(
      applicationWithDescriptor({ found: false, error: 'Native discovery failed' })
    ),
    /Native discovery failed/
  )
  await assert.rejects(
    recordPackagedTarget(applicationWithDescriptor({ found: true, mock: false, source: 'custom' })),
    /pi must come from the package/
  )
  await assert.rejects(
    recordPackagedTarget(
      applicationWithDescriptor({ found: true, mock: false, source: 'bundled' })
    ),
    /pi did not return its native entry/
  )
} finally {
  if (inheritedExecutable === undefined) delete process.env.QA_PACKAGED_EXE
  else process.env.QA_PACKAGED_EXE = inheritedExecutable
  await rm(fixture, { recursive: true, force: true })
}

console.log('QA native temp and packaged discovery checks passed')
