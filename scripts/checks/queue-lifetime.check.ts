import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { EngineEvent } from '../../src/shared/engine-types'
import { check } from './harness'

interface QueueApi {
  useAgents: {
    getState(): {
      agents: Record<string, { queue: object }>
      createAgent(args: { cwd: string }): Promise<string>
      disposeAgent(agentId: string): Promise<void>
      applyEvents(events: Map<string, EngineEvent[]>): void
    }
  }
  rememberQueued(
    agentId: string,
    message: {
      kind: 'steering'
      text: string
      images: Array<{ id: string; name: string; data: string; mimeType: string }>
    }
  ): void
  queuedImageCount(agentId: string, kind: 'steering', text: string, index: number): number
  drainQueue(agentId: string): Promise<Array<{ text: string; images: Array<{ id: string }> }>>
}

await check(
  'queued images: draining retains attachments while delivered records release queue snapshots',
  async () => {
    const root = process.cwd()
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const bundled = await esbuild.build({
      stdin: {
        contents: `
        export { useAgents } from './src/renderer/store/agents';
        export { rememberQueued, queuedImageCount, drainQueue }
          from './src/renderer/features/composer/queue';
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
    let now = 0
    class QueueClock extends Date {
      static override now(): number {
        return now
      }
    }
    const module = { exports: {} }
    let clearNativeQueue: (() => void) | undefined
    runInNewContext(bundled.outputFiles![0]!.text, {
      module,
      exports: module.exports,
      process: { env: { NODE_ENV: 'test' } },
      crypto: { randomUUID },
      Date: QueueClock,
      setTimeout,
      clearTimeout,
      window: {
        vengeance: {
          platform: 'win32',
          async invoke(channel: string, args: { cwd: string }, agentId?: string) {
            if (channel === 'engine:dispose') return
            if (channel === 'engine:command') {
              clearNativeQueue?.()
              return {
                type: 'response',
                command: 'clear_queue',
                success: true,
                data: { steering: ['inspect image'], followUp: [] }
              }
            }
            assert.equal(channel, 'engine:create')
            return { agentId, engine: 'pi', cwd: args.cwd, status: 'starting', args }
          }
        }
      }
    })
    const api = module.exports as QueueApi
    const agentId = await api.useAgents.getState().createAgent({ cwd: 'project' })
    const emit = (...events: EngineEvent[]) =>
      api.useAgents.getState().applyEvents(new Map([[agentId, events]]))
    emit({ type: 'agent_start' })
    api.rememberQueued(agentId, {
      kind: 'steering',
      text: 'inspect image',
      images: [{ id: 'image', name: 'image.png', data: 'aGVsbG8=', mimeType: 'image/png' }]
    })
    emit({ type: 'queue_update', steering: ['inspect image'], followUp: [] })
    assert.equal(api.queuedImageCount(agentId, 'steering', 'inspect image', 0), 1)
    // The sent record's one-second grace period has expired before the engine delivers it.
    now = 2000
    clearNativeQueue = () => emit({ type: 'queue_update', steering: [], followUp: [] })
    const restored = await api.drainQueue(agentId)
    assert.equal(restored[0]?.images[0]?.id, 'image', 'queue flush dropped the restored attachment')
    api.rememberQueued(agentId, {
      kind: 'steering',
      text: 'inspect image',
      images: [{ id: 'image', name: 'image.png', data: 'aGVsbG8=', mimeType: 'image/png' }]
    })
    emit({ type: 'queue_update', steering: ['inspect image'], followUp: [] })
    now = 4000
    emit({ type: 'queue_update', steering: [], followUp: [] })
    assert.equal(api.queuedImageCount(agentId, 'steering', 'inspect image', 0), 0)
    const deliveredQueue = new WeakRef(api.useAgents.getState().agents[agentId]!.queue)
    emit({ type: 'queue_update', steering: ['next message'], followUp: [] })

    setFlagsFromString('--expose-gc')
    const collectGarbage = runInNewContext('gc') as () => void
    // WeakRef targets stay alive for their current job; cross a task boundary before each collection.
    const COLLECTION_PASSES = 3
    for (let pass = 0; pass < COLLECTION_PASSES; pass++) {
      await new Promise<void>((done) => setImmediate(done))
      collectGarbage()
    }
    assert.equal(deliveredQueue.deref(), undefined, 'delivered image metadata retained its queue')
    emit({ type: 'agent_settled', aborted: false })
    await api.useAgents.getState().disposeAgent(agentId)
  }
)
