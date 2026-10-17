import { strict as assert } from 'node:assert'
import {
  isNpmPackageName,
  parseManifest,
  parseSearch,
  parseSearchObject,
  webUrl
} from '../../src/main/features/gallery/parse'
import { check } from './harness'

await check('gallery: npm names are validated before any registry request', () => {
  for (const name of ['pi-lens', '@juicesharp/rpiv-todo', 'pi.web_access~2'])
    assert.equal(isNpmPackageName(name), true, name)
  for (const name of ['', '../etc', '@scope', '@scope/../x', 'Pi-Lens', 'a b', 'x'.repeat(215)])
    assert.equal(isNpmPackageName(name), false, name)
})

await check('gallery: links open only as https web pages', () => {
  assert.equal(webUrl('git+https://github.com/a/pi-x.git'), 'https://github.com/a/pi-x')
  assert.equal(webUrl('git://github.com/a/pi-x.git'), 'https://github.com/a/pi-x')
  assert.equal(webUrl('github:a/pi-x'), 'https://github.com/a/pi-x')
  assert.equal(webUrl('bitbucket:a/pi-x'), 'https://bitbucket.org/a/pi-x')
  for (const unsafe of ['http://example.com', 'javascript:alert(1)', 'file:///C:/x', 'https://u:p@x.dev', 7])
    assert.equal(webUrl(unsafe), undefined, String(unsafe))
})

await check('gallery: search results become friendly cards and drop unusable entries', () => {
  const result = parseSearch({
    total: 12188,
    objects: [
      {
        downloads: { weekly: 1520, monthly: 6000 },
        updated: '2026-10-14T09:12:00.000Z',
        package: {
          name: '@scope/pi-web-access',
          version: '0.41.0',
          description: '  Web search for the agent  ',
          keywords: ['pi-package', 'Web', 'web', 'search'],
          license: 'MIT',
          publisher: { username: 'aurora' },
          links: {
            npm: 'https://www.npmjs.com/package/@scope/pi-web-access',
            homepage: 'https://github.com/aurora/pi-web-access#readme',
            repository: 'git+https://github.com/aurora/pi-web-access.git'
          }
        }
      },
      { package: { name: '../evil', version: '1.0.0' } },
      { package: { name: 'pi-no-version' } },
      'not an object'
    ]
  })
  assert.equal(result.total, 12188)
  assert.equal(result.packages.length, 1)
  const [card] = result.packages
  assert.equal(card!.displayName, 'Web access')
  assert.equal(card!.description, 'Web search for the agent')
  assert.deepEqual(card!.keywords, ['web', 'search'])
  assert.equal(card!.weeklyDownloads, 1520)
  assert.equal(card!.publisher, 'aurora')
  assert.equal(card!.repository, 'https://github.com/aurora/pi-web-access')
  assert.equal(card!.npmUrl, 'https://www.npmjs.com/package/@scope/pi-web-access')
  assert.equal(parseSearchObject({ package: { name: 'pi-x', version: '1.0.0', links: { homepage: 'http://x.dev' } } })!.homepage, undefined)
  assert.deepEqual(parseSearch(null), { total: 0, packages: [] })
})

await check('gallery: the manifest says what a package adds', () => {
  const detail = parseManifest('pi-lens', {
    version: '4.4.3',
    pi: { extensions: ['./dist/index.js'], skills: './skills', image: 'https://x.dev/lens.png' },
    dependencies: { a: '1', b: '2' },
    dist: { unpackedSize: 1_250_000 }
  })
  assert.deepEqual(detail.resources, { extensions: true, skills: true, prompts: false, themes: false })
  assert.equal(detail.dependencies, 2)
  assert.equal(detail.unpackedSize, 1_250_000)
  assert.equal(detail.preview, 'https://x.dev/lens.png')
  // Packages that rely on conventional folders declare nothing: the view says so instead of guessing.
  assert.equal(parseManifest('pi-x', { version: '1.0.0', keywords: ['pi-package'] }).resources, null)
  assert.equal(parseManifest('pi-x', { version: '1.0.0', pi: { extensions: [] } }).resources, null)
})
