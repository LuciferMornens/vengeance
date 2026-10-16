import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Seed a realistic, throwaway engine config for mock mode (VENGEANCE_MOCK=1): settings with packages,
 * fake credentials (never real secrets), custom models, MCP servers, installed package folders with
 * resources, and a stand-in project with overrides. Everything below is read by the real engine SDK.
 */

function write(path: string, content: string | object): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
    'utf8'
  )
}

interface FakePackage {
  dir: string
  name: string
  version: string
  description: string
  homepage: string
  files: Record<string, string>
}

const EXTENSION_STUB = 'export default function (pi) {}\n'

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

function prompt(description: string): string {
  return `---\ndescription: ${description}\n---\n\nReview $@\n`
}

export function seedMockAgentDir(agentDir: string, workspacesDir: string): void {
  write(join(agentDir, 'settings.json'), {
    lastChangelogVersion: '1.1.0',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'high',
    defaultProjectTrust: 'always',
    packages: [
      'npm:pi-web-access',
      'npm:pi-subagents',
      'npm:@juicesharp/rpiv-todo',
      'git:github.com/paoloanzn/pi-black',
      'npm:pi-lens'
    ],
    extensions: ['-builtin:llama.cpp'],
    modelThinkingLevels: { 'anthropic/claude-opus-4-5': 'high', 'openai/gpt-5': 'medium' },
    enabledModels: ['anthropic/*', 'openai/gpt-5*'],
    compaction: {
      reserveTokens: 24000,
      modelOverrides: { 'anthropic/claude-opus-4-5': { reserveTokens: 30000 } }
    },
    retry: { maxRetries: 5 }
  })

  // Fake credentials: an OAuth subscription and a stored API key. Not real secrets.
  write(join(agentDir, 'auth.json'), {
    anthropic: {
      type: 'oauth',
      access: 'mock-access-token',
      refresh: 'mock-refresh-token',
      expires: 4102444800000
    },
    openrouter: { type: 'api_key', key: 'qa-openrouter-value' }
  })

  write(join(agentDir, 'models.json'), {
    providers: {
      ollama: {
        name: 'Ollama',
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        apiKey: 'ollama',
        models: [
          {
            id: 'qwen2.5-coder:32b',
            name: 'Qwen 2.5 Coder 32B',
            contextWindow: 32768,
            maxTokens: 8192,
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          },
          {
            id: 'deepseek-r1:14b',
            name: 'DeepSeek R1 14B',
            contextWindow: 65536,
            maxTokens: 8192,
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      },
      'lm-studio': {
        baseUrl: 'http://localhost:1234/v1',
        api: 'openai-completions',
        apiKey: 'lm-studio',
        models: [
          {
            id: 'mistral-small-3.1',
            contextWindow: 131072,
            maxTokens: 16384,
            input: ['text', 'image']
          }
        ]
      },
      openrouter: {
        modelOverrides: {
          'anthropic/claude-sonnet-4.5': {
            name: 'Sonnet 4.5 (OpenRouter)',
            contextWindow: 200000,
            promptCache: { short: 300, long: 3600 }
          },
          'openai/gpt-5': { maxTokens: 64000, samplingParams: { temperature: 0.4 } }
        }
      }
    }
  })

  write(join(agentDir, 'mcp.json'), {
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        description: 'Read and write files in the project'
      },
      github: {
        url: 'https://api.githubcopilot.com/mcp/',
        headers: {
          Authorization: 'Bearer ${GITHUB_TOKEN}',
          'X-Mock-Team': 'mock-team-secret-0000c0de'
        },
        exposure: 'deferred',
        toolExposure: { search_code: 'direct', 'get_*': 'codemode', 'delete_*': 'hidden' },
        timeout: 90,
        description: 'Issues, pull requests and code search'
      },
      sentry: {
        url: 'https://mcp.sentry.dev/mcp',
        oauth: { clientName: 'Vengeance', callbackPort: 8765 }
      },
      postgres: {
        command: 'uvx',
        args: ['postgres-mcp', '--access-mode=restricted'],
        env: { DATABASE_URI: '${DATABASE_URL}' },
        enabled: false
      }
    }
  })

  write(
    join(agentDir, 'prompts', 'review.md'),
    prompt('Review the working tree diff and summarize risks')
  )
  write(
    join(agentDir, 'prompts', 'changelog.md'),
    prompt('Draft release notes from recent commits')
  )
  write(
    join(agentDir, 'skills', 'release-checklist', 'SKILL.md'),
    skill('release-checklist', 'Walk through the release checklist before tagging')
  )
  write(join(agentDir, 'AGENTS.md'), '# Global instructions\n\nPrefer small, reviewable changes.\n')
  write(
    join(agentDir, 'APPEND_SYSTEM.md'),
    'Always answer in English. Cite file paths with line numbers.\n'
  )
  write(join(agentDir, 'keybindings.json'), {
    'app.session.new': 'ctrl+shift+n',
    'app.session.tree': ['ctrl+shift+t', 'alt+shift+t'],
    'tui.altScreen.pageUp': []
  })
  write(join(agentDir, 'trust.json'), {
    'C:\\Users\\dev\\projects\\ember-api': true,
    'C:\\Users\\dev\\Downloads\\untrusted-repo': false,
    'C:\\Users\\dev\\work': true
  })
  write(
    join(agentDir, 'mcp.log'),
    [
      '2026-07-04T09:12:03.114Z [filesystem] info server: Secure MCP Filesystem Server running on stdio',
      '2026-07-04T09:12:03.402Z [github] info transport: connected (streamable-http)',
      '2026-07-04T09:12:04.950Z [github] debug tools: listed 41 tools, 3 resources',
      '2026-07-04T09:12:05.210Z [sentry] warning auth: 401 Unauthorized, sign-in required',
      '2026-07-04T09:14:41.733Z [filesystem] info tools: read_file {"path":"src/app.ts"}',
      ''
    ].join('\n')
  )

  const npm = join(agentDir, 'npm', 'node_modules')
  const packages: FakePackage[] = [
    {
      dir: join(npm, 'pi-web-access'),
      name: 'pi-web-access',
      version: '0.9.4',
      description: 'Web search, page fetching and a research curator for the agent',
      homepage: 'https://github.com/example/pi-web-access',
      files: {
        'extensions/index.ts': EXTENSION_STUB,
        'skills/web-research/SKILL.md': skill(
          'web-research',
          'Research a topic across several sources and cite them'
        )
      }
    },
    {
      dir: join(npm, 'pi-subagents'),
      name: 'pi-subagents',
      version: '2.3.1',
      description: 'Delegate focused tasks to parallel subagents with their own context',
      homepage: 'https://github.com/example/pi-subagents',
      files: {
        'extensions/subagents.ts': EXTENSION_STUB,
        'prompts/delegate.md': prompt('Split the task and delegate to subagents')
      }
    },
    {
      dir: join(npm, '@juicesharp', 'rpiv-todo'),
      name: '@juicesharp/rpiv-todo',
      version: '1.4.0',
      description: 'A live todo list the agent keeps while it works',
      homepage: 'https://github.com/juicesharp/rpiv-todo',
      files: { 'extensions/todo.ts': EXTENSION_STUB }
    },
    {
      dir: join(npm, 'pi-lens'),
      name: 'pi-lens',
      version: '0.6.2',
      description: 'LSP diagnostics and code-health dashboards inside sessions',
      homepage: 'https://github.com/example/pi-lens',
      files: {
        'extensions/lens.ts': EXTENSION_STUB,
        'themes/lens-dark.json': '{"name":"lens-dark","vars":{},"colors":{}}\n'
      }
    },
    {
      dir: join(agentDir, 'git', 'github.com', 'paoloanzn', 'pi-black'),
      name: 'pi-black',
      version: '0.2.0',
      description: 'Obsidian terminal theme and a code-formatting skill',
      homepage: 'https://github.com/paoloanzn/pi-black',
      files: {
        'themes/black.json': '{"name":"black","vars":{},"colors":{}}\n',
        'skills/format/SKILL.md': skill('format', 'Format changed files with the project formatter')
      }
    }
  ]
  for (const pkg of packages) {
    write(join(pkg.dir, 'package.json'), {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      homepage: pkg.homepage,
      keywords: ['pi-package']
    })
    for (const [file, content] of Object.entries(pkg.files)) write(join(pkg.dir, file), content)
  }

  // Stand-in project for the mock workspace ("aurora") with project-scoped overrides.
  const project = join(workspacesDir, 'aurora')
  write(join(project, '.pi', 'settings.json'), {
    defaultThinkingLevel: 'medium',
    steeringMode: 'all',
    compaction: { keepRecentTokens: 32000 },
    enabledModels: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5']
  })
  write(
    join(project, 'AGENTS.md'),
    '# Aurora\n\nTypeScript monorepo. Run `pnpm test` before committing.\n'
  )
}
