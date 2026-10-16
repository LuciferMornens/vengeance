import assert from 'node:assert/strict'
import {
  assertValidSession,
  SessionBuilder,
  workspaceSessionDir
} from '../sessions/lib/session-files.mjs'

const ERROR_INTERVAL = 17

export async function assertToolHistory(app, count) {
  const problems = await app.page.evaluate(
    ({ count: expectedCount, errorInterval }) => {
      const agent = window.__vengeanceTest.agentState()
      const failures = []
      if (!agent) return ['no active agent']
      if (Object.keys(agent.tools).length !== expectedCount + 1) {
        failures.push(`tool count: ${Object.keys(agent.tools).length}`)
      }
      for (let index = 0; index < expectedCount; index += 1) {
        const tool = agent.tools[`perf-tool-${index}`]
        const expectedError = index % errorInterval === 0
        if (!tool || tool.args.path !== `fixture-${index}.txt`) {
          failures.push(`call ${index} lost its arguments`)
        }
        if (tool?.status !== (expectedError ? 'error' : 'done')) {
          failures.push(`call ${index} status: ${tool?.status}`)
        }
        if (tool?.isError !== expectedError) failures.push(`call ${index} error flag`)
        if (tool?.result?.content?.[0]?.text !== `Result for fixture ${index}`) {
          failures.push(`call ${index} result was paired incorrectly`)
        }
        if (failures.length > errorInterval) break
      }
      const interrupted = agent.tools['perf-interrupted']
      if (!interrupted?.interrupted || interrupted.status !== 'error') {
        failures.push('unfinished historical call was not marked interrupted')
      }
      if (agent.entries.length !== expectedCount * 3 + 3) {
        failures.push(`message count: ${agent.entries.length}`)
      }
      const keys = new Set(agent.entries.map((entry) => entry.key))
      if (keys.size !== agent.entries.length) failures.push('message keys are not unique')
      return failures
    },
    { count, errorInterval: ERROR_INTERVAL }
  )
  assert.deepEqual(problems, [], 'every historical message, call and result survives hydration')
}

export async function writeToolHistory(agentDir, cwd, count) {
  const builder = new SessionBuilder({ cwd, stepMs: 1 })
  builder.modelChange()
  for (let index = 0; index < count; index += 1) {
    const toolCallId = `perf-tool-${index}`
    builder.user(`Inspect fixture ${index}`)
    builder.assistant(`Reading fixture ${index}`, {
      toolCalls: [{ id: toolCallId, name: 'read', args: { path: `fixture-${index}.txt` } }]
    })
    builder.add({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId,
        toolName: 'read',
        content: [{ type: 'text', text: `Result for fixture ${index}` }],
        isError: index % ERROR_INTERVAL === 0,
        timestamp: builder.clock + builder.stepMs
      }
    })
  }
  builder.user('Final history checkpoint')
  builder.assistant('A historical tool was interrupted.', {
    toolCalls: [{ id: 'perf-interrupted', name: 'read', args: { path: 'unfinished.txt' } }]
  })
  builder.assistant(`Long tool history ${count} is ready.`)
  builder.name(`Performance tools ${count}`)
  const path = await builder.write(workspaceSessionDir(agentDir, cwd))
  await assertValidSession(path)
  return path
}
