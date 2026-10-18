import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { EngineLocationInfo } from '@shared/api/engine'
import { childBaseEnv, shellEnvironmentReady } from '../../shell-env'
import { PRIME_CAPABILITIES } from './capabilities'
import { bundledEngine } from '../bundled'
import { bundledPrimeRuntime } from './bundled-runtime'

const executeFile = promisify(execFile)
const VERSION_TIMEOUT_MS = 10_000
const VERSION_OUTPUT_LIMIT = 64 * 1024
const EXECUTABLE_NAME = process.platform === 'win32' ? 'prime-agent.exe' : 'prime-agent'

export interface PrimeEngineLocation {
  executablePath: string
  packageDir: string
  version: string
  source: 'bundled' | 'override' | 'managed'
}

let mockAgentDir: string | undefined
const versions = new Map<string, { modified: number; size: number; version: Promise<string> }>()

export function getPrimeAgentDir(): string {
  const configured = process.env.PRIME_AGENT_CODING_AGENT_DIR
  if (configured) {
    if (configured.startsWith('~/') || configured.startsWith('~\\')) {
      return resolve(homedir(), configured.slice(2))
    }
    return resolve(configured)
  }
  if (process.env.VENGEANCE_MOCK === '1' || process.env.VENGEANCE_MOCK === 'true') {
    mockAgentDir ??= mkdtempSync(join(tmpdir(), 'vengeance-prime-mock-'))
    return mockAgentDir
  }
  return join(homedir(), '.prime', 'agent')
}

async function executableIn(candidate: string): Promise<string | null> {
  try {
    const target = resolve(candidate)
    const metadata = await stat(target)
    if (metadata.isFile()) {
      if (process.platform === 'win32' && !target.toLowerCase().endsWith('.exe')) {
        return executableIn(join(dirname(target), '..', 'share', 'prime-agent'))
      }
      return realpath(target)
    }
    const executable = join(target, EXECUTABLE_NAME)
    return (await stat(executable)).isFile() ? realpath(executable) : null
  } catch {
    return null
  }
}

async function describeExecutable(
  executablePath: string,
  source: PrimeEngineLocation['source']
): Promise<PrimeEngineLocation> {
  const metadata = await stat(executablePath)
  let cached = versions.get(executablePath)
  if (!cached || cached.modified !== metadata.mtimeMs || cached.size !== metadata.size) {
    const version = executeFile(executablePath, ['--version'], {
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_OUTPUT_LIMIT,
      env: { ...childBaseEnv(), PI_PACKAGE_DIR: dirname(executablePath), DO_NOT_TRACK: '1' }
    }).then((result) => {
      const value = /\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/.exec(result.stdout)?.[0]
      if (!value) throw new Error('Engine 2 did not return a valid version')
      return value
    })
    cached = { modified: metadata.mtimeMs, size: metadata.size, version }
    versions.set(executablePath, cached)
    const entry = cached
    void version.catch(() => {
      if (versions.get(executablePath) === entry) versions.delete(executablePath)
    })
    if (versions.size > 16) versions.delete(versions.keys().next().value!)
  }
  const version = await cached.version
  return { executablePath, packageDir: dirname(executablePath), version, source }
}

/** Every Engine 2 spawn locates its executable first, so this waits for the login shell environment. */
export async function locatePrimeEngine(
  overridePath?: string | null
): Promise<PrimeEngineLocation> {
  await shellEnvironmentReady()
  const override = overridePath ?? process.env.VENGEANCE_PRIME_EXECUTABLE
  if (override) {
    const executable = await executableIn(override)
    if (!executable) throw new Error('The selected Engine 2 executable could not be found')
    return describeExecutable(executable, 'override')
  }
  const engine = bundledEngine('prime')
  const location = await describeExecutable(await bundledPrimeRuntime(engine), 'bundled')
  if (location.version !== engine.version)
    throw new Error('The bundled Engine 2 is damaged. Reinstall Vengeance.')
  return location
}

export async function primeEngineInfo(overridePath?: string | null): Promise<EngineLocationInfo> {
  try {
    const location = await locatePrimeEngine(overridePath)
    return {
      engine: 'prime',
      capabilities: PRIME_CAPABILITIES,
      found: true,
      version: location.version,
      packageDir: location.packageDir,
      cliPath: location.executablePath,
      source: location.source,
      mock: false
    }
  } catch (error) {
    return {
      engine: 'prime',
      capabilities: PRIME_CAPABILITIES,
      found: false,
      error: error instanceof Error ? error.message : String(error),
      mock: false
    }
  }
}
