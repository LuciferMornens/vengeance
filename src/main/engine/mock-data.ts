import { BRIDGE_COMMANDS, type BridgeToolInfo } from '@shared/api/engine'
import type { Model, RpcSlashCommand, ThinkingLevel } from '@shared/engine-types'

/** Static fixtures for the mock engine (VENGEANCE_MOCK=1). */

function model(
  provider: string,
  id: string,
  name: string,
  opts: {
    reasoning: boolean
    contextWindow: number
    maxTokens: number
    cost: [number, number, number, number]
    api: string
    baseUrl: string
    image?: boolean
  }
): Model {
  const [input, output, cacheRead, cacheWrite] = opts.cost
  return {
    id,
    name,
    api: opts.api,
    provider,
    baseUrl: opts.baseUrl,
    reasoning: opts.reasoning,
    input: opts.image === false ? ['text'] : ['text', 'image'],
    cost: { input, output, cacheRead, cacheWrite },
    contextWindow: opts.contextWindow,
    maxTokens: opts.maxTokens,
    type: 'chat',
    thinkingLevelMap: opts.reasoning
      ? {
          off: null,
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max'
        }
      : undefined
  }
}

const anthropic = { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }
const openai = { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }
const google = {
  api: 'google-generative-ai',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
}

export const MOCK_MODELS: Model[] = [
  model('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', {
    ...anthropic,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: [3, 15, 0.3, 3.75]
  }),
  model('anthropic', 'claude-opus-4-5', 'Claude Opus 4.5', {
    ...anthropic,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: [5, 25, 0.5, 6.25]
  }),
  model('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', {
    ...anthropic,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: [1, 5, 0.1, 1.25]
  }),
  model('openai', 'gpt-5', 'GPT-5', {
    ...openai,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [1.25, 10, 0.125, 0]
  }),
  model('openai', 'gpt-5-mini', 'GPT-5 mini', {
    ...openai,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [0.25, 2, 0.025, 0]
  }),
  model('openai', 'gpt-4.1', 'GPT-4.1', {
    ...openai,
    reasoning: false,
    contextWindow: 1_047_576,
    maxTokens: 32_768,
    cost: [2, 8, 0.5, 0]
  }),
  model('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', {
    ...google,
    reasoning: true,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    cost: [1.25, 10, 0.31, 0]
  }),
  // Response speed: Fast and Ultrafast (gpt-6.1-sol), Fast (gpt-5.5), Fast its provider refuses
  // (gpt-6-sol), Claude fast mode, Engine 2's priority tier (OpenRouter).
  model('openai', 'gpt-6.1-sol', 'GPT-6.1 Sol', {
    ...openai,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [2.5, 15, 0.25, 0]
  }),
  model('openai', 'gpt-5.5', 'GPT-5.5', {
    ...openai,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [1.25, 10, 0.125, 0]
  }),
  model('openai', 'gpt-6-sol', 'GPT-6 Sol', {
    ...openai,
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [2, 12, 0.2, 0]
  }),
  model('openrouter', 'openai/gpt-5.5', 'GPT-5.5 (OpenRouter)', {
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    reasoning: true,
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: [1.25, 10, 0.125, 0]
  }),
  model('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', {
    ...anthropic,
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: [4, 20, 0.4, 5]
  })
]

export function thinkingLevelsFor(m: Model | undefined): ThinkingLevel[] {
  if (!m || !m.reasoning) return ['off']
  return ['off', 'minimal', 'low', 'medium', 'high']
}

function source(
  path: string,
  src: string,
  scope: 'user' | 'project' | 'temporary',
  pkg?: string
): RpcSlashCommand['sourceInfo'] {
  return pkg
    ? { path, source: src, scope, origin: 'package', baseDir: pkg }
    : { path, source: src, scope, origin: 'top-level' }
}

const HOME = 'C:\\Users\\dev\\.pi\\agent'

