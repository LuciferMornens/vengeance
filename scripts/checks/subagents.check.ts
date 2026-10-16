import { strict as assert } from 'node:assert'
import type { AgentInfo } from '../../src/shared/api/engine'
import type { EngineEvent } from '../../src/shared/engine-types'
import {
  asControlEvent,
  asNotifyDetails,
  asSupervisorRequest,
  isSubagentMessageType,
  parseAsyncSnapshot,
  parseInspectReply,
  parseNotifyContent,
  parseSupervisorReplyPrompt,
  SUBAGENT_ASYNC_PREFIX,
  SUBAGENT_INSPECT_PREFIX,
  supervisorReplyPrompt
} from '../../src/shared/subagents'
import { reduceAgentEvent } from '../../src/renderer/store/agent-reducer'
import { createAgentState } from '../../src/renderer/store/agent-state'
import { isMachinePayload } from '../../src/renderer/lib/machine-payload'
import {
  formatLspStatus,
  hidesIdleLsp,
  isLspActive
} from '../../src/renderer/features/extension-ui/lsp-status'
import {
  activityItems,
  activityLine,
  type ToolActivity
} from '../../src/renderer/features/subagents/activity'
import {
  childSessionAgent,
  runTitle,
  splitSavedOutput
} from '../../src/renderer/features/subagents/format'
import { MOCK_MODELS } from '../../src/main/engine/mock-data'
import { MockSubagentRuntime, subagents } from '../../src/main/engine/mock-subagents'
import { inspectMessages } from '../../src/main/engine/mock-subagents-data'
import { childSessionTitle, generatedChildName } from '../../src/renderer/features/sessions/model'
import { check } from './harness'

const RUN = '967ce01c-715d-4775-925f-e95093f91615'
const info: AgentInfo = {
  agentId: 'a1',
  engine: 'pi',
  cwd: 'C:\\w',
  status: 'ready',
  mock: true,
  busy: false,
  bridge: true,
  createdAt: 0,
  args: { cwd: 'C:\\w' }
}

const snapshotLine = (runs: unknown[]) =>
  `${SUBAGENT_ASYNC_PREFIX}${JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1, generatedAt: 1, caps: {}, omitted: { runs: 0, children: 1, byteLimitExceeded: false }, runs })}`

const NOTIFY_COMPLETED = `Background task completed: **worker**

worker:
I built the Wave 1 foundation on \`main\`.

**Architecture**
- Main process
…
Full output: C:\\Users\\dev\\.pi\\agent\\sessions\\x\\subagent-artifacts\\${RUN}_worker_output.md (4.0 KB, 55 lines). Read it if needed.

Retention-managed async directory: C:\\Users\\dev\\AppData\\Local\\Temp\\async-subagent-runs\\${RUN}

Session file: C:\\Users\\dev\\.pi\\agent\\sessions\\x\\run-0\\session.jsonl

Parent action: Read the saved results above and resume the already-authorized parent task.`

const NOTIFY_FAILED = `Background task failed: **worker**

Subagent timed out after 1800000ms.

Retention-managed async directory: C:\\Users\\dev\\AppData\\Local\\Temp\\async-subagent-runs\\${RUN}

Parent action: Read the saved results above.`

function ui(widgetKey: string, widgetLines: string[] | undefined): EngineEvent {
  return { type: 'extension_ui_request', id: 'u', method: 'setWidget', widgetKey, widgetLines }
}

function custom(customType: string, content: string, details: unknown): EngineEvent {
  return {
    type: 'message_end',
    message: { role: 'custom', customType, content, display: true, details, timestamp: 1 }
  }
}

