import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_APP_STATE, type AppPersistedState } from '../../src/shared/api/app'
import type { AgentInfo, CreateAgentArgs } from '../../src/shared/api/engine'
import type { EngineEvent } from '../../src/shared/engine-types'
import { check } from './harness'

interface SessionActions {
  deleteSession(target: {
    agentId: string
    path: string
    cwd: string
    title: string
    engine: 'pi' | 'prime'
  }): Promise<void>
  requestCloseAgent(agentId: string): void
  closeAgent(agentId: string): Promise<void>
  switchWorkspace(path: string): Promise<void>
  restoreOpenSessions(): Promise<boolean>
  flushAppPreferences(): Promise<void>
  useApp: {
    getState(): { load(): Promise<void>; prefs: AppPersistedState }
  }
  useAgents: {
    getState(): {
      agents: Record<string, { info: AgentInfo }>
      activeAgentId: string | null
      createAgent(args: CreateAgentArgs, activationRevision?: number): Promise<string>
      applyEvents(events: Map<string, EngineEvent[]>): void
    }
  }
  useSessions: {
    getState(): { dialog: { kind: string; agentId?: string } | null }
  }
}

await check(
  'session deletion keeps failed resident tabs and separates Close from Delete',
  async () => {
    const root = process.cwd()
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const bundled = await esbuild.build({
      stdin: {
        contents: `
        export { deleteSession, requestCloseAgent, closeAgent, switchWorkspace }
          from './src/renderer/features/sessions/actions';
        export { restoreOpenSessions } from './src/renderer/features/sessions/restore';
        export { useApp, flushAppPreferences } from './src/renderer/store/app';
        export { useAgents } from './src/renderer/store/agents';
        export { useSessions } from './src/renderer/features/sessions/store';
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
          name: 'session-action-ui-boundaries',
          setup(build) {
            build.onResolve({ filter: /\/ui$/ }, () => ({ path: 'ui', namespace: 'test' }))
            build.onResolve({ filter: /\.\.\/composer$/ }, () => ({
              path: 'composer',
              namespace: 'test'
            }))
            build.onResolve({ filter: /\.\.\/shell\/workspace$/ }, () => ({
              path: 'workspace',
              namespace: 'test'
            }))
            build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
              contents:
                path === 'ui'
                  ? 'export const toast = () => {};'
                  : path === 'composer'
                    ? 'export const setDraftText = () => {};'
                    : `
                      export const newSession = (...args) => globalThis.newSession(...args);
                      export const spawnAgent = (...args) => globalThis.createSession(...args);
                    `
            }))
          }
        }
      ]
    })
    const calls: string[] = []
    let failTrash = false
    let prefs: AppPersistedState = DEFAULT_APP_STATE
    const descriptions = new Map<string, { cwd: string; engine: 'prime'; cwdExists: true }>()
    let delayedPath: string | undefined
    let releaseDescription: (() => void) | undefined
    let actions: SessionActions
    const module = { exports: {} }
    runInNewContext(bundled.outputFiles[0]!.text, {
      module,
      exports: module.exports,
      process: { env: { NODE_ENV: 'test' } },
      crypto: { randomUUID },
      setTimeout,
      clearTimeout,
      createSession(args: CreateAgentArgs, options: { activationRevision: number }) {
        return actions.useAgents.getState().createAgent(args, options.activationRevision)
      },
      newSession() {
        throw new Error('Workspace switching started an unrelated empty session')
      },
      window: {
        vengeance: {
          platform: 'win32',
          async invoke(channel: string, ...parameters: unknown[]) {
            calls.push(channel)
            const [argument, agentId] = parameters
            if (channel === 'engine:create') {
              const args = argument as CreateAgentArgs
              assert.ok(args)
              return {
                agentId,
                engine: args.engine,
                cwd: args.cwd,
                status: 'starting',
                args
              } as AgentInfo
            }
            if (channel === 'app:get-state') return prefs
            if (channel === 'app:set-state') {
              prefs = { ...prefs, ...(argument as Partial<AppPersistedState>) }
              return
            }
            if (channel === 'sessions:describe') {
              const path = String(argument)
              if (path === delayedPath) {
                await new Promise<void>((release) => {
                  releaseDescription = release
                })
              }
              return descriptions.get(path)
            }
            if (channel === 'sessions:workspaces') return []
            if (channel === 'sessions:list') return { sessions: [], sessionDir: root }
            if (channel === 'sessions:trash' && failTrash) throw new Error('File is locked')
            if (channel === 'engine:background-list') return []
            if (channel === 'engine:dispose' || channel === 'sessions:trash') return
            throw new Error(`Unexpected IPC channel: ${channel}`)
          }
        }
      }
    })
    actions = module.exports as SessionActions
    const create = async (engine: 'pi' | 'prime') => {
      const path = join(root, `fixture-${engine}.jsonl`)
      const agentId = await actions.useAgents.getState().createAgent({
        cwd: root,
        engine,
        sessionPath: path
      })
      calls.length = 0
      return { agentId, engine, path, cwd: root, title: 'Session deletion fixture' }
    }

    const resident = await create('prime')
    failTrash = true
    await assert.rejects(actions.deleteSession(resident), /File is locked/)
    assert.ok(actions.useAgents.getState().agents[resident.agentId])
    assert.ok(!calls.includes('engine:dispose'), 'failed Delete must not detach the resident')
    failTrash = false
    calls.length = 0
    await actions.deleteSession(resident)
    assert.deepEqual(calls.slice(0, 2), ['sessions:trash', 'engine:dispose'])
    assert.equal(actions.useAgents.getState().agents[resident.agentId], undefined)

    const processSession = await create('pi')
    await actions.deleteSession(processSession)
    assert.deepEqual(calls.slice(0, 2), ['engine:dispose', 'sessions:trash'])

    const closingResident = await create('prime')
    actions.useAgents
      .getState()
      .applyEvents(new Map([[closingResident.agentId, [{ type: 'agent_start' }]]]))
    actions.requestCloseAgent(closingResident.agentId)
    await new Promise<void>((done) => setImmediate(done))
    assert.ok(calls.includes('engine:dispose'))
    assert.ok(!calls.includes('sessions:trash'), 'Close must never delete saved history')
    assert.equal(actions.useAgents.getState().agents[closingResident.agentId], undefined)

    const closingProcess = await create('pi')
    actions.useAgents
      .getState()
      .applyEvents(new Map([[closingProcess.agentId, [{ type: 'agent_start' }]]]))
    actions.requestCloseAgent(closingProcess.agentId)
    assert.equal(actions.useSessions.getState().dialog?.kind, 'close')
    assert.ok(!calls.includes('engine:dispose'), 'running process Close requires confirmation')
    await actions.closeAgent(closingProcess.agentId)
    assert.ok(!calls.includes('sessions:trash'))

    const front = await create('prime')
    const slowWorkspace = join(root, 'slow-workspace')
    const latestWorkspace = join(root, 'latest-workspace')
    const slowSession = join(slowWorkspace, 'saved.jsonl')
    const latestSession = join(latestWorkspace, 'saved.jsonl')
    descriptions.set(slowSession, { cwd: slowWorkspace, engine: 'prime', cwdExists: true })
    descriptions.set(latestSession, { cwd: latestWorkspace, engine: 'prime', cwdExists: true })
    prefs = {
      ...DEFAULT_APP_STATE,
      activeWorkspace: root,
      activeSession: front.path,
      openSessions: [
        { path: front.path, cwd: root, engine: 'prime' },
        { path: slowSession, cwd: slowWorkspace, engine: 'prime' },
        { path: latestSession, cwd: latestWorkspace, engine: 'prime' }
      ]
    }
    await actions.useApp.getState().load()
    assert.equal(await actions.restoreOpenSessions(), true)
    delayedPath = slowSession
    const slowSwitch = actions.switchWorkspace(slowWorkspace)
    await actions.switchWorkspace(latestWorkspace)
    const latestAgentId = actions.useAgents.getState().activeAgentId
    assert.ok(latestAgentId)
    assert.equal(
      actions.useAgents.getState().agents[latestAgentId]!.info.args.sessionPath,
      latestSession,
      'switching workspaces resumes the dormant saved conversation'
    )
    assert.ok(releaseDescription)
    releaseDescription()
    await slowSwitch
    assert.equal(actions.useAgents.getState().activeAgentId, latestAgentId)
    assert.equal(actions.useApp.getState().prefs.activeWorkspace, latestWorkspace)
    await actions.flushAppPreferences()
  }
)
