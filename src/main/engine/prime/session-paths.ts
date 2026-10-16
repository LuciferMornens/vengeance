import { join } from 'node:path'
import { expandPrimePath, primeSettingsPath, readPrimeJson } from './configuration-store'
import { getPrimeAgentDir } from './locate'

export interface PrimeSessionPathOptions {
  agentDir?: string
  env?: Record<string, string>
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
