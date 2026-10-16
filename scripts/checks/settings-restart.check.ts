import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DEFAULT_APP_STATE, type AppPersistedState } from '../../src/shared/api/app'
import type { AgentInfo, EngineId } from '../../src/shared/api/engine'
import type { JsonObject, SettingsSnapshot } from '../../src/shared/api/settings'
import type { EngineEvent } from '../../src/shared/engine-types'
import { check } from './harness'

interface SettingsApi {
  startAgentEventPump(): void
  restartAgentsWhenIdle(agentIds: string[]): void
  useSettings: { getState(): { load(): Promise<void> } }
  useApp: { getState(): { load(): Promise<void> } }
  useAgents: {
    getState(): {
      createAgent(args: { cwd: string; engine: EngineId }): Promise<string>
      disposeAgent(agentId: string): Promise<void>
      applyEvents(events: Map<string, EngineEvent[]>): void
    }
  }
}

interface Notice {
  id?: string
  title: string
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done))
}

await check(
  'settings events classify startup changes across active and offscreen engine scopes',
  async () => {
    const root = process.cwd()
    const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
    const bundled = await esbuild.build({
      stdin: {
        contents: `
        export { useSettings } from './src/renderer/features/settings/store';
        export { useApp } from './src/renderer/store/app';
        export { useAgents, startAgentEventPump } from './src/renderer/store/agents';
        export { restartAgentsWhenIdle } from './src/renderer/features/settings/engines';
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
          name: 'record-settings-notices',
          setup(build) {
            build.onResolve({ filter: /\/ui$/ }, () => ({ path: 'notices', namespace: 'test' }))
            build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
              contents: 'export const toast = globalThis.recordToast;'
            }))
          }
        }
      ]
    })
    const listeners = new Map<string, Array<(event: unknown) => void>>()
    const notices: Notice[] = []
    const agentInfos = new Map<string, AgentInfo>()
    let restartAttempts = 0
    const reads: string[] = []
    const globals: Record<EngineId, JsonObject> = { pi: {}, prime: {} }
    const projects = new Map<string, JsonObject>()
    const invalid = new Set<string>()
    let pendingRead: { key: string; resolve(snapshot: SettingsSnapshot): void } | undefined
    let holdKey: string | undefined
    let heldSnapshot: SettingsSnapshot | undefined
    let prefs: AppPersistedState = {
      ...DEFAULT_APP_STATE,
      activeWorkspace: 'active',
      defaultEngine: 'prime',
      workspaces: [
        { path: 'active', name: 'active', lastOpenedAt: 0, engine: 'prime' },
        ...Array.from({ length: 8000 }, (_, index) => ({
          path: `historical-${index}`,
          name: `historical-${index}`,
          lastOpenedAt: 0
        }))
      ]
    }
    const file = (path: string, data: JsonObject) => ({
      path,
      data,
      exists: true,
      text: JSON.stringify(data),
      ...(invalid.has(path) ? { error: 'Invalid JSON' } : {})
    })
    const snapshot = (engine: EngineId, cwd: string | null): SettingsSnapshot => ({
      agentDir: engine,
      global: file(`${engine}:global`, globals[engine]),
      project: cwd
        ? {
            ...file(
              `${engine}:${cwd.toLowerCase()}`,
              projects.get(`${engine}:${cwd.toLowerCase()}`) ?? {}
            ),
            cwd,
            trust: { saved: true, fallback: 'ask', effective: true }
          }
        : null,
      isolated: true,
      envOverrides: {}
    })
    const module = { exports: {} }
    runInNewContext(bundled.outputFiles![0]!.text, {
      module,
      exports: module.exports,
      process: { env: { NODE_ENV: 'test' } },
      crypto: { randomUUID },
      setTimeout,
      clearTimeout,
      recordToast: (notice: Notice) => notices.push(notice),
      window: {
        vengeance: {
          platform: { os: 'win32' },
          on(channel: string, listener: (event: unknown) => void) {
            listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
            return () => undefined
          },
          async invoke(channel: string, args: Record<string, unknown>, agentId?: string) {
            if (channel === 'app:get-state') return prefs
            if (channel === 'engine:dispose') return
            if (channel === 'engine:restart') {
              restartAttempts += 1
              throw new Error('A sibling session is busy')
            }
            if (channel === 'engine:list') return [...agentInfos.values()]
            if (channel === 'engine:create') {
              const info: AgentInfo = {
                agentId: agentId!,
                engine: args.engine as EngineId,
                cwd: args.cwd as string,
                status: 'starting',
                sessionFile: `${agentId}.jsonl`,
                args: { engine: args.engine as EngineId, cwd: args.cwd as string },
                busy: false,
                mock: true,
                bridge: false,
                createdAt: Date.now()
              }
              agentInfos.set(agentId!, info)
              return info
            }
            assert.equal(channel, 'engine:settings')
            assert.equal(
              args.channel,
              'settings:snapshot',
              'Prime settings must not replay setters'
            )
            const engine = args.engine as EngineId
            const cwd = args.cwd as string | null
            const key = `${engine}:${cwd ?? 'global'}`
            reads.push(key)
            const next = snapshot(engine, cwd)
            if (holdKey === key) {
              holdKey = undefined
              heldSnapshot = next
              return new Promise<SettingsSnapshot>((complete) => {
                pendingRead = { key, resolve: complete }
              })
            }
            return next
          }
        }
      }
    })
    const api = module.exports as SettingsApi
    api.startAgentEventPump()
    const changed = (engine: EngineId, cwd?: string) => {
      for (const listener of listeners.get('settings:changed') ?? []) {
        listener({
          engine,
          area: 'settings',
          external: true,
          ...(cwd ? { project: { cwd, trusted: true } } : {})
        })
      }
    }
    await api.useApp.getState().load()
    await api.useAgents.getState().createAgent({ engine: 'prime', cwd: 'active' })
    const offscreen = await api.useAgents
      .getState()
      .createAgent({ engine: 'prime', cwd: 'offscreen' })
    await api.useAgents.getState().createAgent({ engine: 'pi', cwd: 'other' })
    await settle()
    assert.ok(
      reads.every((key) => !key.includes('historical')),
      'only live folders initialize'
    )
    assert.ok(reads.includes('prime:offscreen'), 'an offscreen open session seeds its baseline')
    changed('prime')
    await settle()
    globals.prime = {
      defaultModel: 'second',
      defaultProvider: 'local',
      defaultThinkingLevel: 'high',
      defaultServiceTier: 'priority',
      recentModels: ['second'],
      // pa-core serializes absent Option fields when a session first saves its thinking level.
      subagentDefaultModel: null,
      auxiliaryModel: null,
      rlmMaxDepth: null,
      idleEvictionMinutes: null,
      sessionArchiveMaxAgeDays: null,
      sessionArchiveMaxSessions: null,
      steeringMode: null,
      followUpMode: null,
      shellPath: null,
      shellCommandPrefix: null,
      npmCommand: null,
      mcpCatalogSources: null,
      skills: null,
      prompts: null,
      themes: null,
      enableSkillCommands: null,
      enableBuiltinSkills: null,
      enabledModels: null,
      allowedModels: null,
      sessionDir: null,
      requestTiming: null,
      telemetry: { enabled: null, localMirror: null, noticeShown: null },
      compaction: {
        enabled: null,
        reserveTokens: null,
        keepRecentTokens: null,
        agentCallable: null
      }
    }
    changed('prime')
    await settle()
    assert.equal(notices.length, 0, 'first native save materializes unset fields without restart')
    globals.prime = {
      ...globals.prime,
      recentModels: ['second'],
      defaultServiceTier: 'priority',
      defaultThinkingLevel: 'high',
      defaultProvider: 'local',
      defaultModel: 'second'
    }
    changed('prime')
    await settle()
    assert.equal(notices.length, 0, 'identical and native default saves stay quiet')

    projects.set('prime:offscreen', { shellCommandPrefix: 'one' })
    changed('prime', 'offscreen')
    await settle()
    assert.equal(notices.length, 1, 'startup edit in offscreen open folder offers restart')
    assert.match(notices[0]!.id!, /prime/)
    projects.set('prime:active', { shellCommandPrefix: 'two' })
    changed('prime', 'active')
    await settle()
    assert.equal(notices.length, 2)
    assert.notEqual(notices[0]!.id, notices[1]!.id, 'folders keep distinct restart actions')

    invalid.add('prime:offscreen')
    projects.set('prime:offscreen', {})
    changed('prime', 'offscreen')
    await settle()
    invalid.delete('prime:offscreen')
    projects.set('prime:offscreen', { shellCommandPrefix: 'one' })
    changed('prime', 'offscreen')
    await settle()
    assert.equal(notices.length, 2, 'invalid JSON keeps the last valid comparison baseline')

    globals.pi = { shellCommandPrefix: 'pi-only' }
    changed('pi')
    await settle()
    assert.equal(notices.length, 3)
    assert.equal(notices[2]!.id, 'settings-restart-pi')
    changed('prime', 'unknown')
    await settle()
    assert.equal(notices.length, 3, 'missing baseline alone is not restart evidence')

    holdKey = 'prime:active'
    const loading = api.useSettings.getState().load()
    await settle()
    assert.equal(pendingRead?.key, holdKey ?? 'prime:active')
    globals.prime = { ...globals.prime, shellCommandPrefix: 'startup' }
    const beforeBurst = reads.length
    const notificationsInBurst = 50
    for (let index = 0; index < notificationsInBurst; index += 1) changed('prime')
    pendingRead!.resolve(heldSnapshot!)
    await loading
    await settle()
    assert.equal(notices.length, 4, 'late sheet load cannot erase the external diff')
    assert.equal(notices[3]!.id, 'settings-restart-prime')
    assert.ok(reads.length - beforeBurst <= 2, 'notifications share a read and one follow-up')

    await api.useAgents.getState().disposeAgent(offscreen)
    projects.set('prime:offscreen', { shellCommandPrefix: 'closed' })
    changed('prime', 'offscreen')
    await settle()
    assert.equal(notices.length, 4, 'closed inactive folder releases its baseline')
    prefs = { ...prefs, activeWorkspace: 'new-folder' }
    await api.useApp.getState().load()
    await settle()
    changed('prime')
    await settle()
    assert.equal(notices.length, 4, 'switching folders does not forget the global baseline')
    changed('prime', 'ACTIVE')
    await settle()
    assert.equal(notices.length, 4, 'Windows path aliases compare the same project')
    projects.set('prime:active', { shellCommandPrefix: 'three' })
    changed('prime', 'ACTIVE')
    await settle()
    assert.equal(notices.length, 5, 'path aliases still detect a real startup change')

    const savedAgent = [...agentInfos.values()].find((info) => info.cwd === 'active')!
    const readyInfo = { ...savedAgent, status: 'ready' as const }
    agentInfos.set(savedAgent.agentId, readyInfo)
    for (const listener of listeners.get('engine:status') ?? []) {
      listener({ agentId: savedAgent.agentId, info: readyInfo })
    }
    api.useAgents
      .getState()
      .applyEvents(
        new Map([[savedAgent.agentId, [{ type: 'compaction_start', reason: 'manual' }]]])
      )
    api.restartAgentsWhenIdle([savedAgent.agentId])
    await settle()
    assert.equal(restartAttempts, 0, 'manual compaction prevents restart while phase is idle')
    api.useAgents.getState().applyEvents(
      new Map([
        [
          savedAgent.agentId,
          [
            {
              type: 'compaction_end',
              reason: 'manual',
              result: undefined,
              aborted: true,
              willRetry: false
            }
          ]
        ]
      ])
    )
    await settle()
    assert.equal(restartAttempts, 1)
    assert.equal(notices.at(-1)?.title, 'Could not restart session', 'refusal surfaces an error')
  }
)
