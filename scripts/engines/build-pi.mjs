import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { download, npm, removeStaged, run, staging, writeJson } from './common.mjs'
import { signMachOFiles } from './native.mjs'

export async function buildPi(source, output, engine) {
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source)
  const pin = JSON.parse(await readFile(join(source, 'nix/model-catalog.json'), 'utf8'))
  const catalogPath = join(staging, 'catalogs', `${pin.revision}.json`)
  await download(
    `https://pi.dev/api/models/revisions/${pin.revision}?types=chat,image,classifier`,
    catalogPath,
    pin.revision.replace('sha256-', '')
  )
  run(process.execPath, ['packages/ai/scripts/hydrate-model-catalog.ts', catalogPath], {
    cwd: source
  })
  npm(['run', 'build:offline'], source)

  const installRoot = join(source, 'packages/coding-agent/install-lock')
  const lock = JSON.parse(await readFile(join(installRoot, 'package-lock.json'), 'utf8'))
  const artifacts = join(staging, 'pi-packages')
  await removeStaged(artifacts)
  await mkdir(artifacts, { recursive: true })
  const workspacePackages = new Map()
  for (const folder of await readdir(join(source, 'packages'))) {
    const packageDir = join(source, 'packages', folder)
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    workspacePackages.set(metadata.name, packageDir)
  }

  // Keep the upstream runtime lock, substituting every internal package with our source build.
  for (const [path, dependency] of Object.entries(lock.packages)) {
    const name = path.split('node_modules/').at(-1)
    if (!name.startsWith('@earendil-works/')) continue
    const packageDir = workspacePackages.get(name)
    if (!packageDir) throw new Error(`No source workspace for locked engine package: ${name}`)
    const result = JSON.parse(
      npm(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], packageDir, true)
    )
    const tarball = join(artifacts, result[0].filename)
    dependency.resolved = `file:${relative(output, tarball).replaceAll('\\', '/')}`
    dependency.integrity = `sha512-${createHash('sha512')
      .update(await readFile(tarball))
      .digest('base64')}`
  }
  await mkdir(output, { recursive: true })
  await copyFile(join(installRoot, 'package.json'), join(output, 'package.json'))
  await writeJson(join(output, 'package-lock.json'), lock)
  // Vengeance runs the CLI with Electron's Node, never through .bin shims, which are links on POSIX.
  npm(
    [
      'ci',
      '--ignore-scripts',
      '--no-bin-links',
      '--omit=dev',
      '--include=optional',
      '--no-audit',
      '--no-fund'
    ],
    output
  )
  const packagePath = join(output, 'node_modules/@earendil-works/pi-coding-agent/package.json')
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
  metadata.vengeance = {
    version: engine.version,
    upstream: engine.revision,
    updates: 'application'
  }
  await writeJson(packagePath, metadata)
  // pi-tui's prebuilt darwin addons arrive linker-signed (arm64) or unsigned (x64); macOS needs a valid signature.
  if (process.platform === 'darwin') await signMachOFiles(output)
  await copyFile(join(source, 'LICENSE'), join(output, 'LICENSE'))
  await writeFile(
    join(output, 'BUILD-NOTICE.txt'),
    `Vengeance Engine ${engine.version}\nBuilt from ${engine.repository} at ${engine.revision}.\nUpdates are distributed with Vengeance. See manifest.json in the parent directory.\n`
  )
}
