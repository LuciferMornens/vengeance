import { DEFAULT_ENGINE_ID, type CreateAgentArgs, type EngineId } from '@shared/api/engine'
import {
  launchOptionsToArgs,
  type ExtensionFlagValue,
  type LaunchOptions,
  type PrimeAutonomousConfig,
  type PrimeLaunchOptions
} from '@shared/api/launch'

/** Pure helpers for LaunchOptions: merge workspace defaults, drop empty values, preview engine arguments. */

function cleanList(values: string[] | undefined): string[] | undefined {
  const out = (values ?? []).map((v) => v.trim()).filter(Boolean)
  return out.length > 0 ? out : undefined
}

/** Trim repeated flag values and drop empty ones; a flag with no values left is unset. */
function cleanFlagValue(value: ExtensionFlagValue): ExtensionFlagValue | undefined {
  if (!Array.isArray(value))
    return value === true || (typeof value === 'string' && value.trim() !== '') ? value : undefined
  return cleanList(value)
}

function cleanFlags(
  flags: Record<string, ExtensionFlagValue> | undefined
): Record<string, ExtensionFlagValue> | undefined {
  const entries = Object.entries(flags ?? {}).flatMap(([key, value]) => {
    const clean = cleanFlagValue(value)
    return key.trim() !== '' && clean !== undefined ? [[key.trim(), clean] as const] : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function cleanEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  const entries = Object.entries(env ?? {}).filter(([key]) => key.trim() !== '')
  return entries.length > 0
    ? Object.fromEntries(entries.map(([key, value]) => [key.trim(), value]))
    : undefined
}

function nonnegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function cleanAutonomous(
  options: PrimeAutonomousConfig | undefined
): PrimeAutonomousConfig | undefined {
  if (!options) return undefined
  const gates = {
    commands: cleanList(options.gates?.commands),
    maxRetries: nonnegativeInteger(options.gates?.maxRetries),
    timeoutMs: nonnegativeInteger(options.gates?.timeoutMs)
  }
  const gateEntries = Object.entries(gates).filter(([, value]) => value !== undefined)
  const normalized: PrimeAutonomousConfig = {
    enabled: options.enabled,
    maxContinuations: nonnegativeInteger(options.maxContinuations),
    maxTurns: nonnegativeInteger(options.maxTurns),
    maxTokens: nonnegativeInteger(options.maxTokens),
    timeoutMs: nonnegativeInteger(options.timeoutMs),
    continuationPrompt: options.continuationPrompt?.trim() || undefined,
    subagentKeepAliveMs: nonnegativeInteger(options.subagentKeepAliveMs),
    gates: gateEntries.length > 0 ? Object.fromEntries(gateEntries) : undefined
  }
  const entries = Object.entries(normalized).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function cleanPrimeOptions(
  options: PrimeLaunchOptions | undefined
): PrimeLaunchOptions | undefined {
  if (!options) return undefined
  const normalized: PrimeLaunchOptions = {
    systemPrompt: options.systemPrompt?.trim() ? options.systemPrompt : undefined,
    appendSystemPrompt: cleanList(options.appendSystemPrompt),
    skills: cleanList(options.skills),
    promptTemplates: cleanList(options.promptTemplates),
    models: cleanList(options.models),
    autonomous: cleanAutonomous(options.autonomous)
  }
  const entries = Object.entries(normalized).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** Remove empty values and options belonging to another engine. */
export function normalizeLaunchOptions(
  options: LaunchOptions | undefined,
  engine: EngineId = DEFAULT_ENGINE_ID
): LaunchOptions | undefined {
  if (!options) return undefined
  if (engine === 'prime') {
    const prime = cleanPrimeOptions(options.prime)
    const env = cleanEnv(options.env)
    return prime || env ? { prime, env } : undefined
  }
  const out: LaunchOptions = {
    tools: cleanList(options.tools),
    excludeTools: cleanList(options.excludeTools),
    noTools: options.noTools || undefined,
    noBuiltinTools: options.noBuiltinTools || undefined,
    noExtensions: options.noExtensions || undefined,
    extensions: cleanList(options.extensions),
    noSkills: options.noSkills || undefined,
    skills: cleanList(options.skills),
    noPromptTemplates: options.noPromptTemplates || undefined,
    promptTemplates: cleanList(options.promptTemplates),
    noContextFiles: options.noContextFiles || undefined,
    noMcp: options.noMcp || undefined,
    systemPrompt: options.systemPrompt?.trim() ? options.systemPrompt : undefined,
    appendSystemPrompt: cleanList(options.appendSystemPrompt),
    models: cleanList(options.models),
    offline: options.offline || undefined,
    extensionFlags: cleanFlags(options.extensionFlags),
    env: cleanEnv(options.env)
  }
  const defined = Object.entries(out).filter(([, value]) => value !== undefined)
  return defined.length > 0 ? (Object.fromEntries(defined) as LaunchOptions) : undefined
}

/** Session overrides merge over defaults, including native execution limits and completion checks. */
export function mergeLaunchOptions(
  defaults: LaunchOptions | undefined,
  override: LaunchOptions | undefined,
  engine: EngineId = DEFAULT_ENGINE_ID
): LaunchOptions | undefined {
  if (!defaults) return normalizeLaunchOptions(override, engine)
  if (!override) return normalizeLaunchOptions(defaults, engine)
  return normalizeLaunchOptions(
    {
      ...defaults,
      ...override,
      extensionFlags: { ...defaults.extensionFlags, ...override.extensionFlags },
      prime: {
        ...defaults.prime,
        ...override.prime,
        autonomous: {
          ...defaults.prime?.autonomous,
          ...override.prime?.autonomous,
          gates: {
            ...defaults.prime?.autonomous?.gates,
            ...override.prime?.autonomous?.gates
          }
        }
      },
      env: { ...defaults.env, ...override.env }
    },
    engine
  )
}

/** Quote one argument for display (never executed). */
function quoteArg(arg: string): string {
  return /^[\w@%+=:,./\\*-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

export function formatEngineArgs(args: string[]): string {
  return args.map(quoteArg).join(' ')
}

/**
 * Saved env values reach the renderer masked (main's settings/secrets SECRET_MASK, optionally + the last 4 chars).
 * A mask sent back unchanged keeps the stored value; `engine:reveal-env` reveals it on request.
 */
export const ENV_MASK = '••••'

export function isMaskedEnvValue(value: string): boolean {
  return value.startsWith(ENV_MASK)
}

/** Env values that should be masked in the UI (keys or values that look like credentials). */
export function looksSecret(key: string, value: string): boolean {
  return (
    /(key|token|secret|passw|auth|credential|cookie|session)/i.test(key) ||
    /^(sk-|ghp_|gho_|xox[bp]-|AKIA)/.test(value) ||
    (value.length >= 32 && !/\s/.test(value) && /\d/.test(value))
  )
}

/** The engine flags a session was started with: trust override + structured launch options. */
export function effectiveLaunchArgs(
  args: Pick<CreateAgentArgs, 'engine' | 'approve' | 'launch'>
): string[] {
  if (args.engine === 'prime') return []
  const trust =
    args.approve === true ? ['--approve'] : args.approve === false ? ['--no-approve'] : []
  return [...trust, ...launchOptionsToArgs(args.launch)]
}
