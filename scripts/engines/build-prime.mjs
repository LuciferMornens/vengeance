import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  download,
  executableName,
  removeStaged,
  root,
  run,
  rustToolchain,
  staging
} from './common.mjs'
import { nativeBuildEnvironment, signAdHoc, verifyNativeExecutable } from './native.mjs'

/**
 * Produces the executable the release packer ships, plus Linux's separate split-debug decoder.
 * Only Windows strips after linking; rewriting a Mach-O would invalidate its signature.
 */
async function shippedExecutable({ source, built, packageOutput, engine, platform, toolchain }) {
  const name = executableName('prime-agent', platform.key)
  if (process.platform === 'linux') {
    // Upstream's release split: one linked image yields the shipped ELF and its decoder.
    const dist = join(packageOutput, 'dist')
    run(
      toolchain.python,
      [
        'scripts/release/split_debug.py',
        '--binary',
        built,
        '--shipped',
        join(dist, name),
        '--out',
        dist,
        '--version',
        engine.version,
        '--target',
        platform.rustTarget
      ],
      { cwd: source }
    )
    return {
      executable: join(dist, name),
      decoder: join(dist, `prime-agent-${engine.version}-${platform.key}.debug.gz`)
    }
  }
  const executable = join(packageOutput, name)
  await copyFile(built, executable)
  if (process.platform === 'win32') {
    // GNU's bundled linker tools avoid a build-machine-only compiler DLL dependency.
    const sysroot = run(toolchain.rustc, ['--print', 'sysroot'], { stdio: 'pipe' })
    const tools = join(sysroot, 'lib', 'rustlib', toolchain.host, 'bin')
    run(join(tools, 'rust-objcopy.exe'), ['--strip-debug', executable])
  }
  return { executable }
}

export async function buildPrime(source, output, engine, platform) {
  const buildJobs = Number(process.env.VENGEANCE_NATIVE_BUILD_JOBS ?? 4)
  if (!Number.isSafeInteger(buildJobs) || buildJobs < 1 || buildJobs > 32) {
    throw new Error('VENGEANCE_NATIVE_BUILD_JOBS must be an integer between 1 and 32')
  }
  const toolchain = {
    ...rustToolchain(engine.rustVersion),
    python: process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  }
  const targetDir = join(root, '.cache/prime-auth/target')
  run(
    toolchain.cargo,
    [
      'build',
      '--release',
      '--locked',
      '--target',
      platform.rustTarget,
      '--target-dir',
      targetDir,
      `-j${buildJobs}`,
      '-p',
      'pa-cli',
      '--bin',
      'prime-agent'
    ],
    {
      cwd: source,
      env: { ...nativeBuildEnvironment(), VENGEANCE_ENGINE_BUILD: engine.version }
    }
  )
  const built = join(
    targetDir,
    platform.rustTarget,
    'release',
    executableName('prime-agent', platform.key)
  )
  const catalogs = join(staging, 'catalogs', engine.catalogRevision)
  const catalogBase = `https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent-catalog/${engine.catalogRevision}`
  await download(`${catalogBase}/models/catalog.v1.json`, join(catalogs, 'models.bundled.json'))
  await download(
    `${catalogBase}/plugins/catalog.v2.json`,
    join(catalogs, 'mcp-services.bundled.json')
  )
  const packageOutput = join(staging, 'prime-package')
  await removeStaged(packageOutput)
  await mkdir(packageOutput, { recursive: true })
  const shipped = await shippedExecutable({
    source,
    built,
    packageOutput,
    engine,
    platform,
    toolchain
  })
  // Sign before packaging so every staged copy and recorded hash carries the final bytes.
  if (process.platform === 'darwin') signAdHoc(shipped.executable)
  await verifyNativeExecutable(shipped.executable, platform.key)
  run(
    toolchain.python,
    [
      'scripts/package_release.py',
      '--binary',
      shipped.executable,
      ...(shipped.decoder ? ['--decoder', shipped.decoder] : []),
      '--out-dir',
      packageOutput,
      '--platform',
      platform.key,
      '--version',
      engine.version,
      '--catalog-assets',
      catalogs
    ],
    { cwd: source }
  )
  await cp(join(packageOutput, `prime-agent-${engine.version}-${platform.key}`), output, {
    recursive: true
  })
  await copyFile(join(source, 'Cargo.lock'), join(output, 'Cargo.lock'))
  await readFile(join(output, 'prime-agent-runtime/src/rlm/repl.py'))
}
