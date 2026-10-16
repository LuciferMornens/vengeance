import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { cargoPath, download, removeStaged, root, run, staging } from './common.mjs'

async function verifyRuntimeLibraries(executable) {
  const child = spawn(process.env.OBJDUMP ?? 'objdump', ['-p', executable], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`objdump exited with ${code}`))
    })
  })
  const libraries = []
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  // PE unwind tables can exceed pipe capture limits; only import names need to stay in memory.
  await Promise.all([
    completed,
    (async () => {
      for await (const line of lines) {
        const match = /DLL Name:\s*(\S+)/.exec(line)
        if (match) libraries.push(match[1])
      }
    })()
  ])
  if (!libraries.length || libraries.some((name) => /libgcc|libstdc|libwinpthread/i.test(name))) {
    throw new Error(
      `Engine 2 has unexpected compiler runtime dependencies: ${libraries.join(', ')}`
    )
  }
}

export async function buildPrime(source, output, engine) {
  const buildJobs = Number(process.env.VENGEANCE_NATIVE_BUILD_JOBS ?? 4)
  if (!Number.isSafeInteger(buildJobs) || buildJobs < 1 || buildJobs > 32) {
    throw new Error('VENGEANCE_NATIVE_BUILD_JOBS must be an integer between 1 and 32')
  }
  const cargo = cargoPath()
  const version = run(cargo, ['--version'], { stdio: 'pipe' })
  if (!version.startsWith(`cargo ${engine.rustVersion} `)) {
    throw new Error(`Engine 2 requires Rust ${engine.rustVersion}; found ${version}`)
  }
  const targetDir = join(root, '.cache/prime-auth/target')
  run(
    cargo,
    [
      'build',
      '--release',
      '--locked',
      '--target',
      engine.target,
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
      env: { ...process.env, VENGEANCE_ENGINE_BUILD: engine.version }
    }
  )
  const executable = join(targetDir, engine.target, 'release/prime-agent.exe')
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
  const strippedExecutable = join(packageOutput, 'prime-agent.exe')
  await copyFile(executable, strippedExecutable)
  // GNU's bundled linker tools avoid a build-machine-only compiler DLL dependency.
  const sysroot = run(cargo.replace(/cargo(?:\.exe)?$/, 'rustc.exe'), ['--print', 'sysroot'], {
    stdio: 'pipe'
  })
  const toolDir = join(sysroot, 'lib/rustlib', engine.target, 'bin')
  run(join(toolDir, 'rust-objcopy.exe'), ['--strip-debug', strippedExecutable])
  await verifyRuntimeLibraries(strippedExecutable)
  run(
    process.env.PYTHON ?? 'python',
    [
      'scripts/package_release.py',
      '--binary',
      strippedExecutable,
      '--out-dir',
      packageOutput,
      '--platform',
      'win32-x64',
      '--version',
      engine.version,
      '--catalog-assets',
      catalogs
    ],
    { cwd: source }
  )
  await cp(join(packageOutput, `prime-agent-${engine.version}-win32-x64`), output, {
    recursive: true
  })
  await copyFile(join(source, 'Cargo.lock'), join(output, 'Cargo.lock'))
  await readFile(join(output, 'prime-agent-runtime/src/rlm/repl.py'))
}
