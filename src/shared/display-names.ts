/**
 * Human labels for engine-side identifiers shown in the UI (extension packages, status keys, flags).
 * Pure — importable from main and renderer. Keep technical names (package sources, flag names) as
 * secondary text/tooltips; use these as the primary label (SPEC §9.6: the UI never says "pi").
 */

const ACRONYMS = new Set(['ai', 'api', 'cli', 'css', 'git', 'gh', 'html', 'http', 'id', 'json', 'lsp', 'mcp', 'pr', 'sdk', 'ui', 'url'])
const BRANDS: Record<string, string> = { openai: 'OpenAI', github: 'GitHub', gitlab: 'GitLab', anthropic: 'Anthropic', google: 'Google', codex: 'Codex' }

function word(raw: string, first: boolean): string {
  const lower = raw.toLowerCase()
  if (ACRONYMS.has(lower)) return lower.toUpperCase()
  if (BRANDS[lower]) return BRANDS[lower]
  return first ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
}

/** "pi-lens-lsp" → "Lens LSP", "@scope/pi-web-access" → "Web access", "git:github.com/a/pi-black" → "Black". */
export function friendlyExtensionName(raw: string): string {
  let name = raw.trim()
  name = name.replace(/^npm:/, '').replace(/^(git:|https?:\/\/|ssh:\/\/|git@)/, '')
  name = name.replace(/\.git$/, '').replace(/@[^/@]+$/, '') // trailing version/ref
  name = name.split(/[\\/]/).filter(Boolean).pop() ?? name // last path / scope segment
  name = name.replace(/^(pi|vengeance)[-_.]?(extension[-_]?)?/i, '').replace(/[-_.]?pi$/i, '')
  const words = name.split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return raw
  return words.map((w, i) => word(w, i === 0)).join(' ')
}

/** "no-lens" → "Disable lens", "lens-guard" → "Lens guard" — for extension CLI flags shown as switches. */
export function friendlyFlagName(flag: string): string {
  const bare = flag.replace(/^-+/, '')
  const negated = bare.startsWith('no-')
  const words = (negated ? bare.slice(3) : bare).split(/[-_]+/).filter(Boolean)
  const label = words.map((w, i) => word(w, i === 0 && !negated)).join(' ')
  return negated ? `Disable ${label}` : label
}
