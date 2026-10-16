import type { Model, ThinkingLevel } from '@shared/engine-types'

/**
 * The Engine's model scope (`enabledModels` / `--models` patterns, model-resolver.js `resolveModelScopeFromModels`)
 * resolved against the available models, for the one cycle RPC cannot do: backward (`cycle_model` only goes
 * forward). Patterns are exact ids, globs, or partial ids and names, each with an optional `:thinking` suffix.
 */

export interface ScopedModel {
  model: Model
  /** Explicit level from the pattern's suffix; it overrides the per-model default on a switch. */
  thinkingLevel?: ThinkingLevel
}

const THINKING_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** A dated snapshot id (`claude-sonnet-4-20250514`): partial matches prefer the undated alias. */
const DATED_ID = /-\d{8}$/

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value)
}

function sameModel(a: Model, b: Model): boolean {
  return a.provider === b.provider && a.id === b.id
}

/** A `provider/id` or bare id that names exactly one model (case-insensitive). */
function exactMatch(reference: string, models: Model[]): Model | undefined {
  const wanted = reference.trim().toLowerCase()
  if (!wanted) return undefined
  const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === wanted)
  if (canonical.length > 0) return canonical.length === 1 ? canonical[0] : undefined
  const ids = models.filter((m) => m.id.toLowerCase() === wanted)
  return ids.length === 1 ? ids[0] : undefined
}

/** Exact match, else the best partial id/name match: the newest undated alias, else the newest dated id. */
function partialMatch(pattern: string, models: Model[]): Model | undefined {
  const exact = exactMatch(pattern, models)
  if (exact) return exact
  const wanted = pattern.toLowerCase()
  const matches = models.filter((m) => m.id.toLowerCase().includes(wanted) || m.name.toLowerCase().includes(wanted))
  const aliases = matches.filter((m) => !DATED_ID.test(m.id))
  const pool = aliases.length > 0 ? aliases : matches
  return [...pool].sort((a, b) => b.id.localeCompare(a.id))[0]
}

/** `model[:thinking]`, trying the whole pattern first (ids may contain `:`). */
function parsePattern(pattern: string, models: Model[]): ScopedModel | undefined {
  const model = partialMatch(pattern, models)
  if (model) return { model }
  const colon = pattern.lastIndexOf(':')
  if (colon < 0) return undefined
  const suffix = pattern.slice(colon + 1)
  const scoped = parsePattern(pattern.slice(0, colon), models)
  if (!scoped) return undefined
  return isThinkingLevel(suffix) ? { model: scoped.model, thinkingLevel: suffix } : { model: scoped.model }
}

/** minimatch semantics the Engine relies on: `*` and `?` stay within one `/` segment, `[...]` is a class. */
function globRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) source += '\\['
      else {
        source += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else source += char.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

function globMatches(pattern: string, models: Model[]): ScopedModel[] {
  const colon = pattern.lastIndexOf(':')
  const suffix = colon >= 0 ? pattern.slice(colon + 1) : ''
  const thinkingLevel = isThinkingLevel(suffix) ? suffix : undefined
  const glob = thinkingLevel ? pattern.slice(0, colon) : pattern
  const exact = exactMatch(glob, models)
  if (exact) return [{ model: exact, thinkingLevel }]
  const matcher = globRegExp(glob)
  return models.filter((m) => matcher.test(`${m.provider}/${m.id}`) || matcher.test(m.id)).map((model) => ({ model, thinkingLevel }))
}

/** The models the Engine cycles through for these patterns, in cycle order (patterns order, no duplicates). */
export function resolveModelScope(patterns: string[], models: Model[]): ScopedModel[] {
  const scope: ScopedModel[] = []
  for (const pattern of patterns) {
    const found = /[*?[]/.test(pattern) ? globMatches(pattern, models) : [parsePattern(pattern, models)].filter((s) => s !== undefined)
    for (const scoped of found) if (!scope.some((s) => sameModel(s.model, scoped.model))) scope.push(scoped)
  }
  return scope
}

export interface CycleStep extends ScopedModel {
  /** The cycle stayed within the scope (as the Engine's cycle result reports it). */
  isScoped: boolean
}

/**
 * The model before `current` in the cycle (the Engine's `cycleModel('backward')`): within the scope when the
 * patterns resolve to any model, else among all available models. Undefined when there is nothing to cycle to.
 */
export function previousInCycle(current: Model | undefined, patterns: string[], models: Model[]): CycleStep | undefined {
  const scope = patterns.length > 0 ? resolveModelScope(patterns, models) : []
  const isScoped = scope.length > 0
  const cycle = isScoped ? scope : models.map((model) => ({ model }))
  if (cycle.length <= 1) return undefined
  const index = current ? cycle.findIndex((s) => sameModel(s.model, current)) : -1
  return { ...cycle[(Math.max(index, 0) - 1 + cycle.length) % cycle.length]!, isScoped }
}
