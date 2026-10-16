import type { ProviderInfo } from '@shared/api/settings'

const PROVIDER_WORDS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  lm: 'LM',
  llm: 'LLM',
  vllm: 'vLLM',
  xai: 'xAI',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  github: 'GitHub',
  deepseek: 'DeepSeek'
}

/** The built-in provider behind Sign in with ChatGPT (also OpenAI API keys). */
export const CHATGPT_PROVIDER = 'openai'
/** The Engine's legacy ChatGPT sign-in through Codex's client ("OpenAI Codex (legacy)"). */
export const CODEX_PROVIDER = 'openai-codex'

type NamedProvider = Pick<ProviderInfo, 'id' | 'name'> & {
  status?: Pick<ProviderInfo['status'], 'usingOAuth'>
}

/**
 * UI name of a provider: the catalog name, or a readable form of a bare id ("lm-studio" → "LM Studio"). The two
 * ChatGPT sign-ins read as ChatGPT: `openai` signed in with ChatGPT is "ChatGPT" (with an API key it stays "OpenAI"),
 * the legacy Codex sign-in is "ChatGPT · Codex".
 */
export function providerName(p: NamedProvider): string {
  if (p.id === CODEX_PROVIDER) return 'ChatGPT · Codex'
  if (p.id === CHATGPT_PROVIDER && p.status?.usingOAuth) return 'ChatGPT'
  if (p.name && p.name !== p.id) return p.name
  return p.id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => PROVIDER_WORDS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * The plan a sign-in uses, from the OAuth name's parenthetical without the word "subscription":
 * "OpenAI (ChatGPT Plus/Pro)" → "ChatGPT Plus/Pro"; "Kimi Code (subscription)" → null.
 */
export function signInPlan(p: Pick<ProviderInfo, 'oauth'>): string | null {
  const parenthetical = p.oauth?.name.match(/\(([^)]*)\)\s*$/)?.[1]
  if (!parenthetical) return null

  const plan = parenthetical
    .replace(/\bsubscription\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null
}
