import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  engineLock,
  executableName,
  fingerprint,
  hostPlatform,
  prepareSource,
  rustToolchain
} from './engines/common.mjs'
import { nativeBuildEnvironment, signAdHoc, verifyNativeExecutable } from './engines/native.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crateDir = join(root, 'resources', 'prime-auth')
const targetDir = join(root, '.cache', 'prime-auth', 'target')
const outputDir = join(crateDir, 'bin')
const platform = hostPlatform()
const executable = executableName('vengeance-prime-auth', platform.key)
const builtExecutable = join(targetDir, platform.rustTarget, 'release', executable)
const stagedExecutable = join(outputDir, executable)
// The receipt lives beside the helper so a restored resources/prime-auth/bin alone is reusable.
const receiptPath = join(outputDir, 'build.json')
const manifestPath = join(crateDir, 'Cargo.toml')
const upstreamUrl = engineLock.prime.repository.replace(/\.git$/, '')

function nativeOverrides(nativeSource) {
  return ['pa-ai', 'pa-core', 'pa-daemon', 'pa-types'].flatMap((crate) => [
    '--config',
    `patch."${upstreamUrl}".${crate}.path=${JSON.stringify(join(nativeSource, 'crates', crate))}`
  ])
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
  // The engine fingerprint covers the lock and its pinned Rust release, which the build enforces.
  hash.update(await fingerprint(engineLock.prime))
  hash.update(`\0${platform.key}\0${platform.rustTarget}\0`)
  const files = [fileURLToPath(import.meta.url), ...(await sourceFiles(crateDir))].sort()

  for (const file of files) {
    hash.update(relative(root, file))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }

  return hash.digest('hex')
}

async function stagedSha256() {
  return createHash('sha256')
    .update(await readFile(stagedExecutable))
    .digest('hex')
}

async function isCurrent(sourceHash) {
  if (!existsSync(stagedExecutable)) return false
  let receipt
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  } catch {
    return false
  }
  // Windows has no executable bit; elsewhere a restored helper must still be runnable.
  if (process.platform !== 'win32' && !((await stat(stagedExecutable)).mode & 0o111)) return false
  return receipt.fingerprint === sourceHash && receipt.sha256 === (await stagedSha256())
}

function cargo(toolchain, args, env = process.env) {
  const result = spawnSync(toolchain.cargo, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let nativeSource = null
if (process.argv.includes('--update-lockfile')) {
  nativeSource = await prepareSource('prime', engineLock.prime)
  cargo(rustToolchain(engineLock.prime.rustVersion), [
    'update',
    '--workspace',
    '--offline',
    '--manifest-path',
    manifestPath,
    ...nativeOverrides(nativeSource)
  ])
}
const sourceHash = await sourceFingerprint()

// Reuse needs no checkout, network or Rust toolchain, only the staged helper and its receipt.
if (await isCurrent(sourceHash)) {
  console.log(`Prime authentication helper is current: ${relative(root, stagedExecutable)}`)
  process.exit(0)
}

const buildJobs = Number(process.env.VENGEANCE_NATIVE_BUILD_JOBS ?? 4)
if (!Number.isSafeInteger(buildJobs) || buildJobs < 1 || buildJobs > 32) {
  throw new Error('VENGEANCE_NATIVE_BUILD_JOBS must be an integer between 1 and 32')
}
nativeSource ??= await prepareSource('prime', engineLock.prime)
const toolchain = rustToolchain(engineLock.prime.rustVersion)

console.log(
  `Building Prime authentication helper for ${platform.rustTarget} with ${basename(toolchain.cargo)}`
)
cargo(
  toolchain,
  [
    'build',
    '--locked',
    '--release',
    '--target',
    platform.rustTarget,
    `-j${buildJobs}`,
    '--manifest-path',
    manifestPath,
    ...nativeOverrides(nativeSource)
  ],
  { ...nativeBuildEnvironment(), CARGO_TARGET_DIR: targetDir }
)

await stat(builtExecutable)
await mkdir(outputDir, { recursive: true })
await copyFile(builtExecutable, stagedExecutable)
if (process.platform !== 'win32') await chmod(stagedExecutable, 0o755)
if (process.platform === 'darwin') signAdHoc(stagedExecutable)
await verifyNativeExecutable(stagedExecutable, platform.key)
await writeFile(
  receiptPath,
  JSON.stringify(
    {
      fingerprint: sourceHash,
      sha256: await stagedSha256(),
      platform: platform.key,
      target: platform.rustTarget,
      rustc: toolchain.version,
      host: toolchain.host
    },
    null,
    2
  ) + '\n'
)

console.log(`Staged ${relative(root, stagedExecutable)}`)
