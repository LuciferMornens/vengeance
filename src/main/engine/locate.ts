import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { electronNodeExecutable } from '../electron-node'
import { childBaseEnv, childEnvVariable, shellEnvironmentReady } from '../shell-env'
import { bundledEngine } from './bundled'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = '@earendil-works/pi-coding-agent'
const MIN_NODE: readonly [number, number] = [22, 19]

/** Where the installed pi engine lives and how to run it. */
export interface EngineLocation {
  /** `<...>/node_modules/@earendil-works/pi-coding-agent` */
  packageDir: string
  /** Absolute path to the CLI entry (`bin.pi` of the package). */
  cliPath: string
  version: string
  source: 'bundled' | 'override' | 'path' | 'managed' | 'npm-global'
  /** Set for managed installs; the launcher passes it to pi as PI_MANAGED_INSTALL_ROOT. */
  managedInstallRoot?: string
  node: NodeRuntime
}

export interface NodeRuntime {
  /** Executable to spawn. */
  path: string
  version: string
  /** Electron's own binary in ELECTRON_RUN_AS_NODE mode (fallback when system node is missing/too old). */
  isElectron: boolean
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Resolve the CLI entry declared by a pi-coding-agent package dir. */
function packageFromDir(packageDir: string): { cliPath: string; version: string } | null {
  const pkg = readJson(join(packageDir, 'package.json'))
  if (!pkg || pkg.name !== PACKAGE_NAME) return null
  const bin = pkg.bin
  const binPath = typeof bin === 'string' ? bin : (bin as Record<string, unknown> | undefined)?.pi
  if (typeof binPath !== 'string') return null
  const cliPath = resolve(packageDir, binPath)
  const rel = relative(packageDir, cliPath)
  if (rel.startsWith('..') || isAbsolute(rel) || !isFile(cliPath)) return null
  const distribution = pkg.vengeance as Record<string, unknown> | undefined
  const version = typeof distribution?.version === 'string' ? distribution.version : pkg.version
  return { cliPath, version: typeof version === 'string' ? version : 'unknown' }
}

/** `<agentDir>/install/current-version` → `<agentDir>/install/releases/<v>/node_modules/<pkg>` (mirrors pi-launcher.js). */
function managedPackageDir(agentDir: string): { packageDir: string; installRoot: string } | null {
  const installRoot = join(agentDir, 'install')
  let current: string
  try {
    current = readFileSync(join(installRoot, 'current-version'), 'utf8').trim()
  } catch {
    return null
  }
  if (!current || current === '.' || current === '..' || !/^[0-9A-Za-z._+-]+$/.test(current))
    return null
  return {
    packageDir: join(installRoot, 'releases', current, 'node_modules', ...PACKAGE_NAME.split('/')),
    installRoot
  }
}

type Found = Omit<EngineLocation, 'node'>

function fromManaged(agentDir: string, source: Found['source']): Found | null {
  const managed = managedPackageDir(agentDir)
  if (!managed) return null
  const pkg = packageFromDir(managed.packageDir)
  if (!pkg) return null
  return { packageDir: managed.packageDir, ...pkg, source, managedInstallRoot: managed.installRoot }
}

/** A bin dir that contains pi (pi.cmd / pi / pi-launcher.js): managed layout or npm-global layout. */
function fromBinDir(binDir: string): Found | null {
  if (existsSync(join(binDir, 'pi-launcher.js'))) {
    const found = fromManaged(dirname(binDir), 'path')
    if (found) return found
  }
  const npmPackageDir = join(binDir, 'node_modules', ...PACKAGE_NAME.split('/'))
  const npmPkg = packageFromDir(npmPackageDir)
  if (npmPkg) return { packageDir: npmPackageDir, ...npmPkg, source: 'npm-global' }
  return null
}

/** Accepts a package dir, a CLI/launcher file, a bin dir, or an agent dir. */
function fromOverride(overridePath: string): Found | null {
  const target = resolve(overridePath)
  const asPackage = packageFromDir(target)
  if (asPackage) return { packageDir: target, ...asPackage, source: 'override' }
  if (isFile(target)) {
    // Walk up from a file inside the package (e.g. dist/bundle/cli.js) or a launcher in a bin dir.
    let dir = dirname(target)
    for (let i = 0; i < 4; i++) {
      const pkg = packageFromDir(dir)
      if (pkg) return { packageDir: dir, ...pkg, source: 'override' }
      dir = dirname(dir)
    }
    const bin = fromBinDir(dirname(target))
    return bin ? { ...bin, source: 'override' } : null
  }
  const bin = fromBinDir(target) ?? fromManaged(target, 'override')
  return bin ? { ...bin, source: 'override' } : null
}

function pathDirs(): string[] {
  return (childEnvVariable('PATH') ?? '').split(delimiter).filter(Boolean)
}

function locatePackage(overridePath: string | null): Found | null {
  if (overridePath) return fromOverride(overridePath)
  const engine = bundledEngine('pi')
  const metadata = packageFromDir(engine.packageDir)
  if (!metadata || metadata.version !== engine.version || metadata.cliPath !== engine.entry) {
    throw new EngineNotFoundError('The bundled Engine is damaged. Reinstall Vengeance.')
  }
  return { ...metadata, packageDir: engine.packageDir, source: 'bundled' }
}

function parseVersion(version: string): [number, number, number] {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

export function nodeSatisfiesEngine(version: string): boolean {
  const [major, minor] = parseVersion(version)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

async function findSystemNode(): Promise<NodeRuntime | null> {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  for (const dir of pathDirs()) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (!isFile(candidate)) continue
      try {
        const { stdout } = await execFileAsync(candidate, ['--version'], {
          env: childBaseEnv(),
          windowsHide: true,
          timeout: 10_000
        })
        const version = stdout.trim()
        if (nodeSatisfiesEngine(version)) return { path: candidate, version, isElectron: false }
      } catch {
        // Broken node shim; keep looking.
      }
    }
  }
  return null
}

function electronNode(): NodeRuntime {
  return { path: electronNodeExecutable(), version: `v${process.versions.node}`, isElectron: true }
}

export class EngineNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineNotFoundError'
  }
}

let cached: { key: string; location: EngineLocation } | null = null

/**
 * Locate pi + a Node runtime able to run it. Cached per override path; pass `refresh` after updates. Every pi
 * spawn locates its engine first, so this waits for the login shell environment (shell-env.ts), which also
 * supplies the PATH a custom location's Node is found on.
 */
export async function locateEngine(
  overridePath: string | null,
  refresh = false
): Promise<EngineLocation> {
  await shellEnvironmentReady()
  const key = overridePath ?? ''
  if (!refresh && cached && cached.key === key) return cached.location
  const found = locatePackage(overridePath)
  if (!found) {
    throw new EngineNotFoundError(`No engine found at ${overridePath}`)
  }
  const node =
    found.source === 'bundled' ? electronNode() : ((await findSystemNode()) ?? electronNode())
  if (!nodeSatisfiesEngine(node.version)) {
    throw new EngineNotFoundError(
      `The engine needs Node ${MIN_NODE.join('.')}+, found ${node.version}.`
    )
  }
  const location: EngineLocation = { ...found, node }
  cached = { key, location }
  return location
}
