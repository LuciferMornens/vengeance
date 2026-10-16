import { strict as assert } from 'node:assert'
import type { AgentInfo } from '../../src/shared/api/engine'
import type { AssistantMessage, EngineEvent } from '../../src/shared/engine-types'
import {
  hydrateMessages,
  landBashRuns,
  reduceAgentEvent
} from '../../src/renderer/store/agent-reducer'
import { createAgentState, type BashRun } from '../../src/renderer/store/agent-state'
import { check } from './harness'

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

const assistantWithCall: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } }],
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
  stopReason: 'aborted',
  timestamp: 0
}

await check('reducer: __vengeance:* setStatus replies are hidden, other statuses kept', () => {
  let state = createAgentState(info)
  state = reduceAgentEvent(state, {
    type: 'extension_ui_request',
    id: '1',
    method: 'setStatus',
    statusKey: '__vengeance:b1',
    statusText: '{"ok":true}'
  })
  state = reduceAgentEvent(state, {
    type: 'extension_ui_request',
    id: '2',
    method: 'setStatus',
    statusKey: 'lsp',
    statusText: 'ready'
  })
  assert.deepEqual(state.ext.statuses, { lsp: 'ready' })
})

await check('reducer: agent_settled interrupts tools that never finished', () => {
  let state = createAgentState(info)
  state = reduceAgentEvent(state, { type: 'agent_start' })
  state = reduceAgentEvent(state, { type: 'message_start', message: assistantWithCall })
  state = reduceAgentEvent(state, { type: 'message_end', message: assistantWithCall })
  assert.equal(state.tools.t1?.status, 'pending')
  state = reduceAgentEvent(state, { type: 'agent_settled', aborted: true })
  assert.equal(state.tools.t1?.status, 'error')
  assert.equal(state.tools.t1?.interrupted, true)
  assert.equal(state.phase, 'idle')
})

await check(
  'reducer: finished tools are left alone on settle; a late tool_execution_end clears interrupted',
  () => {
    let state = createAgentState(info)
    state = reduceAgentEvent(state, { type: 'message_end', message: assistantWithCall })
    state = reduceAgentEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false
    })
    const done = state.tools.t1
    state = reduceAgentEvent(state, { type: 'agent_settled', aborted: false })
    assert.equal(state.tools.t1, done)
    assert.equal(state.tools.t1?.interrupted, false)
  }
)

await check(
  'hydrateMessages: settled history marks result-less calls interrupted; live history does not',
  () => {
    assert.equal(hydrateMessages([assistantWithCall]).tools.t1?.interrupted, true)
    assert.equal(hydrateMessages([assistantWithCall], false).tools.t1?.status, 'pending')
  }
)

await check('reducer: completed tools release previews and share committed result content', () => {
  const preview = {
    content: [{ type: 'text' as const, text: 'preview'.repeat(100_000) }],
    details: { progress: 'streaming' }
  }
  for (const isError of [false, true]) {
    let state = createAgentState(info)
    state = reduceAgentEvent(state, {
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'echo ok' }
    })
    state = reduceAgentEvent(state, {
      type: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'bash',
      args: { command: 'echo ok' },
      partialResult: preview
    })
    assert.equal(state.tools.t1?.partialResult, preview)
    state = reduceAgentEvent(state, {
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'ok' }], details: { exitCode: 0 } },
      isError,
      durationMs: 42
    })
    assert.equal(state.tools.t1?.partialResult, undefined)
    const committed = {
      role: 'toolResult' as const,
      toolCallId: 't1',
      toolName: 'bash',
      content: [{ type: 'text' as const, text: 'ok' }],
      details: { exitCode: 0 },
      isError,
      timestamp: 1
    }
    state = reduceAgentEvent(state, { type: 'message_end', message: committed })
    assert.equal(state.tools.t1?.result?.content, committed.content)
    assert.equal(state.tools.t1?.result?.details, committed.details)
    assert.equal(state.tools.t1?.durationMs, 42)
    assert.equal(state.tools.t1?.isError, isError)
    assert.equal(state.tools.t1?.status, isError ? 'error' : 'done')
  }
})

await check('reducer: interrupted previews survive until an authoritative result arrives', () => {
  const preview = { content: [{ type: 'text' as const, text: 'partial output' }], details: {} }
  let state = reduceAgentEvent(createAgentState(info), {
    type: 'tool_execution_update',
    toolCallId: 't1',
    toolName: 'bash',
    args: {},
    partialResult: preview
  })
  state = reduceAgentEvent(state, { type: 'agent_settled', aborted: true })
  assert.equal(state.tools.t1?.partialResult, preview)
  assert.equal(state.tools.t1?.interrupted, true)
  const committed = {
    role: 'toolResult' as const,
    toolCallId: 't1',
    toolName: 'bash',
    content: [{ type: 'text' as const, text: 'partial output\nCancelled' }],
    details: {},
    isError: true,
    timestamp: 1
  }
  state = reduceAgentEvent(state, { type: 'message_end', message: committed })
  assert.equal(state.tools.t1?.result?.content, committed.content)
  assert.equal(state.tools.t1?.partialResult, undefined)
  assert.equal(state.tools.t1?.interrupted, false)
})

const finishedRun: BashRun = {
  id: 'b1',
  command: 'echo hi',
  output: 'hi\n',
  running: false,
  startedAt: Date.now(),
  excludeFromContext: true,
  result: { output: 'hi\n', exitCode: 0, cancelled: false, truncated: false }
}

await check(
  'landBashRuns: a finished !command becomes a transcript entry and leaves agent.bash',
  () => {
    const state = landBashRuns({
      ...createAgentState(info),
      bash: { b1: finishedRun, b2: { ...finishedRun, id: 'b2', running: true, result: undefined } }
    })
    const landed = state.entries.map((entry) => entry.message)
    assert.equal(landed.length, 1)
    assert.ok(
      landed[0]?.role === 'bashExecution' &&
        landed[0].command === 'echo hi' &&
        landed[0].excludeFromContext === true
    )
    assert.deepEqual(Object.keys(state.bash), ['b2'])
  }
)

await check(
  'reducer: agent_settled lands a !command the Engine deferred to the end of the run',
  () => {
    let state = reduceAgentEvent(
      { ...createAgentState(info), bash: { b1: finishedRun } },
      { type: 'agent_start' }
    )
    state = reduceAgentEvent(state, { type: 'message_end', message: assistantWithCall })
    state = reduceAgentEvent(state, { type: 'agent_settled', aborted: false })
    assert.deepEqual(
      state.entries.map((entry) => entry.message.role),
      ['assistant', 'bashExecution']
    )
  }
)

function confirmRequest(id: string): EngineEvent {
  return { type: 'extension_ui_request', id, method: 'confirm', title: 'Allow?', message: '' }
}

await check(
  'reducer: an aborted run drops the dialogs its hooks asked; a normal end and idle dialogs keep them',
  () => {
    let state = reduceAgentEvent(createAgentState(info), confirmRequest('idle'))
    state = reduceAgentEvent(state, { type: 'agent_start' })
    state = reduceAgentEvent(state, confirmRequest('guard'))
    const ended = reduceAgentEvent(state, { type: 'agent_settled', aborted: false })
    assert.deepEqual(
      ended.ext.dialogs.map((dialog) => dialog.request.id),
      ['idle', 'guard']
    )
    const aborted = reduceAgentEvent(state, { type: 'agent_settled', aborted: true })
    assert.deepEqual(
      aborted.ext.dialogs.map((dialog) => dialog.request.id),
      ['idle']
    )
  }
)
