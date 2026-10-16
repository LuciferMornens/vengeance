import { strict as assert } from 'node:assert'
import type {
  AgentMessage,
  AssistantMessage,
  CustomMessage,
  ToolCall,
  UserMessage
} from '../../src/shared/engine-types'
import { SUBAGENT_WAKE_PREFIX, supervisorReplyPrompt } from '../../src/shared/subagents'
import { summarizeCalls } from '../../src/renderer/features/chat/activity-summary'
import { buildEntryItems, segmentItems } from '../../src/renderer/features/chat/transcript-items'
import {
  describeSubagentPeek,
  humanizeCommand,
  isBenignFailure,
  reasonLine,
  splitLensVerdict,
  stripCdPrefix,
  toolCallKind,
  toolKind,
  toolPhase
} from '../../src/renderer/features/tools/tool-utils'
import type { ToolExecution, TranscriptEntry } from '../../src/renderer/store/agent-state'
import { check } from './harness'

// ─── Lens verdicts ───────────────────────────────────────────────────────────────────────────────

await check('splitLensVerdict: a clean footer leaves the output as body', () => {
  const { body, lens } = splitLensVerdict(
    'Successfully wrote to a.ts\n\n\u2713 JavaScript/TypeScript clean \u00b7 3682ms'
  )
  assert.equal(body, 'Successfully wrote to a.ts')
  assert.deepEqual(lens?.ok, ['JavaScript/TypeScript'])
  assert.equal(lens?.issues, 0)
})

await check('splitLensVerdict: STOP block counts issues and keeps the first one', () => {
  const text =
    "Successfully replaced 1 block(s) in a.ts.\n\n\u{1F534} STOP \u2014 3 issue(s) must be fixed:\n  L49: 'cn' is declared but its value is never read.\n      \u2192 import { cn } from './cn'\n\u{1F7E1} 2 warning(s):\n  L3: unused"
  const { body, lens } = splitLensVerdict(text)
  assert.equal(body, 'Successfully replaced 1 block(s) in a.ts.')
  assert.equal(lens?.issues, 3)
  assert.equal(lens?.warnings, 2)
  assert.equal(lens?.firstIssue, "L49 'cn' is declared but its value is never read.")
})

await check('splitLensVerdict: "Post-apply analysis:" alone is a lens block', () => {
  const { body, lens } = splitLensVerdict('done\n\nPost-apply analysis:')
  assert.equal(body, 'done')
  assert.ok(lens)
})

await check('splitLensVerdict: output without a footer is untouched', () => {
  const text = 'line 1\n  indented\nline 3'
  assert.deepEqual(splitLensVerdict(text), { body: text, lens: null })
})

// ─── Shell commands ──────────────────────────────────────────────────────────────────────────────

await check('stripCdPrefix: another folder becomes the dir chip', () => {
  assert.deepEqual(
    stripCdPrefix(
      'cd "D:/coding/vengeance-lanes/s-platform" && npm run typecheck',
      'C:\\Users\\dev\\projects\\aurora'
    ),
    {
      command: 'npm run typecheck',
      dir: 'D:/coding/vengeance-lanes/s-platform'
    }
  )
})

await check('stripCdPrefix: the session cwd (either slash style) is dropped without a chip', () => {
  assert.deepEqual(
    stripCdPrefix('cd C:/Users/dev/projects/aurora; ls', 'C:\\Users\\dev\\projects\\aurora'),
    { command: 'ls' }
  )
})

await check('stripCdPrefix: a bare cd stays as the command', () => {
  assert.deepEqual(stripCdPrefix('cd src', undefined), { command: 'cd src' })
})

const RUN_A = '0e38f601-1c30-4021-a60c-fa0d664c5cda'
const RUN_B = 'ec99fe3f-84d9-415a-89f9-0ecae8f1fba6'
const RUNS_DIR = 'C:/Users/dev/AppData/Local/Temp/pi-subagents-user-qa/async-subagent-runs'

