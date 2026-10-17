import { createTwoFilesPatch } from 'diff'
import type { MockScriptName } from '@shared/api/engine'
import type { AgentMessage, ExtensionUIDialogRequest, ToolResultMessage, UserMessage } from '@shared/engine-types'
import { call, displayDiff, ScriptBuilder, text, uid, type MockStep, type ScriptContext } from './mock-builder'
import { MOCK_FILES } from './mock-data'
import { forwardSlashes, mockHomePath } from './mock-paths'
import { subagents } from './mock-subagents'
import { toolbelt } from './mock-toolbelt'

export type { MockStep, ScriptContext } from './mock-builder'

const OLD_PERSIST = `  private persist = debounce((id: string) => {
    const session = this.sessions.get(id)
    if (session) void writeSessionFile(this.dir, session)
  }, 250)`

const NEW_PERSIST = `  private dirty = new Set<string>()

  private persist(id: string): void {
    this.dirty.add(id)
    this.flush()
  }

  private flush = debounce(() => {
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (session) void writeSessionFile(this.dir, session)
    }
  }, 250)`

const ESC = '\u001b['
const VITEST_LINES = [
  `\n${ESC}1m${ESC}46m RUN ${ESC}49m${ESC}22m ${ESC}36mv3.2.4 ${ESC}39m${ESC}90m${forwardSlashes(mockHomePath('projects', 'aurora'))}${ESC}39m\n\n`,
  ` ${ESC}32m✓${ESC}39m src/session/persist.test.ts ${ESC}2m(${ESC}22m${ESC}2m6 tests${ESC}22m${ESC}2m)${ESC}22m${ESC}32m 11${ESC}2mms${ESC}22m${ESC}39m\n`,
  ` ${ESC}32m✓${ESC}39m src/session/types.test.ts ${ESC}2m(${ESC}22m${ESC}2m3 tests${ESC}22m${ESC}2m)${ESC}22m${ESC}32m 4${ESC}2mms${ESC}22m${ESC}39m\n`,
  ` ${ESC}32m✓${ESC}39m src/session/store.test.ts ${ESC}2m(${ESC}22m${ESC}2m15 tests${ESC}22m${ESC}2m)${ESC}22m${ESC}32m 38${ESC}2mms${ESC}22m${ESC}39m\n`,
  `\n${ESC}2m Test Files ${ESC}22m ${ESC}1m${ESC}32m3 passed${ESC}39m${ESC}22m${ESC}90m (3)${ESC}39m\n${ESC}2m      Tests ${ESC}22m ${ESC}1m${ESC}32m24 passed${ESC}39m${ESC}22m${ESC}90m (24)${ESC}39m\n${ESC}2m   Start at ${ESC}22m 14:32:08\n${ESC}2m   Duration ${ESC}22m 1.84s${ESC}2m (transform 212ms, setup 0ms, collect 391ms, tests 53ms)${ESC}22m\n`
]

const FINAL_ANSWER = `## What was wrong

\`SessionStore.persist\` was a **single debounced function** that only kept the arguments of its *last* call. When two sessions changed inside the same 250 ms window, only the last id reached \`writeSessionFile\` — the earlier write was silently dropped, which is why a quick rename of two sessions could revert one of them.

## The fix

Pending ids now accumulate in a \`dirty\` set, and one debounced \`flush()\` writes all of them:

\`\`\`ts
private persist(id: string): void {
  this.dirty.add(id)
  this.flush()
}
\`\`\`

| File | Change |
| --- | --- |
| \`src/session/store.ts\` | dirty set + batched flush (+12 −3) |
| \`src/session/store.test.ts\` | new regression test |

All **24 tests** pass. \`WorkspaceStore\` uses the same debounce pattern — say the word and I'll apply the same fix there.`

interface MockTask {
  id: number
  subject: string
  status: string
}

/**
 * An rpiv-todo `update` call, its result and the list after it. In RPC mode the Engine drops the
 * extension's overlay (a TUI component), so these results are all the app learns about the list.
 */
