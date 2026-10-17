import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const staging = join(root, '.engine-staging')
export const bundleRoot = join(staging, 'bundled')
export const engineLock = JSON.parse(await readFile(join(root, 'engines.lock.json'), 'utf8'))
if (engineLock.schemaVersion !== 2) throw new Error('engines.lock.json must use schemaVersion 2')
export const hostKey = `${process.platform}-${process.arch}`

/** The lock's build settings for this machine. Engines and the helper only build for their host. */
export function hostPlatform() {
  const settings = engineLock.platforms[hostKey]
  if (!settings) {
    const supported = Object.keys(engineLock.platforms).join(', ')
    throw new Error(`Engine builds support ${supported}; this host is ${hostKey}`)
  }
  return { key: hostKey, ...settings }
}

export function executableName(name, platform) {
  return platform.startsWith('win32-') ? `${name}.exe` : name
}

/** Manifest fields that depend on the platform: Engine 2's Rust target and executable name. */
export function platformFields(identity, platform) {
  if (identity === 'pi') return { entry: engineLock.pi.entry }
  return {
    target: engineLock.platforms[platform].rustTarget,
    entry: executableName(engineLock.prime.entry, platform)
  }
}

/** PATH entries for operating-system directories only, so checks cannot borrow build tools. */
export function systemPath() {
  if (process.platform !== 'win32') return { PATH: '/usr/bin:/bin' }
  if (!process.env.SystemRoot) throw new Error('SystemRoot is not set')
  const system32 = join(process.env.SystemRoot, 'System32')
  return { PATH: system32, Path: system32 }
}

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

function npmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath
  // Node installs npm beside node.exe on Windows and under <prefix>/lib elsewhere.
  const modules =
    process.platform === 'win32'
      ? join(dirname(process.execPath), 'node_modules')
      : join(dirname(dirname(process.execPath)), 'lib', 'node_modules')
  return join(modules, 'npm', 'bin', 'npm-cli.js')
}

export function npm(args, directory, capture = false) {
  const npmCliPath = npmCli()
  if (!existsSync(npmCliPath)) throw new Error('Run engine builds through npm run build:engines')
  return run(process.execPath, [npmCliPath, ...args], {
    cwd: directory,
    ...(capture ? { stdio: 'pipe' } : {})
  })
}

function rustTool(name) {
  const installed = join(
    process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    'bin',
    executableName(name, hostKey)
  )
  return existsSync(installed) ? installed : name
}

export function cargoPath() {
  return rustTool('cargo')
}

/**
 * Resolves the pinned Rust release. Inside this repository rust-toolchain.toml selects it, so a newer
 * default toolchain cannot silently build the engine or helper.
 */
export function rustToolchain(version) {
  const cargo = cargoPath()
  const rustc = rustTool('rustc')
  let cargoVersion
  let details
  try {
    cargoVersion = run(cargo, ['--version'], { stdio: 'pipe' })
    details = run(rustc, ['-vV'], { stdio: 'pipe' })
  } catch (error) {
    throw new Error(
      `Rust ${version} (cargo and rustc) is required to build Engine 2 and its helper`,
      {
        cause: error
      }
    )
  }
  const release = /^release: (\S+)/m.exec(details)?.[1]
  const host = /^host: (\S+)/m.exec(details)?.[1]
  if (!cargoVersion.startsWith(`cargo ${version} `) || release !== version || !host) {
    throw new Error(
      `Engine 2 and its helper require Rust ${version}; found ${cargoVersion} and rustc ${release}`
    )
  }
  return { cargo, rustc, host, version: details.split('\n')[0].trim() }
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
    if (saved.lineEndings === 'lf') return directory
    // Older checkouts took line endings from the builder's git configuration. This one is unedited.
    console.log(`Replacing ${directory}: it predates host-independent line endings`)
    await removeStaged(directory)
  }
  if (existsSync(directory))
    throw new Error(`Incomplete source checkout: ${directory}. Inspect it before removing it.`)
  await mkdir(dirname(directory), { recursive: true })
  // Repository-local settings keep checkout and patch bytes identical on every host.
  run('git', [
    'clone',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    '--depth',
    '1',
    '--branch',
    engine.tag,
    engine.repository,
    directory
  ])
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: directory, stdio: 'pipe' })
  if (revision !== engine.revision)
    throw new Error(`Upstream tag moved: expected ${engine.revision}, got ${revision}`)
  for (const patch of engine.patches) {
    run('git', ['apply', '--check', join(root, patch)], { cwd: directory })
    run('git', ['apply', join(root, patch)], { cwd: directory })
  }
  await writeJson(receipt, {
    revision,
    patchHash,
    lineEndings: 'lf',
    sourceHash: await sourceHash(directory)
  })
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

// Windows has no executable bit. Elsewhere it is part of the payload, so a lost bit fails verification.
async function executableMark(path) {
  return process.platform !== 'win32' && ((await stat(path)).mode & 0o111) !== 0 ? ':x' : ''
}

export async function inventory(directory, prefix = '') {
  const files = {}
  const entries = await readdir(directory, { withFileTypes: true })
  // Code-unit order keeps payload hashes independent of the host locale.
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const key = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Engine payload must not contain links: ${path}`)
    if (entry.isDirectory()) Object.assign(files, await inventory(path, key))
    else if (entry.isFile())
      files[key] = sha256(await readFile(path)) + (await executableMark(path))
  }
  return files
}
