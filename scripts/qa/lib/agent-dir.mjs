// A throwaway engine config dir (PI_CODING_AGENT_DIR) wired to the fake LLM. It always lives under
// the QA temp root (lib/tmp.mjs, outside the user's profile) and refuses any path inside the user's
// real ~/.pi/agent.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { API } from './fake-llm.mjs'
import { assertOutsideRealHome, isInside, QA_TMP_ROOT, qaTempDir } from './tmp.mjs'

export const REAL_AGENT_DIR = resolve(homedir(), '.pi', 'agent')

export const FAKE_PROVIDER = 'qa'

export const FAKE_MODELS = Object.freeze({
  /** anthropic-messages, reasoning, levels off…high (budget-based `thinking` param). */
  reasoning: 'qa-reasoning',
  /** anthropic-messages, text + image input, no reasoning. */
  vision: 'qa-vision',
  /** anthropic-messages, 32k context: auto-compaction above 32000 - reserveTokens. */
  small: 'qa-small',
  /** openai-completions, reasoning (`reasoning_effort`) + image input; honors samplingParams. */
  openai: 'qa-openai'
})

/** Dummy per-million-token prices, so cost displays have numbers to show. */
const FAKE_COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
const LARGE_CONTEXT_WINDOW = 200_000
const SMALL_CONTEXT_WINDOW = 32_000

/** Literal key the fake server accepts (and ignores); the engine sends it as x-api-key / Bearer. */
export const FAKE_API_KEY = 'qa-fake-key'

/** The default model list for the fake provider; pass a changed copy as `models` to adjust it. */
export function defaultFakeModels(server) {
  return [
    {
      id: FAKE_MODELS.reasoning,
      name: 'QA Reasoning',
      reasoning: true,
      input: ['text'],
      contextWindow: LARGE_CONTEXT_WINDOW,
      maxTokens: 32_000,
      cost: FAKE_COST
    },
    {
      id: FAKE_MODELS.vision,
      name: 'QA Vision',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: LARGE_CONTEXT_WINDOW,
      maxTokens: 8192,
      cost: FAKE_COST
    },
    {
      id: FAKE_MODELS.small,
      name: 'QA Small Context',
      reasoning: false,
      input: ['text'],
      contextWindow: SMALL_CONTEXT_WINDOW,
      maxTokens: 4096,
      cost: FAKE_COST
    },
    {
      id: FAKE_MODELS.openai,
      name: 'QA OpenAI',
      api: API.openai,
      baseUrl: server.openaiBaseUrl,
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: LARGE_CONTEXT_WINDOW,
      maxTokens: 16_000,
      cost: FAKE_COST
    }
  ]
}

/** Throws unless `path` is inside the QA temp root or the OS temp folder, and outside the real agent dir. */
export function assertTempPath(path) {
  const target = resolve(path)
  const inTemp = isInside(QA_TMP_ROOT, target) || isInside(tmpdir(), target)
  if (isInside(REAL_AGENT_DIR, target) || !inTemp) {
    throw new Error(`QA refuses to write outside the temp folder: ${target}`)
  }
  return target
}

/**
 * Create a temp agent dir whose settings select the fake provider.
 *
 * @param {object} options
 * @param {{ anthropicBaseUrl: string, openaiBaseUrl: string }} options.server from startFakeLlm()
 * @param {object} [options.settings] top-level keys over the defaults (nested objects replace)
 * @param {object[]} [options.models] replaces defaultFakeModels(server)
 * @param {object} [options.provider] extra provider fields (headers, compat, modelOverrides…)
 * @param {Record<string, string | object>} [options.files] relative path   → text or JSON
 */
export async function createAgentDir({ server, settings = {}, models, provider = {}, files = {} }) {
  const root = await qaTempDir('vengeance-qa-agent-')
  const dir = assertTempPath(assertOutsideRealHome(join(root, 'agent')))

  const pathOf = (relativePath) => assertTempPath(join(dir, relativePath))

  async function writeText(relativePath, content) {
    const target = pathOf(relativePath)
    await mkdir(dirname(target), { recursive: true })
    const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`
    await writeFile(target, text, 'utf8')
    return target
  }

  await writeText('settings.json', {
    defaultProvider: FAKE_PROVIDER,
    defaultModel: FAKE_MODELS.reasoning,
    ...settings
  })
  await writeText('models.json', {
    providers: {
      [FAKE_PROVIDER]: {
        name: 'QA Fake',
        baseUrl: server.anthropicBaseUrl,
        api: API.anthropic,
        apiKey: FAKE_API_KEY,
        models: models ?? defaultFakeModels(server),
        ...provider
      }
    }
  })
  for (const [relativePath, content] of Object.entries(files)) {
    await writeText(relativePath, content)
  }

  return {
    dir,
    path: pathOf,
    writeText,
    async readText(relativePath) {
      return readFile(pathOf(relativePath), 'utf8')
    },
    async readJson(relativePath) {
      return JSON.parse(await readFile(pathOf(relativePath), 'utf8'))
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}