await check(
  'parseAsyncSnapshot: real envelope, nested steps, unknown nodes dropped, junk → null',
  () => {
    const snapshot = parseAsyncSnapshot([
      snapshotLine([
        {
          id: RUN,
          kind: 'subagent',
          label: 'worker',
          state: 'running',
          startedAt: 10,
          activity: { currentTool: 'bash', toolCount: 41, turnCount: 12 }
        },
        {
          id: 'wf',
          kind: 'workflow',
          label: 'scout, reviewer',
          state: 'running',
          children: [
            { id: 'step:0', kind: 'step', label: 'scout', state: 'running' },
            { id: 'x', kind: 'nope', state: 'running' }
          ]
        },
        { id: 'bad', kind: 'subagent', label: 'x', state: 'exploded' }
      ])
    ])
    assert.ok(snapshot)
    assert.equal(snapshot.runs.length, 2)
    assert.equal(snapshot.runs[0]?.activity?.toolCount, 41)
    assert.deepEqual(
      snapshot.runs[1]?.children?.map((c) => c.id),
      ['step:0']
    )
    assert.equal(snapshot.omitted.children, 1)
    assert.equal(parseAsyncSnapshot(['PI_SUBAGENT_ASYNC_JSON:{not json']), null)
    assert.equal(parseAsyncSnapshot(['hello']), null)
    assert.equal(parseAsyncSnapshot(undefined), null)
  }
)

await check('parseInspectReply: messages, truncation and error codes', () => {
  const reply = parseInspectReply([
    `${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({
      kind: 'pi-subagents.inspect-reply',
      version: 1,
      requestId: 'vi-1',
      status: 'running',
      task: 'Fix it',
      messages: [
        { role: 'assistant', kind: 'toolCall', text: 'read src/a.ts', name: 'read' },
        { role: 'tool', kind: 'toolResult', text: 'boom', isError: true },
        { kind: 'bogus', text: 'x' }
      ],
      truncated: { task: false, messages: 3, finalOutput: false }
    })}`
  ])
  assert.equal(reply?.requestId, 'vi-1')
  assert.equal(reply?.messages?.length, 2)
  assert.equal(reply?.messages?.[1]?.isError, true)
  assert.equal(reply?.truncated?.messages, 3)
  const missing = parseInspectReply([
    `${SUBAGENT_INSPECT_PREFIX}${JSON.stringify({ kind: 'pi-subagents.inspect-reply', version: 1, requestId: 'vi-2', error: { code: 'not_found', message: 'gone' } })}`
  ])
  assert.equal(missing?.error?.code, 'not_found')
  assert.equal(
    parseInspectReply([`${SUBAGENT_INSPECT_PREFIX}{"kind":"other","version":1,"requestId":"x"}`]),
    null
  )
})

await check(
  'parseNotifyContent: summary without paths or instructions; failure reason humanized',
  () => {
    const done = parseNotifyContent(NOTIFY_COMPLETED)
    assert.equal(done.failed, false)
    assert.equal(done.agent, 'worker')
    assert.ok(done.summary.startsWith('I built the Wave 1 foundation'))
    assert.ok(!/Full output|Retention|Parent action|C:\\/.test(done.summary))
    assert.ok(done.outputPath?.endsWith('_worker_output.md'))
    const failed = parseNotifyContent(NOTIFY_FAILED)
    assert.equal(failed.failed, true)
    assert.equal(failed.reason, 'timed out after 30m')
    assert.equal(failed.outputPath, undefined)
  }
)

await check('details guards: notify runs, supervisor request, control event, message types', () => {
  assert.deepEqual(
    asNotifyDetails({
      runs: [
        { agent: 'worker', status: 'failed', runId: RUN, durationMs: 5, asyncDir: 'C:\\x' },
        { agent: 'x' }
      ]
    }),
    {
      runs: [{ agent: 'worker', status: 'failed', runId: RUN, durationMs: 5 }]
    }
  )
  assert.equal(asNotifyDetails({}), null)
  const request = asSupervisorRequest({
    id: 'r1',
    requestId: 'r1',
    reason: 'need_decision',
    expectsReply: true,
    runId: RUN,
    agent: 'worker',
    childIndex: 0,
    requestBody: 'A or B?'
  })
  assert.equal(request?.requestBody, 'A or B?')
  assert.equal(asSupervisorRequest({ runId: RUN }), null)
  assert.equal(
    asControlEvent({
      event: {
        type: 'needs_attention',
        message: "worker has had tool 'bash' open for 240s",
        runId: RUN,
        agent: 'worker'
      }
    })?.agent,
    'worker'
  )
  assert.ok(isSubagentMessageType('subagent-notify'))
  assert.ok(!isSubagentMessageType('pi-lens'))
})

