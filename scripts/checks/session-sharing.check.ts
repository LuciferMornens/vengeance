import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { AgentInfo } from '../../src/shared/api/engine'
import type {
  ShareReadiness,
  ShareSessionArgs,
  ShareSessionResult,
  SessionIdentity
} from '../../src/shared/api/sessions'
import type { RpcCommand } from '../../src/shared/engine-types'
import { check } from './harness'

type ShareHandler = (args: ShareSessionArgs) => Promise<ShareReadiness | ShareSessionResult>
type DescribeHandler = (path: string) => Promise<SessionIdentity & { cwdExists: boolean }>

async function sharingFixture(savedEngine: 'pi' | 'prime' = 'pi') {
  const root = process.cwd()
  const esbuild: typeof import('esbuild') = createRequire(join(root, 'package.json'))('esbuild')
  const bundled = await esbuild.build({
    entryPoints: [join(root, 'src', 'main', 'ipc', 'sessions.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [
      {
        name: 'session-sharing-boundaries',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            args.kind === 'entry-point' ? undefined : { path: args.path, external: true }
          )
        }
      }
    ]
  })
  const workspace = resolve(root, 'sharing-fixture-workspace')
  const account = resolve(root, 'sharing-fixture-account')
  const source = join(workspace, 'session.jsonl')
  const agents = new Map<string, Pick<AgentInfo, 'agentId' | 'engine' | 'cwd' | 'sessionFile'>>()
  const handlers = new Map<string, unknown>()
  const calls: Array<{ operation: string; args: unknown }> = []
  const radiusResult: ShareSessionResult = {
    destination: 'radius',
    url: 'https://radius.test/shared'
  }
  const gistResult: ShareSessionResult = {
    destination: 'gist',
    url: 'https://gist.github.com/test/shared',
    gistUrl: 'https://gist.github.com/test/shared'
  }
  const unavailable = new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`Unexpected session side effect: ${String(property)}`)
      }
    }
  )
  const dependencies: Record<string, unknown> = {
    '@shared/api/engine': {
      isEngineId: (value: string) => value === 'pi' || value === 'prime',
      normalizeEngineId: (value: string | undefined) => value ?? 'pi'
    },
    '../env': { env: { mock: false } },
    '../app-state': { appState: { getPrefs: () => ({ openSessions: [], workspaces: [] }) } },
    './handle': {
      handle: (channel: string, handler: unknown) => handlers.set(channel, handler),
      broadcast: () => undefined,
      onQuit: () => undefined
    },
    '../features/sessions/service': {
      SessionsWatcher: class {
        close() {}
      },
      sessionCwd: async (_override: string, path: string) => {
        assert.equal(path, source)
        return workspace
      }
    },
    '../features/settings/agent-dir': { agentDir: () => account },
    '../engine/prime/sessions': {
      primeSessionIdentity: async (path: string) => {
        assert.equal(path, source)
        calls.push({ operation: 'prime-identity', args: path })
        return savedEngine === 'prime'
          ? { cwd: workspace, engine: 'prime', lineage: { depth: 1, childId: 'sub-child' } }
          : null
      }
    },
    '../features/launch/trust': {
      trustPreflight: async (_override: string, cwd: string) => {
        calls.push({ operation: 'trust', args: cwd })
        return { engineDefault: false }
      }
    },
    '../engine/sdk-host/client': {
      sdkHostCall: async (override: string, operation: string, args: unknown) => {
        assert.equal(override, 'selected-pi')
        calls.push({ operation, args })
        return operation === 'share-readiness'
          ? { ready: true, destination: 'radius' }
          : radiusResult
      }
    },
    '../features/sessions/share': {
      shareReadiness: async () => {
        calls.push({ operation: 'gist-readiness', args: null })
        return { ready: true, destination: 'gist' }
      },
      uploadGistHtml: async (htmlPath: string) => {
        calls.push({ operation: 'gist-upload', args: htmlPath })
        return gistResult
      }
    },
    '../paths': {
      samePath: (first: string, second: string) => first === second,
      directoryExists: async (path: string) => path === workspace
    }
  }
  const nodeRequire = createRequire(join(root, 'package.json'))
  const module = { exports: {} }
  runInNewContext(bundled.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (specifier: string) =>
      specifier.startsWith('node:')
        ? nodeRequire(specifier)
        : (dependencies[specifier] ?? unavailable),
    setTimeout
  })
  const api = module.exports as { registerSessionsIpc(context: unknown): void }
  api.registerSessionsIpc({
    engineOverridePath: () => 'selected-pi',
    manager: {
      list: () => [...agents.values()],
      get: (agentId: string) => agents.get(agentId),
      command: async (agentId: string, command: RpcCommand) => {
        calls.push({ operation: command.type, args: { agentId, command } })
        return {
          type: 'response',
          command: command.type,
          success: true,
          data:
            command.type === 'share_readiness'
              ? { ready: true, destination: 'radius' }
              : radiusResult
        }
      }
    }
  })
  return {
    workspace,
    account,
    source,
    agents,
    calls,
    radiusResult,
    gistResult,
    invoke: (channel: string, args: ShareSessionArgs) =>
      (handlers.get(channel) as ShareHandler)(args),
    describe: () => (handlers.get('sessions:describe') as DescribeHandler)(source)
  }
}

