import { strict as assert } from 'node:assert'
import { PrimeEventAdapter } from '../../src/main/engine/prime/events'
import { normalizeMessage } from '../../src/main/engine/prime/normalize'
import type { PrimeRecord } from '../../src/main/engine/prime/transport'
import {
  buildEntryItems,
  buildStreamingItems
} from '../../src/renderer/features/chat/transcript-items'
import { reduceAgentEvent } from '../../src/renderer/store/agent-reducer'
import { createAgentState } from '../../src/renderer/store/agent-state'
import type { AssistantMessage } from '../../src/shared/engine-types'
import { check } from './harness'

const TOOL_CALL = {
  type: 'toolCall' as const,
  id: 'call-read',
  name: 'ipython',
  arguments: { code: 'print("ok")' }
}

const MESSAGE_TIMESTAMP = Date.parse('2026-10-16T00:00:00.000Z')

function assistant(content: AssistantMessage['content']): PrimeRecord {
  return {
    role: 'assistant',
    content,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    stopReason: 'pending',
    timestamp: MESSAGE_TIMESTAMP
  }
}

function streamingSession() {
  let state = createAgentState({
    agentId: 'prime-streaming',
    engine: 'prime',
    cwd: process.cwd(),
    status: 'ready',
    mock: true,
    busy: false,
    bridge: false,
    createdAt: Date.now(),
    args: { engine: 'prime', cwd: process.cwd() }
  })
  const adapter = new PrimeEventAdapter((event) => {
    state = reduceAgentEvent(state, event)
    // Render every emitted frame, including frames before a complete provider message arrives.
    buildStreamingItems(state.streaming)
    buildEntryItems(state.entries)
  })
  adapter.accept({ type: 'agent_start' })
  return {
    adapter,
    state: () => state,
    content: () => {
      const message = state.streaming?.message
      assert.ok(message?.role === 'assistant')
      return message.content
    }
  }
}

await check('Prime streaming keeps empty reasoning and text slots before later content', () => {
  const session = streamingSession()
  session.adapter.accept({ type: 'message_start', message: assistant([]) })
  const content: AssistantMessage['content'] = [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '' }
  ]
  session.adapter.accept({ type: 'message_update', message: assistant(content) })
  assert.deepEqual(session.content(), content)

  const completed: AssistantMessage['content'] = [
    content[0]!,
    { type: 'text', text: 'Checking the project.' },
    TOOL_CALL
  ]
  session.adapter.accept({ type: 'message_update', message: assistant(completed) })
  assert.deepEqual(session.content(), completed)
  assert.deepEqual(session.state().tools[TOOL_CALL.id]?.args, TOOL_CALL.arguments)
})

await check(
  'Prime coalesced snapshots render reasoning without a summary before tool calls',
  () => {
    for (const withStart of [true, false]) {
      const session = streamingSession()
      if (withStart) session.adapter.accept({ type: 'message_start', message: assistant([]) })
      const message = assistant([
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Checking the project.' },
        TOOL_CALL
      ])
      session.adapter.accept({ type: 'message_update', message })
      assert.deepEqual(session.state().streaming?.message, normalizeMessage(message))
      session.adapter.accept({ type: 'message_end', message })
      assert.equal(session.state().streaming, null)
      assert.deepEqual(session.state().entries.at(-1)?.message, normalizeMessage(message))
    }
  }
)

await check('Prime cumulative text and reasoning updates do not duplicate or lose content', () => {
  const session = streamingSession()
  session.adapter.accept({ type: 'message_start', message: assistant([]) })
  for (const content of [
    [{ type: 'thinking', thinking: '' }],
    [{ type: 'thinking', thinking: 'Reviewing' }],
    [{ type: 'thinking', thinking: 'Reviewing the project' }],
    [{ type: 'thinking', thinking: 'Checking instead' }],
    [{ type: 'text', text: '' }],
    [{ type: 'text', text: 'Done' }],
    [{ type: 'text', text: 'Done' }],
    [{ type: 'text', text: '' }]
  ] satisfies AssistantMessage['content'][]) {
    // Each snapshot crosses IPC as a separate object; the native adapter never mutates it.
    const message = assistant(structuredClone(content))
    session.adapter.accept({ type: 'message_update', message })
    assert.deepEqual(session.content(), content)
  }
})