await check('supervisorReplyPrompt round-trips through parseSupervisorReplyPrompt', () => {
  const prompt = supervisorReplyPrompt(
    { requestId: 'f48e8bbb', agent: 'worker' },
    'Option A.\n\nThanks.'
  )
  assert.deepEqual(parseSupervisorReplyPrompt(prompt), {
    requestId: 'f48e8bbb',
    agent: 'worker',
    message: 'Option A.\n\nThanks.'
  })
  assert.equal(parseSupervisorReplyPrompt('Reply to me'), null)
})

await check(
  'isMachinePayload: envelopes, bare JSON and dense long lines; prose and LSP text pass',
  () => {
    assert.ok(isMachinePayload([snapshotLine([])]))
    assert.ok(isMachinePayload(['{"ok":true}']))
    assert.ok(isMachinePayload([`x ${'{"a":1,"b":[2,3]},'.repeat(30)}`]))
    assert.ok(!isMachinePayload(['\u001b[2mLSP Inactive\u001b[22m']))
    assert.ok(!isMachinePayload(['LSP Active: typescript']))
    assert.ok(!isMachinePayload(['3/3 done']))
  }
)

await check(
  'reducer §5: hidden status keys, machine statuses/widgets, snapshot never a widget, inspect ignored',
  () => {
    let state = createAgentState(info)
    const status = (statusKey: string, statusText: string | undefined): EngineEvent => ({
      type: 'extension_ui_request',
      id: 's',
      method: 'setStatus',
      statusKey,
      statusText
    })
    state = reduceAgentEvent(state, status('subagent-slash', '3 tools | ctrl+o live detail'))
    state = reduceAgentEvent(state, status('pi-lens-lsp', 'LSP Inactive'))
    state = reduceAgentEvent(state, status('blob', '{"a":1}'))
    assert.deepEqual(state.ext.statuses, { 'pi-lens-lsp': 'LSP Inactive' })
    assert.deepEqual(state.ext.machine.blob?.lines, ['{"a":1}'])
    state = reduceAgentEvent(
      state,
      ui('subagent-async', [
        snapshotLine([{ id: RUN, kind: 'subagent', label: 'worker', state: 'running' }])
      ])
    )
    state = reduceAgentEvent(state, ui('subagent-inspect', [`${SUBAGENT_INSPECT_PREFIX}{}`]))
    state = reduceAgentEvent(state, ui('other-json', ['OTHER_JSON:{"x":1}']))
    assert.deepEqual(Object.keys(state.ext.widgets), [])
    assert.deepEqual(Object.keys(state.ext.machine).sort(), [
      'blob',
      'other-json',
      'subagent-async'
    ])
    assert.equal(state.subagents.snapshot?.runs[0]?.id, RUN)
    state = reduceAgentEvent(state, ui('subagent-async', undefined))
    assert.equal(state.subagents.snapshot, null)
    assert.ok(
      !('subagent-async' in state.ext.machine),
      'a retracted snapshot leaves no machine row'
    )
    assert.equal(
      state.subagents.runs[RUN]?.node?.state,
      'running',
      'a run is remembered after it leaves the snapshot'
    )
  }
)

