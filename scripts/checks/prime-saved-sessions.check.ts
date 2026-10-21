import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type {
  SessionLineage,
  SessionListResult,
  WorkspaceScan
} from '../../src/shared/api/sessions'
import { SessionIndex } from '../../src/main/features/sessions/index'
import { samePath } from '../../src/main/paths'
import { check } from './harness'

interface SavedSessionApi {
  listPrimeSessions(query: { cwd: string | null }): Promise<SessionListResult>
  discoverPrimeWorkspaces(): Promise<WorkspaceScan>
  primeSessionIdentity(path: string): Promise<{
    cwd: string
    engine: 'prime'
    lineage?: SessionLineage
  } | null>
  deletePrimeSession(path: string): Promise<void>
  renamePrimeSession(path: string, name: string): Promise<void>
}

await check(
  'Prime saved discovery validates ledger artifacts and keeps independent duplicate IDs',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vengeance-saved-lineage-'))
    const agentDir = join(directory, 'agent')
    const sessions = join(agentDir, 'sessions')
    const workspace = join(directory, 'workspace')
    const childWorkspace = join(directory, 'child-workspace')
    const parent = join(sessions, 'parent.jsonl')
    const fork = join(sessions, 'fork.jsonl')
    const deleted = join(sessions, 'deleted.jsonl')
    const imported = join(sessions, 'imported.jsonl')
    const legacy = join(sessions, 'legacy.jsonl')
    const child = join(agentDir, 'session-artifacts', 'parent', 'sub-child', 'child.jsonl')
    const unadmitted = join(agentDir, 'session-artifacts', 'parent', 'sub-unknown', 'unknown.jsonl')
    const outside = join(directory, 'unrelated', 'outside.jsonl')
    let engineCalls = 0
    let warning: string | undefined
    let includeChildren = true
    let lineageCalls = 0
    let failAfter: number | undefined
    let childDeletes = 0
    let allowRootActions = false
    let rootDeletes = 0
    let customLineage:
      | {
          sessions: { path: string; lineage: SessionLineage }[]
          excludedPaths: string[]
        }
      | undefined
    let observedRoots: string[] = []

    async function session(
      path: string,
      identifier: string,
      cwd = workspace,
      depth = 0,
      parentSession?: string
    ): Promise<void> {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        `${JSON.stringify({
          type: 'session',
          version: 3,
          id: identifier,
          cwd,
          timestamp: '2026-10-16T00:00:00Z',
          rlmDepth: depth,
          parentSession
        })}\n`
      )
    }

    try {
      await session(parent, 'parent')
      await session(fork, 'fork', workspace, 0, parent)
      await session(deleted, 'duplicate', workspace, 1, parent)
      await session(imported, 'duplicate')
      await writeFile(
        legacy,
        `${JSON.stringify({
          type: 'session',
          version: 3,
          id: 'legacy',
          cwd: workspace,
          timestamp: '2026-10-16T00:00:00Z'
        })}\n`
      )
      await session(child, 'child', childWorkspace, 1, parent)
      await session(unadmitted, 'unknown', workspace, 1, parent)
      await session(outside, 'outside', workspace, 1, parent)

      const esbuild: typeof import('esbuild') = createRequire(join(process.cwd(), 'package.json'))(
        'esbuild'
      )
      const built = await esbuild.build({
        stdin: {
          contents: `export {
          listPrimeSessions, discoverPrimeWorkspaces, primeSessionIdentity,
          deletePrimeSession, renamePrimeSession
        } from './src/main/engine/prime/sessions'`,
          resolveDir: process.cwd(),
          loader: 'ts'
        },
        bundle: true,
        format: 'cjs',
        platform: 'node',
        write: false,
        alias: { '@shared': resolve('src', 'shared') },
        plugins: [
          {
            name: 'saved-session-native-boundaries',
            setup(build) {
              build.onResolve(
                {
                  filter: /(?:^electron$|\/daemon$|\/locate$|\/sessions-native$|\/session-delete$)/
                },
                ({ path }) => ({
                  path,
                  namespace: 'fixture'
                })
              )
              build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
                loader: 'js',
                contents:
                  path === 'electron'
                    ? `export const shell = { trashItem: globalThis.trashRoot };
                    export const app = {};`
                    : path.endsWith('/locate')
                      ? 'export const getPrimeAgentDir = () => globalThis.agentDir;'
                      : path.endsWith('/session-delete')
                        ? 'export const deletePrimeChildSession = globalThis.deleteChild;'
                        : path.endsWith('/daemon')
                          ? `export const connectPrimeResident = globalThis.engineCall;
                    export const primeDaemonCommand = globalThis.engineCall;
                    export const withPrimeServiceSession = globalThis.engineCall;`
                          : `export const nativePrimeSessionLineage = globalThis.lineage;
                    export const nativePrimeSessionCommand = globalThis.engineCall;
                    export const nativePrimeDeleteChild = globalThis.engineCall;`
              }))
            }
          }
        ]
      })
      const exports: Partial<SavedSessionApi> = {}
      const module = { exports }
      runInNewContext(built.outputFiles[0]!.text, {
        exports,
        module,
        require: createRequire(join(process.cwd(), 'package.json')),
        process,
        Buffer,
        setTimeout,
        clearTimeout,
        agentDir,
        engineCall: () => {
          engineCalls++
          if (allowRootActions) return undefined
          throw new Error('Saved discovery must not start a native worker')
        },
        trashRoot: async (path: string) => {
          assert.equal(path, parent)
          rootDeletes++
        },
        deleteChild: async (path: string, _sessionId: string, lineage: SessionLineage) => {
          assert.equal(path, child)
          assert.equal(lineage.childId, 'sub-child')
          childDeletes++
        },
        lineage: async (_agentDirectory: string, directories: string[]) => {
          lineageCalls++
          if (failAfter !== undefined && lineageCalls > failAfter)
            throw new Error('Helper unavailable')
          if (customLineage) {
            observedRoots = directories
            return directories.some((path) => samePath(path, sessions))
              ? customLineage
              : { sessions: [], excludedPaths: [] }
          }
          return {
            sessions: !includeChildren
              ? []
              : [child, outside].map((path) => ({
                  path,
                  lineage: {
                    parentSessionPath: parent,
                    parentSessionId: 'parent',
                    childId: 'sub-child',
                    depth: 1,
                    runtimeKind: 'subagent'
                  }
                })),
            excludedPaths: [deleted],
            warning
          }
        }
      })
      const api = module.exports as SavedSessionApi
      const listed = await api.listPrimeSessions({ cwd: null })
      const paths = listed.sessions.map((item) => item.path)
      assert.ok(paths.includes(parent))
      assert.ok(
        paths.includes(imported),
        'A tombstone must not suppress another path with the same header ID'
      )
      assert.ok(paths.includes(child))
      assert.ok(!paths.includes(deleted))
      assert.ok(!paths.includes(outside))
      assert.equal(listed.sessions.find((item) => item.path === fork)?.lineage?.depth, 0)
      assert.equal(listed.sessions.find((item) => item.path === fork)?.lineage?.childId, undefined)
      assert.equal(
        listed.sessions.find((item) => item.path === child)?.lineage?.parentSessionId,
        'parent'
      )
      const beforeChildIdentity = lineageCalls
      assert.equal((await api.primeSessionIdentity(child))?.engine, 'prime')
      assert.equal(lineageCalls, beforeChildIdentity + 1)
      assert.equal((await api.primeSessionIdentity(child))?.lineage?.childId, 'sub-child')
      assert.equal(await api.primeSessionIdentity(deleted), null)
      assert.equal(await api.primeSessionIdentity(unadmitted), null)
      assert.equal(await api.primeSessionIdentity(outside), null)
      const healthyScan = await api.discoverPrimeWorkspaces()
      assert.ok(healthyScan.workspaces.some((item) => item.path === childWorkspace))
      assert.equal(healthyScan.complete, true)
      warning = 'Native lineage capacity reached'
      const healthyPartial = await api.listPrimeSessions({ cwd: null })
      assert.ok(healthyPartial.sessions.some((item) => item.path === child))
      assert.equal((await api.primeSessionIdentity(child))?.engine, 'prime')
      const warnedScan = await api.discoverPrimeWorkspaces()
      assert.ok(warnedScan.workspaces.some((item) => item.path === childWorkspace))
      // A lineage warning may hide child-only folders, so the scan cannot drop workspaces.
      assert.equal(warnedScan.complete, false)
      includeChildren = false
      const partial = await api.listPrimeSessions({ cwd: null })
      assert.equal(partial.warning, warning)
      assert.ok(partial.sessions.some((item) => item.path === parent))
      assert.ok(!partial.sessions.some((item) => item.path === child))
      assert.equal(engineCalls, 0)
      warning = undefined
      includeChildren = true

      const customSessions = join(agentDir, 'custom-sessions')
      const customWorkspace = join(directory, 'custom-workspace')
      const customRoot = join(customSessions, 'custom-root.jsonl')
      const customDeleted = join(customSessions, 'custom-deleted.jsonl')
      const defaultOnly = join(sessions, 'default-only.jsonl')
      const customChild = join(
        agentDir,
        'session-artifacts',
        'custom-root',
        'sub-custom-child',
        'custom-child.jsonl'
      )
      const customGrandchild = join(
        agentDir,
        'session-artifacts',
        'custom-child',
        'sub-custom-grandchild',
        'custom-grandchild.jsonl'
      )
      await session(customRoot, 'custom-root', customWorkspace)
      await session(defaultOnly, 'default-only', customWorkspace)
      await session(customDeleted, 'custom-deleted', customWorkspace, 1, customRoot)
      await session(customChild, 'custom-child', customWorkspace, 1, customRoot)
      await session(customGrandchild, 'custom-grandchild', customWorkspace, 2, customChild)
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({ sessionDir: customSessions })
      )
      customLineage = {
        sessions: [customChild, customGrandchild].map((path, index) => ({
          path,
          lineage: {
            parentSessionPath: index === 0 ? customRoot : customChild,
            depth: index + 1,
            childId: index === 0 ? 'sub-custom-child' : 'sub-custom-grandchild',
            runtimeKind: 'subagent'
          }
        })),
        excludedPaths: [customDeleted]
      }
      const scoped = await api.listPrimeSessions({ cwd: customWorkspace })
      assert.ok(
        observedRoots.some((path) => samePath(path, sessions)),
        'Scoped listing must observe the native default ledger'
      )
      assert.ok(observedRoots.some((path) => samePath(path, customSessions)))
      assert.deepEqual(
        new Set(scoped.sessions.map((item) => item.path)),
        new Set([customRoot, customChild, customGrandchild])
      )
      assert.equal(
        scoped.sessions.find((item) => item.path === customGrandchild)?.lineage?.depth,
        2
      )
      assert.equal(engineCalls, 0, 'Offline scoped family discovery must not start native workers')
      customLineage = undefined

      failAfter = lineageCalls + 1
      await api.deletePrimeSession(child)
      assert.equal(childDeletes, 1)
      assert.equal(lineageCalls, failAfter, 'Deletion must reuse its first verified child identity')
      const rootLineageCalls = lineageCalls
      assert.equal((await api.primeSessionIdentity(parent))?.lineage?.depth, 0)
      allowRootActions = true
      await api.renamePrimeSession(parent, 'Renamed root')
      await api.deletePrimeSession(parent)
      assert.equal(rootDeletes, 1)
      assert.equal(
        lineageCalls,
        rootLineageCalls,
        'Depth-zero roots must not replay child topology'
      )
      await api.primeSessionIdentity(legacy)
      assert.equal(lineageCalls, rootLineageCalls + 1, 'Missing depth must still check topology')

      const index = new SessionIndex('prime')
      await session(parent, 'parent', workspace, -1)
      assert.equal((await index.summary(parent))?.lineage, undefined)
      await api.primeSessionIdentity(parent)
      assert.equal(lineageCalls, rootLineageCalls + 2, 'Invalid depth must still check topology')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