function todoUpdate(tasks: MockTask[], id: number, status: string) {
  const next = tasks.map((task) => (task.id === id ? { ...task, status } : task))
  const subject = tasks.find((task) => task.id === id)?.subject
  return {
    call: call('todo', { action: 'update', id, status }),
    result: {
      content: [{ type: 'text' as const, text: `Updated #${id} ${subject}: ${status}.` }],
      details: { action: 'update', params: { id, status }, tasks: next, nextId: tasks.length + 1 }
    },
    tasks: next
  }
}

function showcase(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  let todos: MockTask[] = [
    { id: 1, subject: 'Reproduce the dropped session write', status: 'in_progress' },
    { id: 2, subject: 'Fix debounce in SessionStore.persist', status: 'pending' },
    { id: 3, subject: 'Add a regression test', status: 'pending' }
  ]
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(ctx.prompt)
    const todo = call('todo', {
      action: 'create_many',
      tasks: [
        { subject: 'Reproduce the dropped session write' },
        { subject: 'Fix debounce in SessionStore.persist' },
        { subject: 'Add a regression test' }
      ]
    })
    const message = b.assistant([
      {
        thinking:
          'The user says session titles sometimes revert after renaming two sessions quickly. That smells like a persistence race — most likely a shared debounce that drops earlier arguments. I should read the store, find every caller of persist, then fix and add a test.',
        labelAt: 'thinking'
      },
      { text: "That sounds like a persistence race. I'll plan this out and start with the session store." },
      { tool: todo }
    ])
    const result = b.tool(
      todo,
      {
        content: [{ type: 'text', text: 'Created 3 tasks (#1–#3). #1 is in progress.' }],
        details: { action: 'create_many', tasks: todos, nextId: 4 }
      },
      { durationMs: 3 }
    )
    return { message, results: [result] }
  })

  b.turn(() => {
    const read = call('read', { path: MOCK_FILES.storePath })
    const grep = call('grep', { pattern: 'persist\\(', path: 'src', glob: '*.ts' })
    const message = b.assistant([{ text: 'Reading the store and every place that schedules a write.' }, { tool: read }, { tool: grep }])
    b.label('tool-read')
    const r1 = b.tool(read, text(MOCK_FILES.store), { durationMs: 4 })
    // pi-lens starts the TypeScript server on the first read of a source file.
    b.ui({ type: 'extension_ui_request', id: uid('ui'), method: 'setStatus', statusKey: 'pi-lens-lsp', statusText: `${ESC}32mLSP Active: typescript${ESC}39m` })
    const r2 = b.tool(
      grep,
      {
        content: [
          {
            type: 'text',
            text: [
              'src/session/store.ts:19:    this.persist(id)',
              'src/session/store.ts:23:  private persist = debounce((id: string) => {',
              'src/workspace/store.ts:31:    this.persist(workspace.id)',
              'src/workspace/store.ts:44:  private persist = debounce((id: string) => {'
            ].join('\n')
          }
        ],
        details: {}
      },
      { durationMs: 38 }
    )
    return { message, results: [r1, r2] }
  })

  b.turn(() => {
    const find = call('find', { pattern: '**/*.test.ts', path: 'src' })
    const ls = call('ls', { path: 'src/session' })
    const message = b.assistant([
      {
        text: '`persist` is one debounced function shared by every session, so it only keeps the **last** id per window. Checking the existing tests before changing it.'
      },
      { tool: find },
      { tool: ls }
    ])
    const r1 = b.tool(
      find,
      text(['src/api/client.test.ts', 'src/session/persist.test.ts', 'src/session/types.test.ts', 'src/util/debounce.test.ts', 'src/workspace/store.test.ts'].join('\n')),
      { durationMs: 21 }
    )
    const r2 = b.tool(ls, text(['index.ts', 'persist.test.ts', 'persist.ts', 'store.ts', 'types.test.ts', 'types.ts'].join('\n')), { durationMs: 2 })
    return { message, results: [r1, r2] }
  })

  b.turn(() => {
    const edit = call('edit', { path: MOCK_FILES.storePath, edits: [{ oldText: OLD_PERSIST, newText: NEW_PERSIST }] })
    const reproduced = todoUpdate(todos, 1, 'completed')
    const fixing = todoUpdate(reproduced.tasks, 2, 'in_progress')
    todos = fixing.tasks
    const message = b.assistant([
      { thinking: 'Collect ids in a Set and flush them all from one debounced function. Keep the 250ms window so write volume does not change.' },
      { text: "Confirmed. I'll collect dirty ids and flush them together." },
      { tool: reproduced.call },
      { tool: fixing.call },
      { tool: edit }
    ])
    const todoResults = [
      b.tool(reproduced.call, reproduced.result, { durationMs: 1 }),
      b.tool(fixing.call, fixing.result, { durationMs: 1 })
    ]
    const newStore = MOCK_FILES.store.replace(OLD_PERSIST, NEW_PERSIST)
    const result = b.tool(
      edit,
      {
        content: [{ type: 'text', text: `Successfully replaced 1 block(s) in ${MOCK_FILES.storePath}.` }],
        details: {
          diff: displayDiff(MOCK_FILES.store, newStore),
          patch: createTwoFilesPatch(MOCK_FILES.storePath, MOCK_FILES.storePath, MOCK_FILES.store, newStore, undefined, undefined, { context: 3 }),
          firstChangedLine: 23
        }
      },
      { durationMs: 6 }
    )
    return { message, results: [...todoResults, result] }
  })

  b.turn(() => {
    const write = call('write', { path: MOCK_FILES.testPath, content: MOCK_FILES.test })
    const bash = call('bash', { command: 'npx vitest run src/session', timeout: 120 })
    const fixed = todoUpdate(todos, 2, 'completed')
    const testing = todoUpdate(fixed.tasks, 3, 'in_progress')
    todos = testing.tasks
    const message = b.assistant([
      { text: 'Adding a regression test that updates two sessions inside one debounce window, then running the suite.' },
      { tool: fixed.call },
      { tool: testing.call },
      { tool: write },
      { tool: bash }
    ])
    const todoResults = [
      b.tool(fixed.call, fixed.result, { durationMs: 1 }),
      b.tool(testing.call, testing.result, { durationMs: 1 })
    ]
    const r1 = b.tool(write, text(`Successfully wrote ${Buffer.byteLength(MOCK_FILES.test)} bytes to ${MOCK_FILES.testPath}`), { durationMs: 3 })
    const outputs = VITEST_LINES.map((_, i) => VITEST_LINES.slice(0, i + 1).join(''))
    b.label('bash-running')
    const r2 = b.tool(bash, { content: [{ type: 'text', text: outputs[outputs.length - 1]! }], details: {} }, {
      durationMs: 2140,
      updates: outputs.slice(0, -1).map((output) => ({ content: [{ type: 'text', text: output }], details: {} }))
    })
    return { message, results: [...todoResults, r1, r2] }
  })

  // This turn ends inside the dialog continuation, so it is emitted manually instead of via turn().
  b.emit({ type: 'turn_start' })
  {
    const ask = call('ask_user_question', {
      questions: [
        {
          question: 'WorkspaceStore has the same debounce pattern. Apply the fix there too?',
          header: 'Scope',
          options: [{ label: 'Yes, apply it' }, { label: 'No, just SessionStore' }]
        }
      ]
    })
    const tested = todoUpdate(todos, 3, 'completed')
    const message = b.assistant([
      { text: 'Tests pass. One scope question before I wrap up.' },
      { tool: tested.call },
      { tool: ask }
    ])
    const testedResult = b.tool(tested.call, tested.result, { durationMs: 1 })
    b.emit({ type: 'tool_execution_start', toolCallId: ask.id, toolName: ask.name, args: ask.arguments }, 40)
    const select: ExtensionUIDialogRequest = {
      type: 'extension_ui_request',
      id: uid('ui'),
      method: 'select',
      title: 'WorkspaceStore has the same debounce pattern. Apply the fix there too?',
      options: ['Yes, apply it', 'No, just SessionStore', 'Show me the diff first'],
      timeout: 120_000
    }
    b.label('select').dialog(select, (response) => {
      const answer = response && 'value' in response ? response.value : 'No, just SessionStore'
      const after = new ScriptBuilder(ctx)
      after.ui({
        type: 'extension_ui_request',
        id: uid('ui'),
        method: 'notify',
        message: `Answer recorded: ${answer}`,
        notifyType: 'info'
      })
      const resultMessage: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: ask.id,
        toolName: ask.name,
        content: [{ type: 'text', text: `User has answered your questions: "${select.title}"="${answer}".` }],
        details: { answers: [{ questionIndex: 0, question: select.title, kind: 'option', answer }] },
        isError: false,
        durationMs: 4_210,
        timestamp: Date.now()
      }
      after.emit({ type: 'tool_execution_end', toolCallId: ask.id, toolName: ask.name, result: { content: resultMessage.content, details: resultMessage.details }, isError: false, durationMs: 4_210 }, 60)
      after.emit({ type: 'message_start', message: resultMessage })
      after.emit({ type: 'message_end', message: resultMessage })
      after.emit({ type: 'turn_end', message, toolResults: [testedResult, resultMessage] }, 20)
      finale(after)
      return after.steps
    })
  }
  return b.steps
}

