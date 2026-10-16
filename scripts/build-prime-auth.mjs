import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineLock, fingerprint, prepareSource } from './engines/common.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crateDir = join(root, 'resources', 'prime-auth')
const targetDir = join(root, '.cache', 'prime-auth', 'target')
const outputDir = join(crateDir, 'bin')
const executableName = 'vengeance-prime-auth.exe'
const builtExecutable = join(targetDir, 'release', executableName)
const stagedExecutable = join(outputDir, executableName)
const receiptPath = join(root, '.cache', 'prime-auth', 'build.json')
const nativeSource = await prepareSource('prime', engineLock.prime)
const upstreamUrl = engineLock.prime.repository.replace(/\.git$/, '')
const nativeOverrides = ['pa-ai', 'pa-core', 'pa-daemon', 'pa-types'].flatMap((crate) => [
  '--config',
  `patch."${upstreamUrl}".${crate}.path=${JSON.stringify(join(nativeSource, 'crates', crate))}`
])

function findCargo() {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
  const installedCargo = join(cargoHome, 'bin', 'cargo.exe')

  if (existsSync(installedCargo)) return installedCargo

  const fromPath = spawnSync('cargo', ['--version'], { windowsHide: true })
  if (fromPath.status === 0) return 'cargo'

  throw new Error('Rust cargo is required to build the Prime authentication helper')
}

async function sourceFiles(directory) {
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'bin' || entry.name === 'target') continue

    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

async function sourceFingerprint() {
  const lockfile = join(crateDir, 'Cargo.lock')
  if (!existsSync(lockfile)) {
    throw new Error('resources/prime-auth/Cargo.lock is missing; generate and commit it first')
  }

  const hash = createHash('sha256')
  hash.update(await fingerprint(engineLock.prime))
  const files = [fileURLToPath(import.meta.url), ...(await sourceFiles(crateDir))].sort()

  for (const file of files) {
    hash.update(relative(root, file))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }

  return hash.digest('hex')
}

async function previousFingerprint() {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    return typeof receipt.fingerprint === 'string' ? receipt.fingerprint : null
  } catch {
    return null
  }
}

const cargo = findCargo()
const manifestPath = join(crateDir, 'Cargo.toml')
if (process.argv.includes('--update-lockfile')) {
  const updated = spawnSync(
    cargo,
    ['update', '--workspace', '--offline', '--manifest-path', manifestPath, ...nativeOverrides],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  )
  if (updated.error) throw updated.error
  if (updated.status !== 0) process.exit(updated.status ?? 1)
}
const sourceHash = await sourceFingerprint()

if (existsSync(stagedExecutable) && sourceHash === (await previousFingerprint())) {
  console.log(`Prime authentication helper is current: ${relative(root, stagedExecutable)}`)
  process.exit(0)
}

const args = ['build', '--locked', '--release', '--manifest-path', manifestPath, ...nativeOverrides]

console.log(`Building Prime authentication helper with ${basename(cargo)}`)
const result = spawnSync(cargo, args, {
  cwd: root,
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  stdio: 'inherit',
  windowsHide: true
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

await stat(builtExecutable)
await mkdir(outputDir, { recursive: true })
await copyFile(builtExecutable, stagedExecutable)
await mkdir(dirname(receiptPath), { recursive: true })
await writeFile(receiptPath, JSON.stringify({ fingerprint: sourceHash }, null, 2) + '\n')

console.log(`Staged ${relative(root, stagedExecutable)}`)
