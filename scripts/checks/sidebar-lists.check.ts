import { strict as assert } from 'node:assert'
import { DEFAULT_APP_STATE, type AppPersistedState, type Workspace } from '../../src/shared/api/app'
import type { SessionListItem, WorkspaceDiscoveryResult } from '../../src/shared/api/sessions'
import { partitionSessions } from '../../src/renderer/features/sessions/model'
import { reconcileWorkspaces as reconcile } from '../../src/renderer/store/workspace-reconcile'
import { check } from './harness'

/** Windows-style comparable paths, like the renderer's `normalizePath` there. */
const key = (path: string) => path.toLowerCase()
const reconcileWorkspaces = (prefs: AppPersistedState, discovery: WorkspaceDiscoveryResult) =>
  reconcile(prefs, discovery, key)

const ROOT = 'D:\\qa\\sessions'
const CWD = 'D:\\qa\\workspace'

function session(name: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return {
    path: `${ROOT}\\${name}.jsonl`,
    id: name,
    cwd: CWD,
    name,
    createdAt: 0,
    modifiedAt: 0,
    messageCount: 1,
    firstMessage: name,
    searchText: name,
    engine: 'pi',
    ...extra
  }
}

function partition(
  listed: SessionListItem[],
  options: { pinned?: string[]; searching?: boolean } = {}
) {
  const pinned = new Set((options.pinned ?? []).map(key))
  const result = partitionSessions(listed, {
    key,
    skip: () => false,
    pinned: (item) => pinned.has(key(item.path)),
    searching: options.searching ?? false
  })
  return {
    top: result.items.map((item) => item.id),
    under: Object.fromEntries(
      [...result.subagentsByParent].map(([parent, children]) => [
        parent,
        children.map((child) => child.id)
      ])
    )
  }
}

/** The session name the subagents extension gives a child. */
const childName = (agent: string) => `subagent-${agent}-0b5c1f3e-8d2a-4c7b-9e61-3f4a5b6c7d8e-0`

const parent = session('parent')
const child = session('child', { name: childName('worker'), parentSessionPath: parent.path })
const grandchild = session('grandchild', {
  name: childName('scout'),
  parentSessionPath: child.path
})
const runChild = session('run-child', {
  subagentRun: { parentPath: parent.path, runId: 'run1' }
})
const fork = session('fork', { name: child.name, parentSessionPath: child.path })
const mainFork = session('main-fork', { parentSessionPath: parent.path })

await check(
  'partitionSessions: subagent sessions and their own subagents sit under the top-level parent',
  () => {
    const { top, under } = partition([parent, child, grandchild, runChild])
    assert.deepEqual(top, ['parent'])
    assert.deepEqual(under[key(parent.path)], [child.id, grandchild.id, runChild.id])
  }
)

await check('partitionSessions: a fork of a subagent session is a conversation of its own', () => {
  const { top, under } = partition([parent, child, fork, mainFork])
  assert.deepEqual(top, ['parent', fork.id, mainFork.id])
  assert.deepEqual(under[key(parent.path)], [child.id])
})

await check('partitionSessions: a pinned subagent session stays in the list', () => {
  const { top, under } = partition([parent, child, grandchild], { pinned: [child.path] })
  assert.deepEqual(top, ['parent', child.id])
  assert.deepEqual(under[key(child.path)], [grandchild.id])
})

await check(
  'partitionSessions: a subagent session whose ancestor is gone shows only while searching',
  () => {
    assert.deepEqual(partition([child, grandchild]).top, [])
    assert.deepEqual(partition([child, grandchild], { searching: true }).top, [
      child.id,
      grandchild.id
    ])
    const first = session('first', {
      name: childName('first'),
      parentSessionPath: `${ROOT}\\second.jsonl`
    })
    const second = session('second', { name: childName('second'), parentSessionPath: first.path })
    assert.deepEqual(partition([first, second]).top, [], 'a parent loop has no top-level ancestor')
  }
)

function workspace(name: string, extra: Partial<Workspace> = {}): Workspace {
  return { path: `D:\\work\\${name}`, name, lastOpenedAt: 0, engine: 'pi', ...extra }
}

function prefs(workspaces: Workspace[], extra: Partial<AppPersistedState> = {}): AppPersistedState {
  return { ...DEFAULT_APP_STATE, workspaces, ...extra }
}

function scan(extra: Partial<WorkspaceDiscoveryResult> = {}): WorkspaceDiscoveryResult {
  return { workspaces: [], gone: [], complete: true, ...extra }
}

const names = (workspaces: Workspace[]) => workspaces.map((item) => item.name).sort()

await check(
  'reconcileWorkspaces: a complete scan drops discovered folders it no longer finds',
  () => {
    const found = workspace('found')
    const stale = workspace('stale')
    const opened = workspace('opened', { lastOpenedAt: 1 })
    const state = prefs([found, stale, opened])
    const discovery = scan({ workspaces: [{ path: found.path, lastActivityAt: 1 }] })
    assert.deepEqual(names(reconcileWorkspaces(state, discovery)), ['found', 'opened'])
    const partial = reconcileWorkspaces(state, { ...discovery, complete: false })
    assert.equal(partial, state.workspaces, 'an incomplete scan changes nothing')
  }
)

await check(
  'reconcileWorkspaces: deleted folders leave unless active, pinned or holding a restored tab',
  () => {
    const deleted = workspace('deleted', { lastOpenedAt: 1 })
    const active = workspace('active', { lastOpenedAt: 1 })
    const pinned = workspace('pinned', { pinned: true })
    const restored = workspace('restored')
    const state = prefs([deleted, active, pinned, restored], {
      activeWorkspace: active.path,
      openSessions: [
        { path: `${restored.path}\\s.jsonl`, cwd: restored.path.toUpperCase(), engine: 'pi' }
      ]
    })
    const gone = [deleted.path, active.path, pinned.path, restored.path]
    const kept = reconcileWorkspaces(state, scan({ gone, complete: false }))
    assert.deepEqual(names(kept), ['active', 'pinned', 'restored'])
  }
)

await check(
  'reconcileWorkspaces: new folders join unless removed, and an unchanged list stays the same array',
  () => {
    const known = workspace('known', { lastOpenedAt: 1 })
    const state = prefs([known], {
      features: { sessions: { hiddenWorkspaces: ['D:\\work\\HIDDEN'] } }
    })
    const discovery = scan({
      workspaces: [
        { path: known.path, lastActivityAt: 1 },
        { path: 'D:\\work\\new', lastActivityAt: 1, engine: 'prime' },
        { path: 'D:\\work\\hidden', lastActivityAt: 1 }
      ]
    })
    const next = reconcileWorkspaces(state, discovery)
    assert.deepEqual(names(next), ['known', 'new'])
    assert.equal(next.find((item) => item.name === 'new')?.engine, 'prime')
    assert.equal(next.find((item) => item.name === 'new')?.lastOpenedAt, 0)
    const settled = prefs(next, { features: state.features })
    assert.equal(reconcileWorkspaces(settled, discovery), settled.workspaces)
  }
)