/** Retry → final streamed answer → settle with a threshold compaction. */
function finale(b: ScriptBuilder): void {
  b.emit({ type: 'turn_start' })
  const failed = b.assistant([], 'error', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
  b.emit({ type: 'turn_end', message: failed, toolResults: [] })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: true })
  b.label('retry').emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: '529 overloaded_error: Overloaded'
  })
  b.wait(2000).emit({ type: 'agent_start' })
  b.turn(() => {
    const message = b.assistant(
      [
        { thinking: 'Summarize root cause, the fix, the files touched and the test result. Offer the WorkspaceStore follow-up.' },
        { text: FINAL_ANSWER, labelAt: 'final-text' }
      ],
      'stop'
    )
    b.ui({ type: 'extension_ui_request', id: uid('ui'), method: 'setTitle', title: 'aurora · fix dropped session writes' })
    return { message, results: [] }
  })
  b.emit({ type: 'auto_retry_end', success: true, attempt: 1 })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false }, 20)
  b.label('compaction').emit({ type: 'compaction_start', reason: 'threshold' }, 120)
  b.emit(
    {
      type: 'compaction_end',
      reason: 'threshold',
      result: {
        summary:
          '## Goal\nFix session titles reverting after quick renames.\n\n## Progress\n- Root cause: shared debounce in `SessionStore.persist` dropped earlier ids.\n- Fixed with a dirty set + batched flush; added regression test; 24 tests pass.\n\n## Open\n- Optionally apply the same fix to `WorkspaceStore`.',
        firstKeptEntryId: 'a1f09c3e',
        tokensBefore: 152_340,
        estimatedTokensAfter: 31_200
      },
      aborted: false,
      willRetry: false
    },
    1400
  )
  b.label('settled').emit({ type: 'agent_settled', aborted: false }, 40)
}