await check('describeSubagentPeek: tail/sleep/echo of run output logs is a peek', () => {
  assert.deepEqual(describeSubagentPeek(`tail -c 900 "${RUNS_DIR}/${RUN_A}/output-0.log"`), {
    runIds: [RUN_A],
    waitedS: undefined
  })
  assert.deepEqual(
    describeSubagentPeek(
      `sleep 30; tail -c 300 "${RUNS_DIR}/${RUN_A}/output-0.log"; echo; tail -c 200 "${RUNS_DIR}/${RUN_B}/output-0.log"`
    ),
    {
      runIds: [RUN_A, RUN_B],
      waitedS: 30
    }
  )
  assert.deepEqual(
    describeSubagentPeek(`sleep 45; tail -c 500 "${RUNS_DIR}/${RUN_B}/output-0.log" 2>&1`),
    { runIds: [RUN_B], waitedS: 45 }
  )
})

await check('describeSubagentPeek: a command that also does other work is not a peek', () => {
  assert.equal(
    describeSubagentPeek(`git log --oneline -5; tail -c 600 "${RUNS_DIR}/${RUN_A}/output-0.log"`),
    null
  )
  assert.equal(describeSubagentPeek('tail -c 600 app.log'), null)
  assert.equal(
    toolCallKind(call('bash', { command: `tail -c 600 "${RUNS_DIR}/${RUN_A}/output-0.log"` })),
    'manage'
  )
  assert.equal(toolCallKind(call('bash', { command: 'tail -c 600 app.log' })), 'run')
})

await check('humanizeCommand: run files become run references, outside paths …/parent/name', () => {
  assert.deepEqual(
    humanizeCommand(`git status; tail -c 600 "${RUNS_DIR}/${RUN_A}/output-0.log"`, 'D:\\coding'),
    ['git status; tail -c 600 ', { runId: RUN_A }]
  )
  assert.deepEqual(
    humanizeCommand(
      'ls "C:/Users/dev/.pi/agent/install/docs" D:/coding/vengeance/src',
      'D:\\coding'
    ),
    ['ls "\u2026/install/docs" vengeance/src']
  )
  assert.deepEqual(humanizeCommand('curl https://example.com/a/b', undefined), [
    'curl https://example.com/a/b'
  ])
})

await check(
  'reasonLine: the first error-like line, else the last line that is not a version banner',
  () => {
    assert.equal(
      reasonLine('[eval]:3\nthrow new Error("boom")\nError: boom\n    at x\n\nNode.js v24.19.0'),
      'throw new Error("boom")'
    )
    assert.equal(
      reasonLine('a.txt\nb.txt\nv24.19.0\n11.6.2\ngit version 2.55.0.windows.3'),
      'b.txt'
    )
    assert.equal(
      reasonLine(
        "[eval]:35\nif (!ok) throw 'nomatch'\n                     ^\nnomatch\n(Use `node --trace-uncaught ...` to show where the exception was thrown)\n\nNode.js v24.19.0"
      ),
      'nomatch'
    )
    assert.equal(reasonLine(''), '')
  }
)

function failedShell(command: string, output: string): [ToolCall, ToolExecution] {
  const shell = call('bash', { command })
  return [
    shell,
    {
      toolCallId: shell.id,
      toolName: 'bash',
      args: shell.arguments,
      status: 'error',
      isError: true,
      result: { content: [{ type: 'text', text: output }], details: {} }
    }
  ]
}

await check(
  'isBenignFailure: grep -c with zero matches and a child with no command are not failures',
  () => {
    assert.equal(
      isBenignFailure(
        ...failedShell('npm run typecheck 2>&1 | grep -c error', '0\n\nCommand exited with code 1')
      ),
      true
    )
    assert.equal(
      isBenignFailure(...failedShell('rg TODO src', '(no output)\n\nCommand exited with code 1')),
      true
    )
    assert.equal(
      isBenignFailure(...failedShell('grep -c error log.txt', '3\n\nCommand exited with code 1')),
      false
    )
    assert.equal(
      isBenignFailure(...failedShell('grep x a | wc -l', '\n\nCommand exited with code 1')),
      false
    )
    assert.equal(
      isBenignFailure(...failedShell('npm test', 'FAIL\n\nCommand exited with code 1')),
      false
    )
    const command = call('subagent', { action: 'command.status', id: RUN_A })
    const noController =
      'No command controller is available for this child. Command controls require a local native Pi child with bash.'
    const execution: ToolExecution = {
      toolCallId: command.id,
      toolName: 'subagent',
      args: command.arguments,
      status: 'error',
      isError: true,
      result: { content: [{ type: 'text', text: noController }], details: {} }
    }
    assert.equal(isBenignFailure(command, execution), true)
    assert.equal(
      isBenignFailure(call('subagent', { action: 'status', id: RUN_A }), execution),
      false
    )
  }
)

