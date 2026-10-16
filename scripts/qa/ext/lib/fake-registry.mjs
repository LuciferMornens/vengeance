// A tiny local npm registry for package install / update-check QA: serves packuments and tarballs
// built with `npm pack` from fixture folders. Point npm at it with `npm_config_registry`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Pack `sourceDir` as `name@version` (package.json name/version overridden) into `outDir`.
 * Returns the tarball bytes.
 */
export function packFixture(sourceDir, { name, version, description }, outDir) {
  const work = mkdtempSync(join(tmpdir(), 'vengeance-qa-pack-'))
  try {
    cpSync(sourceDir, work, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'))
    writeFileSync(
      join(work, 'package.json'),
      JSON.stringify(
        { ...manifest, name, version, description: description ?? manifest.description },
        null,
        2
      )
    )
    const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', outDir], {
      cwd: work,
      shell: true,
      encoding: 'utf8'
    })
      .trim()
      .split(/\r?\n/)
      .pop()
    return readFileSync(join(outDir, file))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Start the registry. `publish(name, version, tarball)` adds a version; `setLatest(name, version)`
 * moves the `latest` dist-tag. Every request is recorded in `requests`.
 */
export async function startFakeRegistry() {
  const packages = new Map()
  const requests = []
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname)
    requests.push({ method: request.method, path })
    const tarball = /^\/(.+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/.exec(path)
    if (tarball) {
      const bytes = packages.get(tarball[1])?.versions.get(tarball[2])?.bytes
      if (!bytes) return void response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      return void response.end(bytes)
    }
    const pkg = packages.get(path.slice(1))
    if (request.method !== 'GET' || !pkg) {
      response.writeHead(404, { 'content-type': 'application/json' })
      return void response.end('{"error":"Not found"}')
    }
    const versions = {}
    for (const [version, { bytes }] of pkg.versions) {
      versions[version] = {
        name: pkg.name,
        version,
        dist: {
          tarball: `${registry.url}/${pkg.name}/-/${pkg.name}-${version}.tgz`,
          shasum: createHash('sha1').update(bytes).digest('hex'),
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        }
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.latest }, versions }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const registry = {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    publish(name, version, bytes) {
      const pkg = packages.get(name) ?? { name, latest: version, versions: new Map() }
      pkg.versions.set(version, { bytes })
      packages.set(name, pkg)
    },
    setLatest(name, version) {
      packages.get(name).latest = version
    },
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  }
  return registry
}