export const MOCK_COMMANDS: RpcSlashCommand[] = [
  {
    name: 'todos',
    description: 'Show all todos on the current branch',
    source: 'extension',
    sourceInfo: source(
      `${HOME}\\npm\\node_modules\\pi-todos\\dist\\index.js`,
      'npm:pi-todos',
      'user',
      `${HOME}\\npm\\node_modules\\pi-todos`
    )
  },
  {
    name: 'websearch',
    description: 'Open web search curator',
    source: 'extension',
    sourceInfo: source(
      `${HOME}\\npm\\node_modules\\pi-web-access\\dist\\index.js`,
      'npm:pi-web-access',
      'user',
      `${HOME}\\npm\\node_modules\\pi-web-access`
    )
  },
  {
    name: 'lens-health',
    description: 'Show code-health dashboard for the workspace',
    source: 'extension',
    sourceInfo: source(
      `${HOME}\\npm\\node_modules\\pi-lens\\dist\\index.js`,
      'npm:pi-lens',
      'user',
      `${HOME}\\npm\\node_modules\\pi-lens`
    )
  },
  {
    name: 'review',
    description: 'Review the working tree diff and summarize risks',
    source: 'prompt',
    sourceInfo: source(`${HOME}\\prompts\\review.md`, 'local', 'user')
  },
  {
    name: 'fix-tests',
    description: 'Run the test suite and fix failing tests',
    source: 'prompt',
    sourceInfo: source('.pi\\prompts\\fix-tests.md', 'local', 'project')
  },
  {
    name: 'skill:code-deslop',
    description:
      'Remove AI-generated slop from code: redundant comments, dead branches, over-abstraction',
    source: 'skill',
    sourceInfo: source(`${HOME}\\skills\\code-deslop\\SKILL.md`, 'local', 'user')
  },
  {
    name: 'skill:release-notes',
    description: 'Draft release notes from merged commits since the last tag',
    source: 'skill',
    sourceInfo: source('.pi\\skills\\release-notes\\SKILL.md', 'local', 'project')
  }
]

const subagentsPkg = source(
  `${HOME}\\npm\\node_modules\\pi-subagents\\index.js`,
  'npm:pi-subagents',
  'user',
  `${HOME}\\npm\\node_modules\\pi-subagents`
)

/** pi-subagents' host-facing commands (`subagents-inspect-rpc` is hidden from the UI). */
export const MOCK_SUBAGENT_COMMANDS: RpcSlashCommand[] = [
  {
    name: 'subagents-stop',
    description: 'Stop an async subagent run or one of its children',
    source: 'extension',
    sourceInfo: subagentsPkg
  },
  {
    name: 'subagents-steer',
    description: 'Send a steering message to a running async subagent',
    source: 'extension',
    sourceInfo: subagentsPkg
  },
  {
    name: 'subagents-detach',
    description: 'Move the running foreground subagent to the background',
    source: 'extension',
    sourceInfo: subagentsPkg
  },
  {
    name: 'subagents-inspect-rpc',
    description:
      'Host integration bridge: answer an async child inspection request with a correlated widget payload (no model turn)',
    source: 'extension',
    sourceInfo: subagentsPkg
  }
]

/** The bridge extension's hidden commands, as a real engine lists them (filtered out of the UI). */
export const MOCK_BRIDGE_COMMANDS: RpcSlashCommand[] = BRIDGE_COMMANDS.map((name) => ({
  name,
  description: 'Vengeance desktop bridge (internal)',
  source: 'extension',
  sourceInfo: source(
    'C:\\Program Files\\Vengeance\\resources\\bridge\\vengeance-bridge.ts',
    'cli',
    'temporary'
  )
}))

function tool(
  name: string,
  description: string,
  sourceInfo: RpcSlashCommand['sourceInfo'],
  extra: Partial<BridgeToolInfo> = {}
): BridgeToolInfo {
  return { name, description, exposure: 'direct', sourceInfo, ...extra }
}