await check('toolPhase: pi bash output ending in "Command aborted" is stopped, not failed', () => {
  const execution = (text: string): ToolExecution => ({
    toolCallId: 't',
    toolName: 'bash',
    args: {},
    status: 'error',
    isError: true,
    result: { content: [{ type: 'text', text }], details: {} }
  })
  assert.equal(
    toolPhase(execution(`${'vite dev server output\n'.repeat(30)}\nCommand aborted`), false),
    'aborted'
  )
  assert.equal(toolPhase(execution('Command exited with code 1'), false), 'error')
})

// ─── Group summaries ─────────────────────────────────────────────────────────────────────────────

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    type: 'toolCall',
    id: `${name}-${Math.random().toString(36).slice(2)}`,
    name,
    arguments: args
  }
}

await check('toolKind: plumbing tools are hidden', () => {
  for (const name of ['subagents_enable', 'pi_lens_activate_tools', 'web_enable'])
    assert.equal(toolKind(name), 'hidden')
  assert.equal(toolKind('bash'), 'run')
})

await check(
  'summarizeCalls: counts explore, lens, web, edits, commands, delegation, todos and history',
  () => {
    const calls = [
      call('read', { path: 'a.ts' }),
      call('read', { path: 'a.ts' }),
      call('read', { path: 'b.ts' }),
      call('grep', { pattern: 'x' }),
      call('lens_diagnostics'),
      call('web_search'),
      call('bash', { command: 'ls' }),
      call('subagent', { agent: 'worker', task: 't' }),
      call('subagent', { agent: 'reviewer', task: 't' }),
      call('subagent', { action: 'status', id: 'r' }),
      call('todo', { action: 'create' }),
      call('history_recall', { query: 'q' })
    ]
    assert.equal(
      summarizeCalls(calls, {}, false),
      'Explored 2 files \u00b7 1 search \u00b7 1 code check \u00b7 1 web lookup \u00b7 ran 1 command \u00b7 delegated to worker, reviewer \u00b7 checked on agent \u00b7 updated todos \u00b7 searched history'
    )
    assert.equal(summarizeCalls([call('bash'), call('bash')], {}, true), 'Running 2 commands')
  }
)

await check(
  'summarizeCalls: agent management is named per action, repeats collapse, the rest folds',
  () => {
    const labelFor = (runId: string) => ({ [RUN_A]: 'worker', [RUN_B]: 'reviewer' })[runId]
    const reply = call('subagent_supervisor', {
      action: 'reply',
      replyTo: 'q1',
      message: 'Option A'
    })
    const executions: Record<string, ToolExecution> = {
      [reply.id]: {
        toolCallId: reply.id,
        toolName: 'subagent_supervisor',
        args: {},
        status: 'done',
        isError: false,
        result: { content: [], details: { agent: 'worker', runId: RUN_A } }
      }
    }
    const steer = () => call('subagent', { action: 'steer', id: RUN_A, message: 'go' })
    assert.equal(
      summarizeCalls([reply, steer()], executions, false, labelFor),
      'Answered worker \u00b7 told worker'
    )
    assert.equal(summarizeCalls([steer(), steer()], {}, false, labelFor), 'Told worker \u00d72')
    const peek = call('bash', {
      command: `sleep 30; tail -c 300 "${RUNS_DIR}/${RUN_A}/output-0.log"; tail -c 200 "${RUNS_DIR}/${RUN_B}/output-0.log"`
    })
    assert.equal(
      summarizeCalls(
        [
          peek,
          call('bash', { command: 'ls' }),
          call('subagent', { action: 'command.status', id: RUN_B }),
          call('subagent', { action: 'list' })
        ],
        {},
        false,
        labelFor
      ),
      'Ran 1 command \u00b7 peeked at worker, reviewer \u00b7 checked reviewer\u2019s command \u00b7 +1 more'
    )
    assert.equal(
      summarizeCalls(
        [call('bg_wait'), call('subagent', { action: 'status', id: RUN_B })],
        {},
        true,
        labelFor
      ),
      'Waiting for background agents \u00b7 checking on reviewer'
    )
  }
)