await check(
  'reducer: launch → resume lineage, notify outcome, supervisor request answered by a reply prompt',
  () => {
    let state = createAgentState(info)
    state = reduceAgentEvent(state, {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'subagent',
      args: { agent: 'worker', task: 'Fix the session-tree jump on fork. Then test.', async: true }
    })
    state = reduceAgentEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'subagent',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Detached.' }],
        details: { mode: 'single', runId: RUN, asyncId: RUN, results: [] }
      }
    })
    assert.equal(state.subagents.runs[RUN]?.label, 'worker')
    assert.equal(state.subagents.runs[RUN]?.task, 'Fix the session-tree jump on fork. Then test.')
    state = reduceAgentEvent(
      state,
      custom('subagent-notify', NOTIFY_FAILED, {
        runs: [{ agent: 'worker', status: 'failed', runId: RUN, durationMs: 1_800_000 }]
      })
    )
    assert.equal(state.subagents.runs[RUN]?.final?.state, 'failed')
    assert.equal(state.subagents.runs[RUN]?.final?.reason, 'timed out after 30m')
    state = reduceAgentEvent(state, {
      type: 'tool_execution_start',
      toolCallId: 'c2',
      toolName: 'subagent',
      args: { action: 'resume', id: RUN, message: 'Continue' }
    })
    state = reduceAgentEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'subagent',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'Revived run: new\nAgent: worker' }],
        details: { mode: 'single', runId: 'new-run', asyncId: 'new-run', results: [] }
      }
    })
    assert.equal(state.subagents.runs['new-run']?.resumedFrom, RUN)
    assert.equal(state.subagents.runs['new-run']?.label, 'worker')
    state = reduceAgentEvent(
      state,
      custom('subagent_supervisor_request', 'Subagent needs a supervisor decision.', {
        requestId: 'r1',
        runId: 'new-run',
        agent: 'worker',
        requestBody: 'A or B?',
        expectsReply: true
      })
    )
    assert.equal(state.subagents.requests.r1?.state, 'pending')
    const reply = supervisorReplyPrompt({ requestId: 'r1', agent: 'worker' }, 'A')
    state = reduceAgentEvent(state, {
      type: 'message_end',
      message: { role: 'user', content: reply, timestamp: 2 }
    })
    assert.equal(state.subagents.requests.r1?.state, 'answered')
  }
)

await check(
  'mock `subagents` script: real shapes reduce to a fleet with lineage, outcomes and an answered request',
  () => {
    const runtime = new MockSubagentRuntime(() => undefined)
    const steps = subagents({
      model: MOCK_MODELS[0]!,
      thinkingLevel: 'high',
      cwd: 'C:\w',
      prompt: 'Split it up',
      now: Date.now()
    })
    let state = createAgentState(info)
    const labels: string[] = []
    for (const step of steps) {
      if (step.kind !== 'event') continue
      if (step.label) labels.push(step.label)
      state = reduceAgentEvent(state, runtime.rewrite(step.event))
    }
    assert.deepEqual(labels, [
      'launched',
      'fleet-live',
      'needs-decision',
      'attention',
      'finished',
      'settled'
    ])
    const runs = state.subagents.runs
    assert.equal(runs[RUN]?.final?.state, 'failed')
    assert.equal(runs[RUN]?.final?.reason, 'timed out after 30m')
    assert.equal(runs['ef5b44ac-ac60-456b-89c3-2be8d7115cb8']?.final?.state, 'complete')
    assert.match(
      runs['ef5b44ac-ac60-456b-89c3-2be8d7115cb8']?.final?.outputPath ?? '',
      /reviewer_output\.md$/
    )
    assert.equal(runs['7c6d092b-7d8b-4f96-9d83-79985ca07929']?.resumedFrom, RUN)
    assert.equal(runs['7c6d092b-7d8b-4f96-9d83-79985ca07929']?.node?.state, 'complete')
    assert.equal(runs['2751deb6-90f7-4eb3-8e2c-b38b23a0cdcd']?.kind, 'workflow')
    assert.ok(Object.values(state.subagents.requests).every((entry) => entry.state === 'answered'))
    assert.equal(state.subagents.snapshot, null)
    assert.deepEqual(Object.keys(state.ext.widgets), [])
    assert.deepEqual(Object.keys(state.ext.statuses), ['pi-lens-lsp'])
  }
)

