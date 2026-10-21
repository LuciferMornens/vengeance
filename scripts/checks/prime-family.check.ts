import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { AgentInfo, BackgroundAgentInfo } from '../../src/shared/api/engine'
import type { SessionLineage, SessionListItem } from '../../src/shared/api/sessions'
import type * as FamilyModule from '../../src/renderer/features/sessions/prime-family-model'
import { normalizePrimeLineage, normalizeState } from '../../src/main/engine/prime/normalize'
import { sessionIdentityPath } from '../../src/shared/session-identity'
import { check } from './harness'

const esbuild: typeof import('esbuild') = createRequire(resolve('package.json'))('esbuild')
const bundled = await esbuild.build({
  entryPoints: [resolve('src/renderer/features/sessions/prime-family-model.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  alias: { '@shared': resolve('src/shared') },
  logLevel: 'silent'
})
const exported = { exports: {} }
runInNewContext(bundled.outputFiles[0]!.text, {
  module: exported,
  exports: exported.exports
})
const { buildPrimeSessionFamilies, primeFamilyNode, primeFamilyOrphans } =
  exported.exports as typeof FamilyModule
const WORKSPACE = 'D:\\qa\\workspace'
const OTHER_WORKSPACE = 'D:\\qa\\other'
const PARENT_PATH = 'D:\\qa\\sessions\\parent.jsonl'
const CHILD_PATH = 'D:\\qa\\artifacts\\child.jsonl'
const COPIED_PATH = 'D:\\qa\\sessions\\imported-parent.jsonl'

function saved(
  path: string,
  id: string,
  lineage?: SessionLineage,
  parentSessionPath?: string
): SessionListItem {
  return {
    engine: 'prime',
    path,
    id,
    cwd: WORKSPACE,
    createdAt: 0,
    modifiedAt: 0,
    messageCount: 1,
    firstMessage: id,
    searchText: id,
    lineage,
    parentSessionPath
  }
}

function resident(id: string, sessionPath: string, lineage?: SessionLineage): BackgroundAgentInfo {
  return { engine: 'prime', id, sessionPath, cwd: WORKSPACE, status: 'idle', busy: false, lineage }
}

function project(sessions: SessionListItem[], background: BackgroundAgentInfo[] = []) {
  return buildPrimeSessionFamilies({ open: [], dormant: [], saved: sessions, background })
}

await check('Prime native state retains independent runtime and saved family identities', () => {
  const native = {
    runtimeKind: 'subagent',
    rlmDepth: 1,
    rlmChildId: 'sub-review',
    parentActiveSessionId: 'parent-live',
    parentSessionId: 'parent-saved',
    parentSessionPath: PARENT_PATH
  }
  assert.deepEqual(normalizeState(native, {}).lineage, {
    parentSessionPath: PARENT_PATH,
    parentSessionId: 'parent-saved',
    parentNativeAgentId: 'parent-live',
    depth: 1,
    childId: 'sub-review',
    runtimeKind: 'subagent'
  })
  assert.equal(normalizePrimeLineage({}), undefined)
  assert.equal(normalizePrimeLineage({ rlmDepth: -1 }), undefined)
  assert.equal(
    sessionIdentityPath('\\\\?\\UNC\\SERVER\\share\\parent.jsonl'),
    sessionIdentityPath('//server/share/parent.jsonl')
  )
})

await check(
  'Prime spawn lineage nests children and grandchildren while roots and forks stay separate',
  () => {
    const grandchildPath = 'D:\\qa\\artifacts\\grandchild.jsonl'
    const root = saved(PARENT_PATH, 'parent', { depth: 0 })
    const child = saved(CHILD_PATH, 'child', {
      parentSessionPath: PARENT_PATH,
      depth: 1,
      childId: 'sub-child'
    })
    const grandchild = saved(grandchildPath, 'grandchild', {
      parentSessionPath: CHILD_PATH,
      depth: 2,
      childId: 'sub-grandchild'
    })
    const createdRoot = saved(
      'D:\\qa\\sessions\\created.jsonl',
      'created',
      { depth: 0 },
      PARENT_PATH
    )
    const fork = saved('D:\\qa\\sessions\\fork.jsonl', 'fork', { depth: 1 }, CHILD_PATH)
    const families = project([root, child, grandchild, createdRoot, fork])
    assert.equal(primeFamilyNode(families, PARENT_PATH)?.children.length, 1)
    assert.equal(primeFamilyNode(families, CHILD_PATH)?.children[0]?.path, grandchildPath)
    assert.equal(primeFamilyNode(families, createdRoot.path)?.child, false)
    assert.equal(primeFamilyNode(families, fork.path)?.child, false)
    assert.equal(families.nodes.filter((node) => !node.child).length, 3)
  }
)

await check(
  'Saved copies sharing header IDs remain distinct; explicit parent paths beat imported ID hints',
  () => {
    const parent = saved(PARENT_PATH, 'copied-id', { depth: 0 })
    const copy = saved(COPIED_PATH, 'copied-id', { depth: 0 })
    const child = saved(CHILD_PATH, 'child', {
      depth: 1,
      childId: 'sub-child',
      parentSessionId: 'copied-id',
      parentSessionPath: PARENT_PATH
    })
    const families = project([parent, copy, child])
    assert.equal(families.nodes.length, 3)
    assert.equal(
      primeFamilyNode(families, CHILD_PATH)?.parent,
      primeFamilyNode(families, PARENT_PATH)?.key
    )
    assert.equal(primeFamilyNode(families, COPIED_PATH)?.children.length, 0)
    const missingParent = project([copy, child])
    assert.equal(primeFamilyNode(missingParent, CHILD_PATH)?.parent, undefined)
    assert.equal(primeFamilyOrphans(missingParent, () => true, true).length, 1)
  }
)

await check(
  'Prime aliases deduplicate background and open handles without conflating Engine sessions',
  () => {
    const lineage = { depth: 1, parentSessionPath: PARENT_PATH, childId: 'sub-child' }
    const background = resident('child-live', `\\\\?\\${CHILD_PATH.toUpperCase()}`, lineage)
    const open: AgentInfo = {
      agentId: 'vengeance-child',
      engine: 'prime',
      nativeAgentId: 'child-live',
      cwd: WORKSPACE,
      status: 'ready',
      mock: false,
      busy: false,
      bridge: true,
      sessionFile: CHILD_PATH,
      lineage: { depth: 1, parentSessionPath: PARENT_PATH, runtimeKind: 'top-level' },
      createdAt: 0,
      args: { engine: 'prime', cwd: WORKSPACE }
    }
    const families = buildPrimeSessionFamilies({
      open: [open, { ...open, agentId: 'pi-copy', engine: 'pi' }],
      dormant: [{ path: CHILD_PATH, cwd: WORKSPACE, engine: 'prime', lineage }],
      saved: [saved(CHILD_PATH, 'child', lineage)],
      background: [background, background]
    })
    assert.equal(families.nodes.length, 1)
    const node = primeFamilyNode(families, CHILD_PATH)
    assert.equal(node?.open?.agentId, 'vengeance-child')
    assert.equal(node?.child, true)
    assert.equal(node?.lineage?.childId, 'sub-child')
  }
)

await check('Missing, filtered and cyclic parent bindings leave child work searchable', () => {
  const parent = saved(PARENT_PATH, 'parent', { depth: 0 })
  parent.cwd = OTHER_WORKSPACE
  const child = saved(CHILD_PATH, 'child', {
    depth: 1,
    childId: 'child',
    parentSessionPath: PARENT_PATH
  })
  const families = project([parent, child])
  const inWorkspace = (cwd: string) => cwd === WORKSPACE
  assert.equal(primeFamilyOrphans(families, inWorkspace, true)[0]?.path, CHILD_PATH)
  assert.equal(primeFamilyOrphans(families, () => true, true).length, 0)
  const cycle = project([
    saved(PARENT_PATH, 'parent', { childId: 'parent', parentSessionPath: CHILD_PATH }),
    child
  ])
  assert.equal(primeFamilyOrphans(cycle, () => true, true).length, 1)
  assert.equal(cycle.nodes.flatMap((node) => node.children).length, 1)
})

await check(
  'Daemon-scoped native IDs cannot merge different files or choose an unrelated parent',
  () => {
    const first = resident('shared-native-id', PARENT_PATH, { depth: 0 })
    const second = resident('shared-native-id', COPIED_PATH, { depth: 0 })
    const child = saved(CHILD_PATH, 'child', {
      childId: 'sub-child',
      depth: 1,
      parentNativeAgentId: first.id
    })
    const ambiguous = project([child], [first, second])
    assert.equal(ambiguous.nodes.length, 3)
    assert.equal(primeFamilyNode(ambiguous, undefined, first.id), undefined)
    assert.equal(primeFamilyNode(ambiguous, CHILD_PATH)?.parent, undefined)
    assert.equal(primeFamilyOrphans(ambiguous, () => true, true).length, 1)
    const precise = project(
      [{ ...child, lineage: { ...child.lineage, parentSessionPath: PARENT_PATH } }],
      [first, second]
    )
    assert.equal(
      primeFamilyNode(precise, CHILD_PATH)?.parent,
      primeFamilyNode(precise, PARENT_PATH)?.key
    )
    assert.equal(primeFamilyNode(precise, COPIED_PATH)?.children.length, 0)
    const unresolvedHint = { ...first, sessionPath: undefined }
    const savedParent = saved(PARENT_PATH, 'parent', { depth: 0 })
    const concreteParent = project(
      [savedParent, { ...child, lineage: { ...child.lineage, parentSessionPath: PARENT_PATH } }],
      [unresolvedHint]
    )
    assert.equal(
      primeFamilyNode(concreteParent, CHILD_PATH)?.parent,
      primeFamilyNode(concreteParent, PARENT_PATH)?.key,
      'an exact saved parent path precedes a resident whose file metadata has not arrived'
    )
  }
)

await check(
  'Saved orphan child histories surface only while searching; live ones always do',
  () => {
    const lineage = { depth: 1, childId: 'sub-child', parentSessionPath: PARENT_PATH }
    const grandchildPath = 'D:\\qa\\artifacts\\grandchild.jsonl'
    const grandchildLineage = { depth: 2, childId: 'sub-grandchild', parentSessionPath: CHILD_PATH }
    const savedOnly = project([
      saved(CHILD_PATH, 'child', lineage),
      saved(grandchildPath, 'grandchild', grandchildLineage)
    ])
    assert.equal(primeFamilyOrphans(savedOnly, () => true, false).length, 0)
    assert.equal(primeFamilyOrphans(savedOnly, () => true, true)[0]?.path, CHILD_PATH)

    const running = project(
      [saved(CHILD_PATH, 'child', lineage)],
      [resident('child-live', CHILD_PATH, lineage)]
    )
    assert.equal(primeFamilyOrphans(running, () => true, false)[0]?.path, CHILD_PATH)

    const runningGrandchild = project(
      [saved(CHILD_PATH, 'child', lineage), saved(grandchildPath, 'grandchild', grandchildLineage)],
      [resident('grandchild-live', grandchildPath, grandchildLineage)]
    )
    assert.equal(
      primeFamilyOrphans(runningGrandchild, () => true, false)[0]?.path,
      CHILD_PATH,
      'a saved child stays reachable while work below it runs'
    )
  }
)

await check(
  'Prime family projection handles thousands of histories and repeated resident aliases',
  () => {
    const ROOT_COUNT = 1200
    const CHILDREN_PER_ROOT = 3
    const MAX_PROJECTION_MS = 1500
    const sessions: SessionListItem[] = []
    const background: BackgroundAgentInfo[] = []
    for (let root = 0; root < ROOT_COUNT; root++) {
      const parentPath = `D:\\qa\\sessions\\parent-${root}.jsonl`
      sessions.push(saved(parentPath, `copied-${root % 2}`, { depth: 0 }))
      for (let child = 0; child < CHILDREN_PER_ROOT; child++) {
        const path = `D:\\qa\\artifacts\\child-${root}-${child}.jsonl`
        const lineage = { depth: 1, childId: `sub-${root}-${child}`, parentSessionPath: parentPath }
        sessions.push(saved(path, `child-${root}-${child}`, lineage))
        const live = resident(`live-${root}-${child}`, path, lineage)
        background.push(live, live)
      }
    }
    const started = performance.now()
    const families = project(sessions, background)
    const elapsed = performance.now() - started
    assert.equal(families.nodes.length, ROOT_COUNT * (CHILDREN_PER_ROOT + 1))
    assert.equal(families.nodes.filter((node) => !node.child).length, ROOT_COUNT)
    assert.equal(
      families.nodes.filter((node) => node.children.length === CHILDREN_PER_ROOT).length,
      ROOT_COUNT
    )
    assert.ok(elapsed < MAX_PROJECTION_MS, `Family projection took ${elapsed.toFixed(0)}ms`)
  }
)
