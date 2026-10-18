import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { isTarballSource } from '../../src/shared/package-sources'
import { parseEngineHelp } from '../../src/main/features/launch/flags'
import { isDisabledPackageEntry, packageLabel, setPackageEntryEnabled } from '../../src/main/features/settings/package-source'
import { resourceDisplayName, resourceGroupLabel } from '../../src/main/features/settings/resource-labels'
import type { ResolvedResource } from '../../src/main/features/settings/pi-modules'
import { parseNpmView, npmChangelogUrl } from '../../src/main/features/updates/npm-release'
import { mcpFailureReason } from '../../src/renderer/features/settings/mcp-error'
import { check } from './harness'

await check('ext-9: disabling and enabling a package keeps its per-resource filters', () => {
  const filtered = { source: '../local/pi-qa-tools', extensions: ['-extensions/legacy.ts'], autoload: false }
  const disabled = setPackageEntryEnabled(filtered, false)
  assert.ok(isDisabledPackageEntry(disabled))
  assert.deepEqual(setPackageEntryEnabled(disabled, true), filtered)
  // Disabling twice keeps the filters saved the first time.
  assert.deepEqual(setPackageEntryEnabled(setPackageEntryEnabled(disabled, false), true), filtered)
  // A bare source comes back as a bare source.
  assert.equal(setPackageEntryEnabled(setPackageEntryEnabled('npm:pi-lens', false), true), 'npm:pi-lens')
  // An entry disabled by hand (no saved filters) loads everything again.
  const handDisabled = { source: 'npm:pi-lens', extensions: [], skills: [], prompts: [], themes: [] }
  assert.equal(setPackageEntryEnabled(handDisabled, true), 'npm:pi-lens')
})

await check('ext-11: tarball sources are recognised', () => {
  assert.ok(isTarballSource('D:\\pkgs\\pi-qa-tools-1.2.3.tgz'))
  assert.ok(isTarballSource('npm:./pi-qa-tools-1.2.3.tar.gz '))
  assert.equal(isTarballSource('D:\\pkgs\\pi-qa-tools'), false)
  assert.equal(isTarballSource('npm:pi-tgz-tools'), false)
  // A tarball entry already in settings still gets a readable name (the crash card's Remove action).
  const packages = process.platform === 'win32' ? 'C:\\pkgs' : '/pkgs'
  assert.equal(packageLabel(join(packages, 'pi-qa-tools-1.2.3.tgz')), 'Qa tools')
})

const resource = (path: string, metadata: Partial<ResolvedResource['metadata']>): ResolvedResource => ({
  path,
  enabled: true,
  metadata: { source: 'auto', scope: 'user', origin: 'top-level', ...metadata }
})

await check('ext-5: resource labels drop the file extension of prompts and themes', () => {
  assert.equal(resourceDisplayName(resource(join('a', 'prompts', 'qa-review.md'), {}), 'prompts'), 'qa-review')
  assert.equal(resourceDisplayName(resource(join('a', 'themes', 'qa-theme.json'), {}), 'themes'), 'qa-theme')
  assert.equal(resourceDisplayName(resource(join('a', 'skills', 'qa-skill', 'SKILL.md'), {}), 'skills'), 'qa-skill')
  assert.equal(resourceDisplayName(resource(join('a', 'extensions', 'legacy.ts'), {}), 'extensions'), 'legacy.ts')
})

await check('ext-6: the personal resource folders have distinct group titles', () => {
  const engineFolder = resourceGroupLabel(resource('x', { baseDir: join('home', '.pi', 'agent') }))
  const personalSkills = resourceGroupLabel(resource('x', { baseDir: join('home', '.agents') }))
  const projectFolder = resourceGroupLabel(resource('x', { scope: 'project', baseDir: join('proj', '.pi') }))
  const projectSkills = resourceGroupLabel(resource('x', { scope: 'project', baseDir: join('proj', '.agents') }))
  assert.equal(new Set([engineFolder, personalSkills, projectFolder, projectSkills]).size, 4)
  assert.equal(personalSkills, 'Personal skills (~/.agents)')
})

await check('ext-3: flags of a loose extension file are grouped under that file', () => {
  const help = ['Extension CLI Flags:', `  --qa-mode <value>           QA fixture: run mode label.`, `  --qa-loud                   QA fixture: announce every turn.`, ''].join('\n')
  const fixture = { group: 'qa-fixture', path: join('agent', 'extensions', 'qa-fixture.ts'), text: "pi.registerFlag('qa-mode', {})\npi.registerFlag(\"qa-loud\", {})" }
  const { flags } = parseEngineHelp(help, [], [fixture])
  assert.deepEqual(
    flags.map((flag) => [flag.name, flag.groupLabel]),
    [
      ['qa-mode', 'Qa fixture'],
      ['qa-loud', 'Qa fixture']
    ]
  )
})

await check('ext-12: npm view output gives the version and the serving registry', () => {
  const remote = parseNpmView('{"version":"1.1.0","dist.tarball":"http://127.0.0.1:4873/pkg/-/pkg-1.1.0.tgz"}')
  assert.deepEqual(remote, { version: '1.1.0', registryHost: '127.0.0.1:4873' })
  assert.equal(npmChangelogUrl('pkg', remote), undefined)
  const npmjs = parseNpmView('{"version":"2.0.0","dist.tarball":"https://registry.npmjs.org/pkg/-/pkg-2.0.0.tgz"}')
  assert.equal(npmChangelogUrl('pkg', npmjs), 'https://www.npmjs.com/package/pkg?activeTab=versions')
  assert.deepEqual(parseNpmView('"3.0.0"'), { version: '3.0.0' })
  assert.deepEqual(parseNpmView('npm ERR! 404'), {})
})

await check('ext-15: a failing MCP server shows one short reason', () => {
  const stderr = [
    'write EPIPE',
    'node:internal/modules/cjs/loader:1520',
    '  throw err;',
    '  ^',
    '',
    "Error: Cannot find module 'D:\\work\\missing-server.mjs'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1517:15)',
    '    at node:internal/main/run_main_module:36:49 {',
    "  code: 'MODULE_NOT_FOUND',",
    '  requireStack: []',
    '}',
    '',
    'Node.js v24.19.0'
  ].join('\n')
  assert.equal(mcpFailureReason(stderr), "Cannot find module 'missing-server.mjs'")
  assert.equal(mcpFailureReason(stderr.replace(/\n/g, ' ')), "Cannot find module 'missing-server.mjs'")
  assert.equal(mcpFailureReason('connect ECONNREFUSED 127.0.0.1:9'), 'connect ECONNREFUSED 127.0.0.1:9')
})