// ─── Transcript items: subagent notices, wake and reply prompts ──────────────────────────────────

const ASSISTANT_BASE = {
  api: 'x',
  provider: 'p',
  model: 'm',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  timestamp: 0
}

function user(content: string): UserMessage {
  return { role: 'user', content, timestamp: 0 }
}

function assistant(text: string): AssistantMessage {
  return {
    ...ASSISTANT_BASE,
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop'
  }
}

function notice(customType: string): CustomMessage {
  return {
    role: 'custom',
    customType,
    content: 'Background task completed: **worker**',
    display: true,
    timestamp: 0
  }
}

function entries(messages: AgentMessage[]): TranscriptEntry[] {
  return messages.map((message, i) => ({ key: `e${i}`, message }) as TranscriptEntry)
}

await check('buildEntryItems: consecutive notices fold into one item and absorb the wake', () => {
  const { items } = buildEntryItems(
    entries([
      user('go'),
      assistant('launched'),
      notice('subagent-notify'),
      notice('subagent_control_notice'),
      user(`${SUBAGENT_WAKE_PREFIX} Answer pending supervisor requests.`),
      assistant('done')
    ])
  )
  const kinds = items.map((item) => item.kind)
  assert.deepEqual(kinds, ['user', 'text', 'subagent-notices', 'text'])
  const notices = items[2]
  assert.ok(notices?.kind === 'subagent-notices' && notices.notices.length === 2)
})

await check(
  'buildEntryItems: adjacent thinking blocks of a turn are one item; a visible item between them splits it',
  () => {
    const thinking = (thought: string): AssistantMessage => ({
      ...ASSISTANT_BASE,
      role: 'assistant',
      content: [{ type: 'thinking', thinking: thought }],
      stopReason: 'toolUse'
    })
    const { items } = buildEntryItems(
      entries([user('go'), thinking('a'), thinking('b'), assistant('text'), thinking('c')])
    )
    assert.deepEqual(
      items.map((item) =>
        item.kind === 'thinking' ? item.blocks.map((block) => block.thinking).join('+') : item.kind
      ),
      ['user', 'a+b', 'text', 'c']
    )
  }
)

await check(
  'buildEntryItems: a wake with no notices before it is a divider, not a user bubble',
  () => {
    const { items } = buildEntryItems(
      entries([
        user('go'),
        assistant('ok'),
        user(`${SUBAGENT_WAKE_PREFIX} Answer pending.`),
        assistant('woke')
      ])
    )
    assert.deepEqual(
      items.map((item) => item.kind),
      ['user', 'text', 'wake', 'text']
    )
  }
)

await check('buildEntryItems: the wake and reply prompts are not turn boundaries', () => {
  const prompt = user('fix it')
  const reply = user(supervisorReplyPrompt({ requestId: 'r1', agent: 'worker' }, 'Option A'))
  const { items, tail } = buildEntryItems(
    entries([
      prompt,
      assistant('working'),
      user(`${SUBAGENT_WAKE_PREFIX} x`),
      assistant('woke'),
      reply,
      assistant('relayed')
    ])
  )
  assert.deepEqual(
    items.map((item) => item.kind),
    ['user', 'text', 'wake', 'text', 'supervisor-reply', 'text']
  )
  // One user segment and one open turn whose retry target is the user's own prompt.
  const segments = segmentItems(items)
  assert.equal(segments.filter((segment) => segment.kind === 'user').length, 1)
  assert.equal(tail?.prompt, prompt)
})