const builtin = (name: string) => source(`builtin:${name}`, 'builtin', 'user')
const todosPkg = source(
  `${HOME}\\npm\\node_modules\\pi-todos\\dist\\index.js`,
  'npm:pi-todos',
  'user',
  `${HOME}\\npm\\node_modules\\pi-todos`
)
const webPkg = source(
  `${HOME}\\npm\\node_modules\\pi-web-access\\dist\\index.js`,
  'npm:pi-web-access',
  'user',
  `${HOME}\\npm\\node_modules\\pi-web-access`
)
const mcp = source('builtin:mcp', 'builtin', 'user')

/** Tools reported by the bridge's `vengeance-tools get` in mock mode. */
export const MOCK_TOOLS: BridgeToolInfo[] = [
  tool(
    'read',
    'Read a file (text or image) with optional line offset and limit.',
    builtin('read'),
    { annotations: { readOnlyHint: true } }
  ),
  tool('bash', 'Run a shell command in the workspace.', builtin('bash'), {
    annotations: { destructiveHint: true, openWorldHint: true }
  }),
  tool('edit', 'Replace exact text in a file.', builtin('edit'), {
    annotations: { destructiveHint: true }
  }),
  tool('write', 'Create or overwrite a file.', builtin('write'), {
    annotations: { destructiveHint: true }
  }),
  tool('grep', 'Search file contents with ripgrep.', builtin('grep'), {
    annotations: { readOnlyHint: true }
  }),
  tool('find', 'Find files by glob pattern.', builtin('find'), {
    annotations: { readOnlyHint: true }
  }),
  tool('ls', 'List a directory.', builtin('ls'), { annotations: { readOnlyHint: true } }),
  tool('todo', 'Track a todo list on the current branch.', todosPkg),
  tool('web_search', 'Search the web and return curated results.', webPkg, {
    annotations: { readOnlyHint: true, openWorldHint: true }
  }),
  tool(
    'ask_user_question',
    'Ask the user a multiple-choice question.',
    source(`${HOME}\\extensions\\ask-user.ts`, 'local', 'user'),
    { exposure: 'model-only' }
  ),
  tool('mcp__linear__search_issues', 'Search Linear issues.', mcp, {
    exposure: 'codemode',
    namespace: 'mcp__linear',
    annotations: { readOnlyHint: true, openWorldHint: true }
  }),
  tool('mcp__linear__create_issue', 'Create a Linear issue.', mcp, {
    exposure: 'codemode',
    namespace: 'mcp__linear',
    annotations: { openWorldHint: true }
  })
]

export const MOCK_DEFAULT_ACTIVE_TOOLS = [
  'read',
  'bash',
  'edit',
  'write',
  'todo',
  'web_search',
  'ask_user_question'
]

/** File contents used by the showcase run (a small TypeScript app called "aurora"). */
export const MOCK_FILES = {
  storePath: 'src/session/store.ts',
  store: `import { debounce } from '../util/debounce'
import { writeSessionFile } from './persist'
import type { Session, SessionPatch } from './types'

export class SessionStore {
  private sessions = new Map<string, Session>()
  private listeners = new Set<(id: string) => void>()

  constructor(private readonly dir: string) {}

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  update(id: string, patch: SessionPatch): void {
    const current = this.sessions.get(id)
    if (!current) throw new Error(\`Unknown session \${id}\`)
    this.sessions.set(id, { ...current, ...patch, updatedAt: Date.now() })
    this.persist(id)
    this.listeners.forEach((fn) => fn(id))
  }

  private persist = debounce((id: string) => {
    const session = this.sessions.get(id)
    if (session) void writeSessionFile(this.dir, session)
  }, 250)
}
`,
  testPath: 'src/session/store.test.ts',
  test: `import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from './store'
import * as persist from './persist'

describe('SessionStore.persist', () => {
  it('flushes every session updated inside one debounce window', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(persist, 'writeSessionFile').mockResolvedValue()
    const store = SessionStore.withSessions('/tmp/sessions', ['a', 'b'])

    store.update('a', { title: 'Alpha' })
    store.update('b', { title: 'Beta' })
    await vi.runAllTimersAsync()

    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.map(([, s]) => s.id).sort()).toEqual(['a', 'b'])
  })
})
`
}