function short(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(ctx.prompt)
    const message = b.assistant(
      [
        {
          text: `On it. Here's a quick answer to **"${ctx.prompt.slice(0, 80)}"**:\n\nThe mock engine is replaying a short scripted reply so the interface can be exercised without spending tokens. Switch the mock off to talk to the real engine.`,
          labelAt: 'short-text'
        }
      ],
      'stop'
    )
    return { message, results: [] }
  })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.emit({ type: 'agent_settled', aborted: false }, 20)
  return b.steps
}

/** Base64 SVG "screenshot" used as a user image attachment in the gallery run. */
function mockScreenshot(accent: string, rows: number): string {
  const bars = Array.from({ length: rows }, (_, i) => {
    const y = 46 + i * 26
    const w = 120 + ((i * 53) % 140)
    return `<rect x="92" y="${y}" width="${w}" height="9" rx="4.5" fill="#ffffff" opacity="${i === 1 ? 0.55 : 0.18}"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#121216"/><rect width="76" height="200" fill="#18181d"/><rect x="10" y="14" width="56" height="8" rx="4" fill="${accent}"/><rect x="10" y="34" width="48" height="6" rx="3" fill="#ffffff" opacity="0.2"/><rect x="10" y="48" width="40" height="6" rx="3" fill="#ffffff" opacity="0.2"/><rect x="92" y="14" width="150" height="14" rx="4" fill="#ffffff" opacity="0.32"/>${bars}<circle cx="286" cy="170" r="14" fill="${accent}"/></svg>`
  return Buffer.from(svg).toString('base64')
}

const GALLERY_SUBAGENT_TASK = 'Find every store that debounces persistence and check for last-call-wins bugs.'
const GALLERY_SUBAGENT_RUN = '3d0c40a2-6470-48bf-a70f-0b150a8d12f5'
const GALLERY_SUBAGENT_OUTPUT = `Both stores share \`util/debounce\`. **WorkspaceStore** has the same last-call-wins bug at \`src/workspace/store.ts:44\`; **SettingsStore** debounces a single key, so it is safe.`

const GALLERY_FETCHED = `# debounce | Lodash

Creates a debounced function that delays invoking \`func\` until after \`wait\` milliseconds have elapsed since the last time the debounced function was invoked. Subsequent calls return the result of the **last** \`func\` invocation.`

/** Every remaining card/entry type: images, subagents, web, MCP fallback, edit error, custom, `!cmd`, branch summary, aborted. */
function gallery(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    const user: UserMessage = {
      role: 'user',
      content: [
        { type: 'text', text: ctx.prompt },
        { type: 'image', data: mockScreenshot('#ff6a3d', 5), mimeType: 'image/svg+xml' },
        { type: 'image', data: mockScreenshot('#6ca8ff', 4), mimeType: 'image/svg+xml' }
      ],
      timestamp: Date.now()
    }
    b.emit({ type: 'message_start', message: user })
    b.emit({ type: 'message_end', message: user }, 16)
    b.produced.push(user)
    const subagent = call('subagent', { agent: 'scout', task: GALLERY_SUBAGENT_TASK, async: false })
    const search = call('web_search', { queries: ['lodash debounce trailing call arguments', 'debounce batch keys javascript'] })
    const fetch = call('fetch_content', { url: 'https://lodash.com/docs/4.17.15#debounce' })
    const message = b.assistant(
      [
        { thinking: 'Two screenshots: the sidebar shows the old title after a rename. Check other stores in parallel and confirm debounce semantics upstream.' },
        { text: 'The screenshots match the dropped-write bug. Checking the other stores in parallel and confirming the debounce semantics upstream.' },
        { tool: subagent },
        { tool: search },
        { tool: fetch }
      ],
      'toolUse'
    )
    const results = [
      b.tool(
        subagent,
        {
          content: [{ type: 'text', text: GALLERY_SUBAGENT_OUTPUT }],
          // pi-subagents' foreground (`async: false`) single run: SingleResult + AgentProgress.
          details: {
            mode: 'single',
            runId: GALLERY_SUBAGENT_RUN,
            results: [
              {
                agent: 'scout',
                task: GALLERY_SUBAGENT_TASK,
                exitCode: 0,
                finalOutput: GALLERY_SUBAGENT_OUTPUT,
                model: 'anthropic/claude-haiku-4-5',
                usage: { input: 14_200, output: 1_900, cacheRead: 52_000, cacheWrite: 0, cost: 0.031, turns: 6 },
                progress: { status: 'completed', toolCount: 9, turnCount: 6, tokens: 16_100, durationMs: 21_700, recentTools: [], recentOutput: [] },
                sessionName: 'Debounced stores audit',
                runId: GALLERY_SUBAGENT_RUN,
                index: 0
              }
            ]
          }
        },
        { durationMs: 21_700 }
      ),
      b.tool(
        search,
        {
          content: [{ type: 'text', text: 'Found 3 sources: [Lodash debounce](https://lodash.com/docs/4.17.15#debounce), [MDN setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/setTimeout), [Batching debounced calls](https://kettanaito.com/blog/debounce-vs-throttle)' }],
          details: {},
          structuredContent: {
            queries: [
              {
                query: 'lodash debounce trailing call arguments',
                answer: 'A trailing debounce invokes the function **once** with the arguments of the *last* call in the window; earlier arguments are discarded.',
                results: [
                  { title: 'debounce — Lodash Documentation', url: 'https://lodash.com/docs/4.17.15#debounce', snippet: 'Subsequent calls to the debounced function return the result of the last func invocation.' },
                  { title: 'setTimeout() global function — Web APIs | MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/API/setTimeout', snippet: 'Sets a timer which executes a function once the timer expires.' },
                  { title: 'Debounce vs Throttle: batching keyed updates', url: 'https://kettanaito.com/blog/debounce-vs-throttle', snippet: 'Collect keys in a set and flush them together to avoid dropping intermediate updates.' }
                ]
              }
            ]
          }
        },
        { durationMs: 1_840 }
      ),
      b.tool(fetch, text(GALLERY_FETCHED), { durationMs: 920 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const badEdit = call('edit', {
      path: 'src/workspace/store.ts',
      edits: [{ oldText: '  private persist = debounce((id) => {', newText: '  private persist(id: string): void {' }]
    })
    const issue = call('linear_create_issue', {
      title: 'WorkspaceStore drops debounced writes',
      team: 'APP',
      priority: 2,
      labels: ['bug', 'persistence'],
      description: 'Same last-call-wins debounce as SessionStore (fixed in #482). Apply the dirty-set + flush pattern.'
    })
    const message = b.assistant(
      [
        { text: 'Applying the same fix to `WorkspaceStore` and filing a follow-up for the dispose race.' },
        { tool: badEdit },
        { tool: issue }
      ],
      'toolUse'
    )
    const results = [
      b.tool(
        badEdit,
        text('Could not find the exact text in src/workspace/store.ts. The old text must match exactly including all whitespace and newlines.'),
        { durationMs: 12, isError: true }
      ),
      b.tool(
        issue,
        text(JSON.stringify({ id: 'APP-1287', identifier: 'APP-1287', url: 'https://linear.app/aurora/issue/APP-1287', state: 'Triage', priority: 2 })),
        { durationMs: 640 }
      )
    ]
    return { message, results }
  })
  const lens: AgentMessage = {
    role: 'custom',
    customType: 'pi-lens',
    content: '**2 diagnostics** in `src/workspace/store.ts`\n- `ts(2345)` line 44: Argument of type `string | undefined` is not assignable to `string`.\n- `eslint(no-unused-vars)` line 12: `SessionPatch` is defined but never used.',
    display: true,
    timestamp: Date.now()
  }
  b.emit({ type: 'message_start', message: lens })
  b.emit({ type: 'message_end', message: lens }, 16)
  b.produced.push(lens)
  b.turn(() => {
    const message = b.assistant(
      [{ text: 'The edit missed because the file uses a typed parameter. Filed **APP-1287** so it can land separately; stopping here so you can review.' }],
      'stop'
    )
    return { message, results: [] }
  })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.emit({ type: 'agent_settled', aborted: false }, 20)
  const bash: AgentMessage = {
    role: 'bashExecution',
    command: 'git status --short',
    output: ` ${ESC}31mM${ESC}39m src/session/store.ts\n${ESC}31m??${ESC}39m src/session/store.test.ts\n`,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.now()
  }
  b.emit({ type: 'message_start', message: bash }, 200)
  b.emit({ type: 'message_end', message: bash })
  const branch: AgentMessage = {
    role: 'branchSummary',
    summary: '## Abandoned branch\nTried replacing the debounce with `queueMicrotask`; writes became too chatty (one per keystroke) and was reverted.',
    fromId: null,
    timestamp: Date.now()
  }
  b.emit({ type: 'message_start', message: branch })
  b.emit({ type: 'message_end', message: branch })
  b.emit({ type: 'agent_start' }, 60)
  b.turn(() => {
    b.user('Also bump the package version and draft the changelog entry.')
    const partial = b.assistant([{ text: 'Bumping `package.json` to **0.9.1** and drafting the changelog under' }], 'aborted', 'Request was aborted')
    return { message: partial, results: [] }
  })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.label('settled').emit({ type: 'agent_settled', aborted: true }, 20)
  return b.steps
}

const PS_LISTING = `
    Directory: ${mockHomePath('projects', 'aurora', 'src', 'session')}

Mode                 LastWriteTime         Length Name
----                 -------------         ------ ----
-a---          14.05.2026    14:31           3412 persist.test.ts
-a---          14.05.2026    14:31           5208 store.test.ts
-a---          12.05.2026    09:12            986 types.test.ts
`

const PARITY_DIAGRAM = `Writes now flow through one batched flush:

\`\`\`mermaid
flowchart LR
  rename["rename(id)"] --> dirty[(dirty set)]
  edit["edit(id)"] --> dirty
  dirty --> flush{{"flush() · 250 ms"}}
  flush --> file["writeSessionFile"]
\`\`\`

Every id that changes inside the window reaches the file, so quick renames no longer revert.`

const LINEAR_RESOURCES = JSON.stringify({
  server: 'linear',
  resources: [
    { server: 'linear', uri: 'linear://team/APP', name: 'APP team', mimeType: 'application/json', description: 'Team settings, states and labels' },
    { server: 'linear', uri: 'linear://issue/APP-1287', name: 'APP-1287', mimeType: 'text/markdown', description: 'WorkspaceStore drops debounced writes' },
    { server: 'linear', uri: 'linear://cycle/current', name: 'Current cycle', mimeType: 'application/json' }
  ]
})

/** pi parity tools: PowerShell, tool_search, MCP resources + an MCP tool, codemode with nested calls, a mermaid answer. */
function parity(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  b.emit({ type: 'agent_start' })
  b.turn(() => {
    b.user(ctx.prompt)
    const ps = call('powershell', { command: 'Get-ChildItem src\\session -Filter *.test.ts | Format-Table Mode, LastWriteTime, Length, Name' })
    const message = b.assistant(
      [
        { thinking: 'Windows workspace: list the session tests with PowerShell first, then look for the Linear tools to file the follow-up.' },
        { text: 'Listing the session tests first.' },
        { tool: ps }
      ],
      'toolUse'
    )
    return { message, results: [b.tool(ps, text(PS_LISTING), { durationMs: 640 })] }
  })
  b.turn(() => {
    const search = call('tool_search', { query: 'linear issues', limit: 5 })
    const resources = call('list_mcp_resources', { server: 'linear' })
    const message = b.assistant([{ text: 'Loading the Linear tools and checking what the server exposes.' }, { tool: search }, { tool: resources }], 'toolUse')
    const results = [
      b.tool(
        search,
        {
          content: [{ type: 'text', text: 'Loaded 2 tools. They are available from your next call:\n- linear_search_issues: Search issues by text, team or state\n- linear_create_issue: Create an issue in a team' }],
          details: { loaded: ['linear_search_issues', 'linear_create_issue'] }
        },
        { durationMs: 180 }
      ),
      b.tool(resources, { content: [{ type: 'text', text: LINEAR_RESOURCES }], details: { server: 'linear', tool: 'list_mcp_resources' } }, { durationMs: 410 })
    ]
    return { message, results }
  })
  b.turn(() => {
    const issues = call('linear_search_issues', { query: 'debounce', team: 'APP', state: 'open' })
    const message = b.assistant([{ tool: issues }], 'toolUse')
    const found = JSON.stringify({ issues: [{ identifier: 'APP-1287', title: 'WorkspaceStore drops debounced writes', state: 'Triage', priority: 2 }] }, null, 2)
    return { message, results: [b.tool(issues, { content: [{ type: 'text', text: found }], details: { server: 'linear', tool: 'search_issues' } }, { durationMs: 530 })] }
  })
  b.turn(() => {
    const code = [
      "// @options: {\"timeoutMs\": 30000}",
      "const files = await tools.find({ pattern: '**/*store.ts', path: 'src' })",
      "const hits = await tools.grep({ pattern: 'debounce\\\\(', path: 'src', glob: '*.ts' })",
      "const store = await tools.read({ path: 'src/workspace/store.ts', limit: 40 })",
      'const stale = hits.split(\'\\n\').filter((line) => !line.includes(\'session/\'))',
      'console.log(`${files.split(\'\\n\').length} stores, ${stale.length} unfixed debounce sites`)',
      'return { stale, preview: store.slice(0, 200) }'
    ].join('\n')
    const script = call('codemode', { code })
    const message = b.assistant([{ text: 'Checking every store for the same debounce pattern in one script.' }, { tool: script }], 'toolUse')
    const nested = [
      { name: 'find', args: { pattern: '**/*store.ts', path: 'src' }, out: 'src/session/store.ts\nsrc/workspace/store.ts\nsrc/settings/store.ts', ms: 42 },
      { name: 'grep', args: { pattern: 'debounce\\(', path: 'src', glob: '*.ts' }, out: 'src/workspace/store.ts:44:  private persist = debounce((id: string) => {\nsrc/settings/store.ts:18:  private save = debounce(() => {', ms: 61 },
      { name: 'read', args: { path: 'src/workspace/store.ts', limit: 40 }, out: MOCK_FILES.store.split('\n').slice(0, 40).join('\n'), ms: 9 }
    ].map((n, i) => ({ ...n, id: `${script.id}/${i + 1}` }))
    const calls = nested.map((n) => ({ id: n.id, name: n.name, args: JSON.stringify(n.args), status: 'ok', durationMs: n.ms }))
    const result = b.tool(
      script,
      {
        content: [{ type: 'text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n3 stores, 2 unfixed debounce sites\n{"stale":["src/workspace/store.ts:44","src/settings/store.ts:18"]}' }],
        details: { calls }
      },
      {
        durationMs: 420,
        during: (run) => {
          for (const n of nested) {
            run.emit({ type: 'tool_execution_start', toolCallId: n.id, toolName: n.name, args: n.args, parentToolCallId: script.id }, 60)
            run.emit({ type: 'tool_execution_end', toolCallId: n.id, toolName: n.name, result: text(n.out), isError: false, durationMs: n.ms, parentToolCallId: script.id }, n.ms)
          }
        }
      }
    )
    return { message, results: [result] }
  })
  b.turn(() => {
    const message = b.assistant([{ text: PARITY_DIAGRAM, labelAt: 'parity-text' }], 'stop')
    return { message, results: [] }
  })
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.label('settled').emit({ type: 'agent_settled', aborted: false }, 20)
  return b.steps
}

const MARATHON_TOPICS = ['the session store', 'the settings loader', 'the workspace switcher', 'the export path', 'the retry policy', 'the title sync']

/** A long session (220 short turns, every fifth with a tool call) for transcript performance shots. */
function marathon(ctx: ScriptContext): MockStep[] {
  const b = new ScriptBuilder(ctx)
  b.emit({ type: 'agent_start' })
  for (let i = 1; i <= 220; i++) {
    const topic = MARATHON_TOPICS[i % MARATHON_TOPICS.length]!
    b.turn(() => {
      b.user(i === 1 ? ctx.prompt : `Step ${i}: check ${topic} again.`)
      if (i % 5 === 0) {
        const read = call('read', { path: 'src/session/store.ts', offset: i, limit: 12 })
        const asked = b.assistant([{ text: `Reading ${topic} (step ${i}).` }, { tool: read }], 'toolUse')
        b.tool(read, text(MOCK_FILES.store.split('\n').slice(0, 12).join('\n')), { durationMs: 8 })
        b.emit({ type: 'turn_end', message: asked, toolResults: [] })
        b.emit({ type: 'turn_start' })
      }
      const message = b.assistant([{ text: `Step **${i}** checked: ${topic} still holds. Nothing else changed since step ${i - 1}.` }], 'stop')
      return { message, results: [] }
    })
  }
  b.emit({ type: 'agent_end', messages: [...b.produced], willRetry: false })
  b.label('settled').emit({ type: 'agent_settled', aborted: false }, 20)
  return b.steps
}

export function buildScript(name: MockScriptName, ctx: ScriptContext): MockStep[] {
  if (name === 'gallery') return gallery(ctx)
  if (name === 'parity') return parity(ctx)
  if (name === 'marathon') return marathon(ctx)
  if (name === 'subagents') return subagents(ctx)
  if (name === 'toolbelt') return toolbelt(ctx)
  return name === 'showcase' ? showcase(ctx) : short(ctx)
}
