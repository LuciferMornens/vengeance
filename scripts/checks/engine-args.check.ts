import { strict as assert } from 'node:assert'
import { launchOptionsToArgs } from '../../src/shared/api/launch'
import { buildEngineArgs } from '../../src/main/engine/manager'
import { formatEngineArgs } from '../../src/renderer/features/launch/options'
import { check } from './harness'

await check('launchOptionsToArgs: every option maps to its documented flag', () => {
  assert.deepEqual(launchOptionsToArgs(undefined), [])
  assert.deepEqual(
    launchOptionsToArgs({
      noTools: true,
      noBuiltinTools: true,
      tools: ['read', 'bash'],
      excludeTools: ['write'],
      noExtensions: true,
      extensions: ['./a.ts', 'builtin:mcp'],
      noSkills: true,
      skills: ['./s'],
      noPromptTemplates: true,
      promptTemplates: ['./p.md'],
      noContextFiles: true,
      noMcp: true,
      systemPrompt: 'be brief',
      appendSystemPrompt: ['x', 'y'],
      models: ['sonnet', 'gpt-5'],
      offline: true,
      extensionFlags: { 'no-lens': true, plan: 'fast', off: false, empty: '', include: ['a', '', 'b'], none: [] },
      env: { FOO: '1' }
    }),
    [
      '--no-tools',
      '--no-builtin-tools',
      '--tools', 'read,bash',
      '--exclude-tools', 'write',
      '--no-extensions',
      '--extension', './a.ts',
      '--extension', 'builtin:mcp',
      '--no-skills',
      '--skill', './s',
      '--no-prompt-templates',
      '--prompt-template', './p.md',
      '--no-context-files',
      '--no-mcp',
      '--system-prompt', 'be brief',
      '--append-system-prompt', 'x',
      '--append-system-prompt', 'y',
      '--models', 'sonnet,gpt-5',
      '--offline',
      '--no-lens',
      '--plan', 'fast',
      '--include', 'a',
      '--include', 'b'
    ]
  )
})

await check('buildEngineArgs: session flags, trust, bridge extension before launch options, extraArgs last', () => {
  assert.deepEqual(
    buildEngineArgs(
      { cwd: 'C:\\w', sessionPath: 'C:\\s.jsonl', sessionDir: 'C:\\sd', provider: 'anthropic', model: 'sonnet', thinking: 'low', name: 'N', approve: false, launch: { offline: true }, extraArgs: ['--verbose'] },
      'C:\\app\\resources\\bridge\\vengeance-bridge.ts'
    ),
    [
      '--session', 'C:\\s.jsonl',
      '--session-dir', 'C:\\sd',
      '--provider', 'anthropic',
      '--model', 'sonnet',
      '--thinking', 'low',
      '--name', 'N',
      '--no-approve',
      '--extension', 'C:\\app\\resources\\bridge\\vengeance-bridge.ts',
      '--offline',
      '--verbose'
    ]
  )
})

await check('buildEngineArgs: --fork wins over --session/--no-session; no bridge when absent', () => {
  assert.deepEqual(buildEngineArgs({ cwd: 'C:\\w', forkFrom: 'C:\\f.jsonl', sessionPath: 'C:\\s.jsonl', noSession: true, approve: true }), ['--fork', 'C:\\f.jsonl', '--approve'])
  assert.deepEqual(buildEngineArgs({ cwd: 'C:\\w', noSession: true }), ['--no-session'])
})

await check('buildEngineArgs: conversation instructions join the launch prompt flags only with discovered sources', () => {
  const conversationPrompt = { mode: 'append' as const, text: 'Answer in French.', updatedAt: 1 }
  assert.deepEqual(
    buildEngineArgs(
      { cwd: 'C:/w', sessionPath: 'C:/s.jsonl', conversationPrompt, launch: { systemPrompt: 'base', offline: true }, extraArgs: ['--verbose'] },
      'C:/app/bridge.ts',
      { conversationFile: 'C:/data/prompt.md', appendSystemFile: 'C:/data/append.md' }
    ),
    [
      '--session', 'C:/s.jsonl',
      '--extension', 'C:/app/bridge.ts',
      '--system-prompt', 'base',
      '--append-system-prompt', 'C:/data/append.md',
      '--append-system-prompt', 'C:/data/prompt.md',
      '--offline',
      '--verbose'
    ]
  )
  assert.deepEqual(buildEngineArgs({ cwd: 'C:/w', noSession: true, conversationPrompt }), ['--no-session'])
})

await check('formatEngineArgs: plain flags and paths unquoted; quotes escaped as argv parsing reads them', () => {
  assert.equal(formatEngineArgs(['--model', 'anthropic/claude-x', 'C:\\Users\\dev\\work']), '--model anthropic/claude-x C:\\Users\\dev\\work')
  assert.equal(formatEngineArgs(['C:\\Program Files\\x']), '"C:\\Program Files\\x"')
  assert.equal(formatEngineArgs(['say "hi"']), '"say \\"hi\\""')
  // Backslashes before a quote or the closing quote double, so they stay literal.
  assert.equal(formatEngineArgs(['C:\\my dir\\']), '"C:\\my dir\\\\"')
  assert.equal(formatEngineArgs(['a\\"b c']), '"a\\\\\\"b c"')
})
