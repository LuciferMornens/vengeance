import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const staging = join(root, '.engine-staging')
export const bundleRoot = join(staging, 'bundled')
export const engineLock = JSON.parse(await readFile(join(root, 'engines.lock.json'), 'utf8'))

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    ...options
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
  return result.stdout?.toString().trim()
}

export function npm(args, directory, capture = false) {
  const npmCli =
    process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!existsSync(npmCli)) throw new Error('Run engine builds through npm run build:engines')
  return run(process.execPath, [npmCli, ...args], {
    cwd: directory,
    ...(capture ? { stdio: 'pipe' } : {})
  })
}

export function cargoPath() {
  const installed = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo.exe')
  return existsSync(installed) ? installed : 'cargo'
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n')
}

export async function removeStaged(path) {
  const target = resolve(path)
  const inside = relative(staging, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`Refusing to remove a path outside engine staging: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}

export async function fingerprint(engine) {
  const files = [join(root, 'engines.lock.json'), ...engine.patches.map((file) => join(root, file))]
  for (const file of await readdir(join(root, 'scripts/engines'))) {
    if (file.endsWith('.mjs')) files.push(join(root, 'scripts/engines', file))
  }
  const hashes = await Promise.all(files.sort().map(async (file) => sha256(await readFile(file))))
  return sha256(hashes.join('\n'))
}

export async function prepareSource(identity, engine) {
  const patchHash = sha256(
    (await Promise.all(engine.patches.map((file) => readFile(join(root, file))))).join('\n')
  )
  const directory = join(
    staging,
    'source',
    `${identity}-${engine.revision.slice(0, 8)}-${patchHash.slice(0, 8)}`
  )
  const receipt = join(directory, '.vengeance-source.json')
  if (existsSync(receipt)) {
    const saved = JSON.parse(await readFile(receipt, 'utf8'))
    if (saved.sourceHash !== (await sourceHash(directory))) {
      throw new Error(
        `Source checkout changed: ${directory}. Export your edits as a patch before rebuilding.`
      )
    }
    return directory
  }
  if (existsSync(directory))
    throw new Error(`Incomplete source checkout: ${directory}. Inspect it before removing it.`)
  await mkdir(dirname(directory), { recursive: true })
  run('git', ['clone', '--depth', '1', '--branch', engine.tag, engine.repository, directory])
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: directory, stdio: 'pipe' })
  if (revision !== engine.revision)
    throw new Error(`Upstream tag moved: expected ${engine.revision}, got ${revision}`)
  for (const patch of engine.patches) {
    run('git', ['apply', '--check', join(root, patch)], { cwd: directory })
    run('git', ['apply', join(root, patch)], { cwd: directory })
  }
  await writeJson(receipt, { revision, patchHash, sourceHash: await sourceHash(directory) })
  return directory
}

async function sourceHash(directory) {
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: directory,
    stdio: 'pipe'
  })
    .split('\0')
    .filter((file) => file && file !== '.vengeance-source.json')
    .sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update(await readFile(join(directory, file)))
  }
  return hash.digest('hex')
}

export async function download(url, path, expectedHash) {
  if (expectedHash && existsSync(path) && sha256(await readFile(path)) === expectedHash) return
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error(`Checksum mismatch: ${url}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

export async function inventory(directory, prefix = '') {
  const files = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(directory, entry.name)
    const key = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Engine payload must not contain links: ${path}`)
    if (entry.isDirectory()) Object.assign(files, await inventory(path, key))
    else if (entry.isFile()) files[key] = sha256(await readFile(path))
  }
  return files
}
