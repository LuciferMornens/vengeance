import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_APP_STATE, type AppPersistedState } from '../../src/shared/api/app'
import type { EngineId } from '../../src/shared/api/engine'
import type { SettingsSnapshot } from '../../src/shared/api/settings'
import { check } from './harness'

interface PendingSnapshot {
  engine: EngineId
  cwd: string | null
  resolve(snapshot: SettingsSnapshot): void
}

interface EffectiveApi {
  getEffectiveSetting(key: string, cwd: string | null, engine: EngineId): unknown
  useApp: { getState(): { load(): Promise<void> } }
  useAgents: {
    getState(): {
      createAgent(args: { cwd: string; engine: EngineId }): Promise<string>
      disposeAgent(agentId: string): Promise<void>
    }
  }
}

function snapshot(hidden: boolean, trusted = true): SettingsSnapshot {
  return {
    agentDir: 'account',
    global: { path: 'global', exists: true, data: { hideThinkingBlock: false }, text: '' },
    project: {
      path: 'project',
      cwd: 'project',
      exists: true,
      data: { hideThinkingBlock: hidden },
      text: '',
      trust: { saved: trusted, effective: trusted, fallback: 'ask' }
    },
    isolated: true,
    envOverrides: {}
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done))
}

await check(
  'effective settings: scope lifetime, coalesced invalidation and authoritative replies',
  async () => {
    const root = process.cwd()
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const bundled = await esbuild.build({
      stdin: {
        contents: `
        export { getEffectiveSetting } from './src/renderer/features/settings/effective';
        export { useApp } from './src/renderer/store/app';
        export { useAgents } from './src/renderer/store/agents';
      `,
        resolveDir: root,
        loader: 'ts'
      },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      define: { 'import.meta.hot': 'undefined' },
      alias: { '@shared': resolve(root, 'src', 'shared') },
      plugins: [
        {
          name: 'settings-transport',
          setup(build) {
            // Isolate the IPC boundary from settings-sheet UI imports in the Node check.
            build.onResolve({ filter: /^\.\/ipc$/ }, (args) =>
              args.importer.endsWith('effective.ts')
                ? { path: 'settings-transport', namespace: 'test' }
                : undefined
            )
            build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
              contents: `export function settingsInvokeForFolder(engine, cwd, channel, ...args) {
            return window.vengeance.invoke('engine:settings', { engine, cwd, channel, args });
          }`
            }))
          }
        }
      ]
    })
    const requests: PendingSnapshot[] = []
    const listeners = new Map<string, Array<(event: unknown) => void>>()
    let prefs: AppPersistedState = {
      ...DEFAULT_APP_STATE,
      activeWorkspace: 'project',
      workspaces: [{ path: 'project', name: 'project', lastOpenedAt: 0, engine: 'pi' }]
    }
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
            listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
            return () => undefined
          },
          async invoke(channel: string, args: Record<string, unknown>, agentId?: string) {
            if (channel === 'app:get-state') return prefs
            if (channel === 'engine:dispose') return
            if (channel === 'engine:create') {
              return { agentId, engine: args.engine, cwd: args.cwd, status: 'starting', args }
            }
            assert.equal(channel, 'engine:settings')
            return new Promise<SettingsSnapshot>((complete) => {
              requests.push({
                engine: args.engine as EngineId,
                cwd: args.cwd as string | null,
                resolve: complete
              })
            })
          }
        }
      }
    })
    const api = module.exports as EffectiveApi
    const read = (engine: EngineId = 'pi') =>
      api.getEffectiveSetting('hideThinkingBlock', 'project', engine)
    const changed = (engine: EngineId = 'pi') => {
      for (const listener of listeners.get('settings:changed') ?? []) {
        listener({ engine, area: 'settings' })
      }
    }
    await api.useApp.getState().load()
    const primeAgent = await api.useAgents
      .getState()
      .createAgent({ cwd: 'project', engine: 'prime' })
    assert.equal(read(), false)
    read()
    changed()
    changed()
    assert.equal(requests.length, 1, 'initial load and repeated invalidations share one request')
    requests[0]!.resolve(snapshot(true))
    await settle()
    assert.equal(read(), false, 'invalidated initial reply must not become visible')
    assert.equal(requests.length, 2, 'invalidations produce one follow-up request')
    requests[1]!.resolve(snapshot(true))
    await settle()
    assert.equal(read(), true)
    read('prime')
    requests[2]!.resolve(snapshot(true, false))
    await settle()
    assert.equal(read('prime'), false, 'untrusted project values must not override global settings')
    changed()
    changed()
    changed()
    assert.equal(requests.length, 4)
    assert.equal(requests[3]!.engine, 'pi', 'settings invalidation stays in its backend')
    requests[3]!.resolve(snapshot(false))
    await settle()
    assert.equal(read(), true, 'superseded reload keeps the last authoritative value visible')
    assert.equal(requests.length, 5)
    requests[4]!.resolve(snapshot(false))
    await settle()
    assert.equal(read(), false)
    await api.useAgents.getState().disposeAgent(primeAgent)
    changed('prime')
    assert.equal(requests.length, 5, 'closed inactive scopes must not reload')
    changed()
    assert.equal(requests.length, 6)
    prefs = { ...prefs, activeWorkspace: null }
    await api.useApp.getState().load()
    requests[5]!.resolve(snapshot(true))
    await settle()
    changed()
    assert.equal(requests.length, 6, 'late replies must not revive released scopes')
    prefs = { ...prefs, activeWorkspace: 'project' }
    await api.useApp.getState().load()
    assert.equal(read(), false)
    assert.equal(requests.length, 7, 'returning to an evicted scope fetches fresh settings')
    requests[6]!.resolve(snapshot(true))
    await settle()
    assert.equal(read(), true)
  }
)