await check(
  'runTitle: role briefs lose preamble and context; plain tasks keep their first sentence',
  () => {
    const brief = (head: string) =>
      `${head} for "Vengeance" \u2014 a premium Windows-first Electron desktop GUI. Work ONLY in the worktree.`
    assert.equal(
      runTitle(
        undefined,
        brief('You are FINAL POLISH LANE F-CORE (main process + shared + store + lib)')
      ),
      'Final polish lane F-CORE'
    )
    assert.equal(runTitle(undefined, brief('READ-ONLY FINAL DESIGN GATE')), 'Final design gate')
    assert.equal(runTitle(undefined, brief('Task: READ-ONLY SHIP GATE')), 'Ship gate')
    assert.equal(
      runTitle(
        undefined,
        'You are LANE A (Transcript + Tool cards) of Wave 2 for "Vengeance", a premium app.'
      ),
      'Lane A · transcript + tool cards'
    )
    assert.equal(
      runTitle(
        undefined,
        'Task: LANE T (tools and transcript) for Vengeance, a Windows Electron GUI.'
      ),
      'Lane T · tools and transcript'
    )
    assert.equal(
      runTitle(
        undefined,
        'Task: FIX LANE B for Vengeance, a Windows Electron GUI for the coding agent.'
      ),
      'Fix lane B'
    )
    assert.equal(
      runTitle(undefined, brief('READ-ONLY VISUAL/UX DESIGN CRITIQUE of "Vengeance"')),
      'Visual/UX design critique'
    )
    assert.equal(
      runTitle(undefined, 'You are a worker. Fix the session-tree jump on fork.'),
      'Fix the session-tree jump on fork'
    )
    assert.equal(
      runTitle(undefined, 'Review the tool rows redesign for regressions. Read the diff.'),
      'Review the tool rows redesign for regressions'
    )
    assert.equal(
      runTitle(undefined, 'Task: Look for usages of the old store. Then report.'),
      'Look for usages of the old store'
    )
    assert.equal(runTitle('Release notes', 'Write them.'), 'Release notes')
    assert.equal(
      runTitle('subagent-worker-16200214-2998-4a66-b620-347c082f7fd2-1', 'Write the notes.'),
      'Write the notes'
    )
    assert.equal(runTitle(undefined, '  '), undefined)
    assert.equal(
      childSessionAgent('subagent-worker-16200214-2998-4a66-b620-347c082f7fd2-1'),
      'worker'
    )
    assert.equal(
      childSessionAgent('subagent-code-reviewer-2751deb6-90f7-4eb3-8e2c-b38b23a0cdcd-3'),
      'code-reviewer'
    )
    assert.equal(childSessionAgent('Release notes'), undefined)
  }
)

await check(
  'childSessionTitle: generated child session names read as "Worker subagent \u00b7 <task>"',
  () => {
    const name = 'subagent-worker-16200214-2998-4a66-b620-347c082f7fd2-1'
    assert.equal(
      childSessionTitle(
        name,
        'Task: LANE T (tools and transcript) for Vengeance, a Windows Electron GUI.'
      ),
      'Worker subagent \u00b7 Lane T \u00b7 tools and transcript'
    )
    assert.equal(childSessionTitle(name, undefined), 'Worker subagent')
    assert.equal(childSessionTitle('Release notes', 'Write them.'), null)
    assert.equal(generatedChildName(name), name)
    assert.equal(generatedChildName('Release notes'), undefined)
  }
)

await check(
  'activityLine: inspect rows say what happened from the result shape, never the raw first line',
  () => {
    const tools = activityItems(inspectMessages('worker')).filter(
      (item): item is ToolActivity => item.kind === 'tool'
    )
    const lines = tools.map((item, i) => activityLine(item, i === tools.length - 1))
    assert.deepEqual(
      lines.map((line) => [line.verb, line.subject, line.meta].filter(Boolean).join(' ')),
      [
        'Read',
        'Searched 2 matches in SessionTree.tsx',
        'Edited SessionTree.tsx 2 blocks',
        'Ran a command',
        'Edited SessionTree.tsx 1 block',
        'Running a command'
      ]
    )
    const failed = activityLine(
      {
        kind: 'tool',
        name: 'bash',
        result: 'npm warn\nsrc/a.ts(3,1): error TS2304: Cannot find name x.\nNode.js v24.19.0',
        isError: true
      },
      false
    )
    assert.equal(failed.reason, 'src/a.ts(3,1): error TS2304: Cannot find name x.')
    assert.equal(
      activityLine({ kind: 'tool', name: 'grep', result: 'No matches found' }, false).meta,
      'no matches'
    )
    assert.equal(
      activityLine({ kind: 'tool', name: 'subagent_supervisor', result: 'ok' }, false).verb,
      'Used subagent supervisor'
    )
  }
)

await check(
  'splitSavedOutput: the saved-file trailer leaves the text and becomes the Open file path',
  () => {
    const saved = splitSavedOutput(
      'Done.\n\nOutput saved to: D:\\coding\\reports\\r4-design.md (20.8 KB, 220 lines). Read this file if needed.'
    )
    assert.deepEqual(saved, { text: 'Done.', path: 'D:\\coding\\reports\\r4-design.md' })
    assert.deepEqual(splitSavedOutput('Plain output.'), { text: 'Plain output.' })
  }
)

