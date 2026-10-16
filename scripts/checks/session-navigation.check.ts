import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { DEFAULT_APP_STATE } from '../../src/shared/api/app'
import type {
  AgentInfo,
  BackgroundAgentInfo,
  CreateAgentArgs,
  EngineId
} from '../../src/shared/api/engine'
import type { SessionListItem } from '../../src/shared/api/sessions'
import { check } from './harness'

interface NavigationApi {
  openSessionFile(path: string, options: { engine: EngineId }): Promise<string | null>
  resumeBackgroundAgent(resident: BackgroundAgentInfo): Promise<void>
  useApp: { getState(): { load(): Promise<void> } }
  useAgents: { getState(): { order: string[] } }
  useSessions: {
    getState(): {
      load(cwd: string, force?: boolean): Promise<void>
      lists: Record<string, { items: SessionListItem[]; warning?: string }>
    }
  }
}

await check(
  'Concurrent file/resident navigation joins one open and listing warnings keep root history',
  async () => {
    const cwd = 'D:\\qa\\navigation'
    const path = 'D:\\qa\\sessions\\navigation.jsonl'
    const warning = 'Some subagent history could not be inspected within the discovery limit.'
    const saved: SessionListItem = {
      engine: 'prime',
      path,
      id: 'navigation',
      cwd,
      createdAt: 0,
      modifiedAt: 0,
      messageCount: 1,
      firstMessage: 'Navigation history',
      searchText: 'navigation history'
    }
    const esbuild: typeof import('esbuild') = createRequire(resolve('package.json'))('esbuild')
    const bundle = await esbuild.build({
      stdin: {
        contents: `
        export { openSessionFile, resumeBackgroundAgent } from './src/renderer/features/sessions/actions';
        export { useApp } from './src/renderer/store/app';
        export { useAgents } from './src/renderer/store/agents';
        export { useSessions } from './src/renderer/features/sessions/store';
      `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      define: { 'import.meta.hot': 'undefined' },
      alias: { '@shared': resolve('src/shared') },
      plugins: [
        {
          name: 'navigation-boundaries',
          setup(bundler) {
            bundler.onResolve({ filter: /\/ui$/ }, () => ({ path: 'ui', namespace: 'fixture' }))
            bundler.onResolve({ filter: /\/composer$/ }, () => ({
              path: 'composer',
              namespace: 'fixture'
            }))
            bundler.onResolve({ filter: /launch\/spawn$/ }, () => ({
              path: 'launch',
              namespace: 'fixture'
            }))
            bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
              contents:
                args.path === 'ui'
                  ? 'export const toast = globalThis.recordNotice;'
                  : args.path === 'composer'
                    ? 'export const setDraftText = () => {};'
                    : 'export const prepareLaunch = async (args) => args;'
            }))
          }
        }
      ]
    })
    const notices: unknown[] = []
    const pendingCreates: Array<() => void> = []
    let createCount = 0
    const createdArguments: CreateAgentArgs[] = []
    const exported = { exports: {} }
    runInNewContext(bundle.outputFiles[0]!.text, {
      module: exported,
      exports: exported.exports,
      process: { env: { NODE_ENV: 'test' } },
      crypto: { randomUUID },
      setTimeout,
      clearTimeout,
      recordNotice: (notice: unknown) => notices.push(notice),
      window: {
        vengeance: {
          platform: { os: 'win32' },
          on: () => () => undefined,
          async invoke(
            channel: string,
            args: CreateAgentArgs & { engine: EngineId },
            agentId: string
          ) {
            if (channel === 'app:get-state') return { ...DEFAULT_APP_STATE, activeWorkspace: cwd }
            if (channel === 'app:set-state') return
            if (channel === 'sessions:describe') return { engine: 'prime', cwd, cwdExists: true }
            if (channel === 'sessions:list')
              return {
                sessions: args.engine === 'prime' ? [{ ...saved, lineage: { depth: 0 } }] : [],
                sessionDir: cwd,
                ...(args.engine === 'prime' ? { warning } : {})
              }
            if (channel === 'engine:create') {
              createCount++
              createdArguments.push(args)
              await new Promise<void>((complete) => pendingCreates.push(complete))
              const info: AgentInfo = {
                agentId,
                engine: args.engine,
                cwd,
                args,
                sessionFile: args.sessionPath,
                nativeAgentId: 'navigation-resident',
                status: 'starting',
                mock: false,
                busy: false,
                bridge: false,
                createdAt: 0
              }
              return info
            }
            throw new Error(`Unexpected navigation IPC: ${channel}`)
          }
        }
      }
    })
    const api = exported.exports as NavigationApi
    await api.useApp.getState().load()
    const fileOpen = api.openSessionFile(path, { engine: 'prime' })
    const residentOpen = api.resumeBackgroundAgent({
      engine: 'prime',
      id: 'navigation-resident',
      cwd,
      sessionPath: path,
      status: 'idle',
      busy: false
    })
    await new Promise<void>((complete) => setImmediate(complete))
    assert.equal(createCount, 1, 'file and resident paths share a pending engine creation')
    pendingCreates.shift()!()
    const [agentId] = await Promise.all([fileOpen, residentOpen])
    assert.ok(agentId)
    assert.equal(api.useAgents.getState().order.length, 1)
    assert.equal(await api.openSessionFile(path.toUpperCase(), { engine: 'prime' }), agentId)
    assert.equal(createCount, 1)
    const otherEngine = api.openSessionFile(path, { engine: 'pi' })
    await new Promise<void>((complete) => setImmediate(complete))
    assert.equal(createCount, 2, 'engine provenance scopes pending and open identities')
    pendingCreates.shift()!()
    assert.notEqual(await otherEngine, agentId)
    const otherPath = 'D:\\qa\\sessions\\other-daemon.jsonl'
    const otherResident = api.resumeBackgroundAgent({
      engine: 'prime',
      id: 'navigation-resident',
      cwd,
      sessionPath: otherPath,
      status: 'idle',
      busy: false
    })
    await new Promise<void>((complete) => setImmediate(complete))
    assert.equal(createCount, 3, 'a colliding daemon native ID does not focus another file')
    pendingCreates.shift()!()
    await otherResident
    assert.equal(createdArguments.at(-1)?.sessionPath, otherPath)
    assert.equal(
      createdArguments.at(-1)?.nativeAgentId,
      undefined,
      'concrete background files use precise path attachment'
    )
    await api.useSessions.getState().load(cwd)
    const listing = Object.values(api.useSessions.getState().lists)[0]!
    assert.equal(listing.items.length, 1)
    assert.equal(listing.items[0]?.path, path)
    assert.ok(listing.warning?.includes(warning))
    await api.useSessions.getState().load(cwd, true)
    assert.equal(
      Object.values(api.useSessions.getState().lists)[0]?.items[0],
      listing.items[0],
      'equal lineage metadata reuses listing objects during background refreshes'
    )
    assert.equal(notices.length, 0)
  }
)
