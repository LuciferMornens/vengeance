import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { check } from './harness'

interface SideQuestion {
  id: string
  status: string
  answer: string
  error: string
}

interface SideQuestionApi {
  startPrimeSideQuestionEvents(): () => void
  useSideQuestions: {
    getState(): {
      sessions: Record<string, SideQuestion>
      ask(agentId: string, question: string): Promise<void>
      abort(agentId: string): Promise<void>
    }
  }
  useAgents: {
    getState(): {
      createAgent(args: { cwd: string; engine: 'prime' }): Promise<string>
      disposeAgent(agentId: string): Promise<void>
      setActive(agentId: string): void
    }
  }
}

interface NativeRequest {
  agentId: string
  command: string
  payload: Record<string, unknown>
  resolve(): void
  reject(reason: string): void
}

async function sideQuestionHarness() {
  const root = process.cwd()
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const bundled = await esbuild.build({
    stdin: {
      contents: `
        export { useAgents } from './src/renderer/store/agents';
        export {
          useSideQuestions,
          startPrimeSideQuestionEvents
        } from './src/renderer/features/engines/prime-side-questions';
      `,
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@shared': resolve(root, 'src', 'shared') }
  })
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const requests: NativeRequest[] = []
  const module = { exports: {} }
  runInNewContext(bundled.outputFiles![0]!.text, {
    module,
    exports: module.exports,
    process: { env: { NODE_ENV: 'test' } },
    crypto: { randomUUID },
    setTimeout,
    clearTimeout,
    window: {
      vengeance: {
        platform: 'win32',
        on(channel: string, listener: (event: unknown) => void) {
          const handlers = listeners.get(channel) ?? new Set()
          handlers.add(listener)
          listeners.set(channel, handlers)
          return () => handlers.delete(listener)
        },
        async invoke(channel: string, ...args: unknown[]) {
          if (channel === 'engine:dispose') return
          if (channel === 'engine:create') {
            return {
              agentId: args[1],
              engine: 'prime',
              cwd: 'workspace',
              status: 'starting',
              args: args[0]
            }
          }
          assert.equal(channel, 'prime:command')
          return new Promise<void>((complete, reject) => {
            requests.push({
              agentId: String(args[0]),
              command: String(args[1]),
              payload: args[2] as Record<string, unknown>,
              resolve: complete,
              reject
            })
          })
        }
      }
    }
  })
  const api = module.exports as SideQuestionApi
  const emit = (channel: string, event: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(event)
  }
  const sideEvent = (agentId: string, payload: Record<string, unknown>) =>
    emit('engine:event', {
      agentId,
      event: {
        type: 'engine_native_event',
        engine: 'prime',
        name: 'side_question_event',
        data: { event: payload }
      }
    })
  return { api, requests, listeners, emit, sideEvent }
}

await check(
  'native side questions complete across session switches without a mounted panel',
  async () => {
    const { api, requests, listeners, sideEvent } = await sideQuestionHarness()
    const stop = api.startPrimeSideQuestionEvents()
    const agents = api.useAgents.getState()
    const first = await agents.createAgent({ cwd: 'workspace', engine: 'prime' })
    const second = await agents.createAgent({ cwd: 'workspace', engine: 'prime' })
    const questions = api.useSideQuestions.getState
    try {
      agents.setActive(first)
      const accepted = questions().ask(first, 'Explain this decision')
      const request = requests.at(-1)!
      assert.equal(request.command, 'start_side_question')
      agents.setActive(second)
      sideEvent(first, {
        id: request.payload.sideQuestionId,
        status: 'complete',
        answer: 'The completed background answer.'
      })
      request.resolve()
      await accepted
      agents.setActive(first)
      assert.equal(questions().sessions[first]?.status, 'complete')
      assert.equal(questions().sessions[first]?.answer, 'The completed background answer.')
      const followUp = questions().ask(first, 'What is the alternative?')
      const next = requests.at(-1)!
      assert.equal(
        JSON.stringify(next.payload.previousTurns),
        JSON.stringify([
          { question: 'Explain this decision', answer: 'The completed background answer.' }
        ])
      )
      next.resolve()
      await followUp
      const aborted = questions().abort(first)
      assert.equal(requests.at(-1)?.command, 'abort_side_question')
      assert.equal(requests.at(-1)?.payload.sideQuestionId, next.payload.sideQuestionId)
      requests.at(-1)!.resolve()
      sideEvent(first, { id: next.payload.sideQuestionId, status: 'cancelled' })
      await aborted
      assert.equal(questions().sessions[first]?.status, 'cancelled')
    } finally {
      stop()
      await agents.disposeAgent(first)
      await agents.disposeAgent(second)
    }
    assert.ok([...listeners.values()].every((handlers) => handlers.size === 0))
  }
)

await check(
  'native side questions interrupt on disconnect and ignore late detached replies',
  async () => {
    const { api, requests, emit, sideEvent } = await sideQuestionHarness()
    const stop = api.startPrimeSideQuestionEvents()
    const agents = api.useAgents.getState()
    const agentId = await agents.createAgent({ cwd: 'workspace', engine: 'prime' })
    const questions = api.useSideQuestions.getState
    try {
      const pending = questions().ask(agentId, 'A question before reconnect')
      const first = requests.at(-1)!
      first.resolve()
      await pending
      sideEvent(agentId, { id: first.payload.sideQuestionId, status: 'running', answer: 'Partial' })
      emit('engine:status', { agentId, status: 'starting' })
      assert.equal(questions().sessions[agentId]?.status, 'interrupted')
      assert.equal(questions().sessions[agentId]?.answer, 'Partial')
      sideEvent(agentId, { id: first.payload.sideQuestionId, status: 'complete', answer: 'Stale' })
      assert.equal(questions().sessions[agentId]?.answer, 'Partial')
      emit('engine:status', { agentId, status: 'ready' })
      const next = questions().ask(agentId, 'Try after reconnect')
      const second = requests.at(-1)!
      second.resolve()
      await next
      assert.equal(questions().sessions[agentId]?.status, 'running')
      emit('engine:exit', { agentId, expected: false })
      assert.equal(questions().sessions[agentId]?.status, 'interrupted')
      const detached = questions().ask(agentId, 'Question being detached')
      const rejection = assert.rejects(detached, /closed/)
      emit('engine:status', { agentId, status: 'stopping' })
      assert.equal(questions().sessions[agentId]?.status, 'interrupted')
      await agents.disposeAgent(agentId)
      assert.equal(questions().sessions[agentId], undefined)
      requests.at(-1)!.reject('Connection closed')
      await rejection
      assert.equal(
        questions().sessions[agentId],
        undefined,
        'late failure cannot recreate a closed session'
      )
    } finally {
      stop()
      await agents.disposeAgent(agentId)
    }
  }
)