await check(
  'mock subagent runtime: RPC stop/resume fold into the next snapshot; inspect replies and not_found',
  () => {
    const emitted: EngineEvent[] = []
    const runtime: MockSubagentRuntime = new MockSubagentRuntime((event) =>
      emitted.push(runtime.rewrite(event))
    )
    runtime.rewrite(
      ui('subagent-async', [
        snapshotLine([{ id: RUN, kind: 'subagent', label: 'worker', state: 'running' }])
      ])
    )
    assert.equal(runtime.rpc('ping', {}).success, true)
    assert.equal(runtime.rpc('steer', { id: 'nope', message: 'x' }).success, false)
    assert.equal(runtime.rpc('stop', { id: RUN }).success, true)
    const stopped = emitted.at(-1)
    assert.ok(stopped?.type === 'extension_ui_request' && stopped.method === 'setWidget')
    assert.equal(parseAsyncSnapshot(stopped.widgetLines)?.runs[0]?.state, 'stopped')
    const resumed = runtime.rpc('resume', { id: RUN, message: 'go on' })
    assert.ok(resumed.success)
    const next = emitted.at(-1)
    assert.ok(next?.type === 'extension_ui_request' && next.method === 'setWidget')
    assert.equal(parseAsyncSnapshot(next.widgetLines)?.runs.length, 2)
    assert.ok(runtime.command(`/subagents-inspect-rpc vi-1 ${RUN} --lines 40`))
    const inspect = emitted.find(
      (event) =>
        event.type === 'extension_ui_request' &&
        event.method === 'setWidget' &&
        event.widgetKey === 'subagent-inspect'
    )
    assert.ok(inspect?.type === 'extension_ui_request' && inspect.method === 'setWidget')
    const reply = parseInspectReply(inspect.widgetLines)
    assert.equal(reply?.requestId, 'vi-1')
    assert.equal(reply?.status, 'stopped')
    assert.ok((reply?.messages?.length ?? 0) > 10)
    emitted.length = 0
    runtime.command('/subagents-inspect-rpc vi-2 00000000-0000-0000-0000-000000000000 --lines 40')
    const missing = emitted[0]
    assert.ok(missing?.type === 'extension_ui_request' && missing.method === 'setWidget')
    assert.equal(parseInspectReply(missing.widgetLines)?.error?.code, 'not_found')
    assert.ok(!runtime.command('/review the diff'))
  }
)

await check('formatLspStatus: pi-lens LSP strings in plain words; other text is not LSP', () => {
  assert.deepEqual(
    formatLspStatus('\u001b[32mLSP Active: typescript, pyright\u001b[39m')?.map((chip) => [
      chip.label,
      chip.tone
    ]),
    [['TypeScript · Python', 'success']]
  )
  assert.deepEqual(
    formatLspStatus('\u001b[2mLSP Inactive\u001b[22m')?.map((chip) => chip.label),
    ['Code intelligence idle']
  )
  assert.deepEqual(
    formatLspStatus('LSP Active: typescript · LSP Failed: marksman')?.map((chip) => [
      chip.label,
      chip.tone
    ]),
    [
      ['TypeScript', 'success'],
      ['Markdown server unavailable', 'warning']
    ]
  )
  assert.equal(formatLspStatus('LSP ✓')?.[0]?.label, 'Code intelligence')
  assert.equal(formatLspStatus('LSP ready'), null)
})

await check(
  'hidesIdleLsp: idle hides until a server ran this session; failures always show',
  () => {
    const idle = formatLspStatus('LSP Inactive')
    const failed = formatLspStatus('LSP Failed: marksman')
    const active = formatLspStatus('LSP Active: typescript')
    assert.equal(hidesIdleLsp(idle, false), true)
    assert.equal(hidesIdleLsp(idle, true), false)
    assert.equal(hidesIdleLsp(failed, false), false)
    assert.equal(hidesIdleLsp(active, false), false)
    assert.equal(isLspActive(active), true)
    assert.equal(isLspActive(idle), false)
  }
)
