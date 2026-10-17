import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { samePath } from '../../paths'
import { expandPrimePath, primeSettingsPath, readPrimeJson } from './configuration-store'
import { getPrimeAgentDir } from './locate'

export interface PrimeSessionPathOptions {
  agentDir?: string
  env?: Record<string, string>
}

type PrimeSessionPathKind = 'session' | 'artifact' | null

export async function primeSessionPathValidator(
  roots: string[],
  agentDir = getPrimeAgentDir()
): Promise<(path: string) => Promise<PrimeSessionPathKind>> {
  const [canonicalRoots, artifacts] = await Promise.all([
    Promise.all(roots.map((root) => realpath(root).catch(() => null))),
    realpath(join(agentDir, 'session-artifacts')).catch(() => null)
  ])
  return async (path) => {
    if (!isAbsolute(path) || !path.toLowerCase().endsWith('.jsonl')) return null
    const canonical = await realpath(path).catch(() => null)
    if (!canonical) return null
    if (canonicalRoots.some((root) => root && samePath(dirname(canonical), root))) return 'session'
    if (!artifacts) return null
    const parts = relative(artifacts, canonical).split(sep)
    return parts.length === 3 &&
      parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
      parts[1]!.startsWith('sub-') &&
      !isAbsolute(relative(artifacts, canonical))
      ? 'artifact'
      : null
  }
}

export async function supportedPrimeSessionPath(
  path: string,
  roots: string[],
  agentDir = getPrimeAgentDir()
): Promise<PrimeSessionPathKind> {
  return (await primeSessionPathValidator(roots, agentDir))(path)
}

export async function resolvePrimeSessionRoot(
  cwd?: string | null,
  options: PrimeSessionPathOptions = {}
): Promise<string> {
  const environment = { ...process.env, ...options.env }
  const configuredEnvironment =
    environment.PRIME_AGENT_SESSION_DIR || environment.PRIME_AGENT_CODING_AGENT_SESSION_DIR
  const base = cwd ?? process.cwd()
  if (configuredEnvironment) return expandPrimePath(configuredEnvironment, base)
  const agentDir = options.agentDir ?? getPrimeAgentDir()
  const global = await readPrimeJson(join(agentDir, 'settings.json'))
  const project = cwd ? await readPrimeJson(primeSettingsPath('project', cwd)) : undefined
  const configured = project?.data.sessionDir ?? global.data.sessionDir
  return typeof configured === 'string' && configured
    ? expandPrimePath(configured, base)
    : join(agentDir, 'sessions')
}
