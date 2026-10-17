// Fast offline checks (npm run checks): no Electron, no engine process, no tokens.
//   0. the engines staged for this host (npm run build:engines), or stop with what is missing
//   1. typecheck scripts/checks/*.ts
//   2. typecheck resources/bridge/vengeance-bridge.ts against the bundled engine's .d.ts
//   3. bundle scripts/checks/*.check.ts with esbuild (alias @shared) and run them
// The real-engine bridge check is separate: npm run e2e:bridge.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const cache = join(root, 'node_modules', '.cache', 'vengeance-checks')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const installRoot = join(root, '.engine-staging', 'bundled')
const host = `${process.platform}-${process.arch}`
let failed = 0

function runTsc(project, label) {
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', project], { cwd: root, stdio: 'pipe' })
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}\n${error.stdout?.toString() ?? error.message}`)
  }
}

/** The staged engines' manifest if they were built for this host, else null (after saying why). */
function stagedManifest() {
  const manifestPath = join(installRoot, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(`✗ no engines are staged in ${installRoot}: run npm run build:engines`)
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.platform !== host) {
    console.error(
      `✗ the engines are staged for ${manifest.platform}, not ${host}: run npm run build:engines`
    )
    return null
  }
  return manifest
}

/** The bridge must typecheck against the SDK included in the installer. */
function bundledPiPackage(manifest) {
  const packageDir = manifest.engines.pi?.packageDir
  if (!packageDir) return null
  const dir = join(installRoot, packageDir)
  return existsSync(join(dir, 'dist', 'index.d.ts')) ? dir : null
}

const manifest = stagedManifest()
if (!manifest) process.exit(1)

await rm(cache, { recursive: true, force: true })
await mkdir(cache, { recursive: true })

console.log('▶ typecheck')
runTsc(join(here, 'tsconfig.json'), 'scripts/checks/*.ts')
const pi = bundledPiPackage(manifest)
process.env.VENGEANCE_BUNDLED_ENGINES = installRoot
if (pi) {
  const bridgeProject = join(cache, 'tsconfig.bridge.json')
  await writeFile(
    bridgeProject,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: [],
        paths: {
          '@earendil-works/pi-coding-agent': [join(pi, 'dist', 'index.d.ts')],
          // pi's extension loader resolves the pi-ai root to its compat entry.
          '@earendil-works/pi-ai': [join(pi, '..', 'pi-ai', 'dist', 'compat.d.ts')]
        }
      },
      files: [join(root, 'resources', 'bridge', 'vengeance-bridge.ts')]
    })
  )
  runTsc(bridgeProject, `bridge extension vs bundled engine types (${pi})`)
} else {
  failed++
  console.error('  ✗ bundled engine not found: run npm run build:engines')
}

console.log('▶ checks')
const files = (await readdir(here)).filter((f) => f.endsWith('.check.ts')).sort()
const entry = `${files.map((f) => `console.log('• ${f}')\nawait import('./${f}')`).join('\n')}
import { failures } from './harness.ts'
export default failures()`
const outfile = join(cache, 'checks.mjs')
await build({
  stdin: { contents: entry, resolveDir: here, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  alias: { '@shared': join(root, 'src', 'shared') },
  external: ['electron'],
  logLevel: 'warning'
})
const { default: checkFailures } = await import(pathToFileURL(outfile).href)
failed += checkFailures

console.log(failed ? `✗ ${failed} check(s) failed` : '✓ all checks passed')
process.exit(failed ? 1 : 0)