await check('session describe verifies a Prime identity once per request', async () => {
  const fixture = await sharingFixture('prime')
  assert.deepEqual(structuredClone(await fixture.describe()), {
    cwd: fixture.workspace,
    engine: 'prime',
    cwdExists: true
  })
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0]?.operation, 'prime-identity')
  await fixture.describe()
  assert.equal(fixture.calls.length, 2, 'Identity must be revalidated for the next request')
})

await check(
  'sharing uses the live native engine and the destination reviewed by the user',
  async () => {
    const fixture = await sharingFixture()
    fixture.agents.set('live', {
      agentId: 'live',
      engine: 'pi',
      cwd: fixture.workspace,
      sessionFile: fixture.source
    })
    assert.deepEqual(
      await fixture.invoke('sessions:share-readiness', { agentId: 'live', sessionPath: '' }),
      { ready: true, destination: 'radius' }
    )
    assert.deepEqual(
      await fixture.invoke('sessions:share', {
        agentId: 'live',
        sessionPath: '',
        destination: 'radius'
      }),
      fixture.radiusResult
    )
    assert.deepEqual(
      fixture.calls.map((call) => call.operation),
      ['share_readiness', 'share_session']
    )
    assert.equal(
      (fixture.calls[1]!.args as { command: { expectedDestination: string } }).command
        .expectedDestination,
      'radius'
    )
  }
)

await check(
  'saved sharing scopes native readiness and export to the saved workspace and trust',
  async () => {
    const fixture = await sharingFixture()
    await fixture.invoke('sessions:share-readiness', { sessionPath: fixture.source, engine: 'pi' })
    await fixture.invoke('sessions:share', {
      sessionPath: fixture.source,
      engine: 'pi',
      destination: 'radius'
    })
    const expectedScope = {
      cwd: fixture.workspace,
      agentDir: fixture.account,
      projectTrusted: false
    }
    assert.deepEqual(
      structuredClone(fixture.calls.find((call) => call.operation === 'share-readiness')?.args),
      expectedScope
    )
    assert.deepEqual(
      structuredClone(fixture.calls.find((call) => call.operation === 'share-session')?.args),
      {
        ...expectedScope,
        sessionPath: fixture.source,
        expectedDestination: 'radius'
      }
    )
    assert.equal(
      fixture.calls.some((call) => call.operation === 'gist-upload'),
      false
    )
  }
)

await check(
  'sharing a saved path already open uses its live branch instead of reconstructing history',
  async () => {
    const fixture = await sharingFixture()
    fixture.agents.set('live', {
      agentId: 'live',
      engine: 'pi',
      cwd: fixture.workspace,
      sessionFile: fixture.source
    })
    await fixture.invoke('sessions:share', { sessionPath: fixture.source, destination: 'radius' })
    assert.deepEqual(
      fixture.calls.map((call) => call.operation),
      ['share_session']
    )
  }
)

await check('Engine 2 keeps its native HTML and gist sharing path', async () => {
  const fixture = await sharingFixture()
  fixture.agents.set('prime', {
    agentId: 'prime',
    engine: 'prime',
    cwd: fixture.workspace,
    sessionFile: fixture.source
  })
  await fixture.invoke('sessions:share-readiness', { agentId: 'prime', sessionPath: '' })
  assert.deepEqual(
    await fixture.invoke('sessions:share', {
      agentId: 'prime',
      sessionPath: '',
      destination: 'gist'
    }),
    fixture.gistResult
  )
  assert.deepEqual(
    fixture.calls.map((call) => call.operation),
    ['gist-readiness', 'export_html', 'gist-upload']
  )
})

await check('an expired live target and missing destination cannot publish', async () => {
  const fixture = await sharingFixture()
  await assert.rejects(
    fixture.invoke('sessions:share', { agentId: 'closed', sessionPath: '', destination: 'radius' }),
    /no longer open/
  )
  await assert.rejects(
    fixture.invoke('sessions:share', { sessionPath: fixture.source }),
    /Review the sharing destination/
  )
  assert.deepEqual(fixture.calls, [])
})

await check('an engine handoff cannot turn a reviewed Radius upload into a gist', async () => {
  const fixture = await sharingFixture()
  fixture.agents.set('handoff', {
    agentId: 'handoff',
    engine: 'prime',
    cwd: fixture.workspace,
    sessionFile: fixture.source
  })
  await assert.rejects(
    fixture.invoke('sessions:share', {
      agentId: 'handoff',
      sessionPath: fixture.source,
      destination: 'radius'
    }),
    /destination changed/
  )
  assert.deepEqual(fixture.calls, [])
})
