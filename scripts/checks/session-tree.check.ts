import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage, AssistantMessage, FlatTreeNode, RpcCommand, RpcResponse, SessionEntry, SessionTreeNode } from '../../src/shared/engine-types'
import { Emitter, type EngineHandle, type EngineHandleEvents } from '../../src/main/engine/handle'
import { mockLongSessionEntries } from '../../src/main/engine/mock-sessions'
import { locateEngine } from '../../src/main/engine/locate'
import { importPiFile } from '../../src/main/engine/runtime'
import { flattenSessionTree, requestSessionTree, sessionTreeFromEntries } from '../../src/main/engine/session-tree'
import { buildBranchTree, filterBranchTree, TREE_FILTER_MODES, type BranchTree } from '../../src/renderer/features/inspector/tree-model'
import { check } from './harness'

/** Far past the ~1000-level contextBridge limit and the ~2200 entries the engine can serialize nested. */
const DEEP_ENTRIES = 5000
const BASE_TIME = Date.UTC(2026, 0, 1)

function iso(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString()
}

function assistant(text: string, timestamp: number, toolName?: string): AssistantMessage {
  const content: AssistantMessage['content'] = toolName ? [{ type: 'toolCall', id: `call-${timestamp}`, name: toolName, arguments: {} }] : [{ type: 'text', text }]
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: toolName ? 'toolUse' : 'stop',
    timestamp
  }
}

function messageEntry(id: string, parentId: string | null, offsetMs: number, message: (timestamp: number) => AgentMessage): SessionEntry {
  return { type: 'message', id, parentId, timestamp: iso(offsetMs), message: message(BASE_TIME + offsetMs) }
}

function user(id: string, parentId: string | null, offsetMs: number, text: string): SessionEntry {
  return messageEntry(id, parentId, offsetMs, (timestamp) => ({ role: 'user', content: text, timestamp }))
}

function reply(id: string, parentId: string | null, offsetMs: number, text: string, toolName?: string): SessionEntry {
  return messageEntry(id, parentId, offsetMs, (timestamp) => assistant(text, timestamp, toolName))
}

/**
 * A small branched session in file order: a tool turn folded into one assistant node, an abandoned
 * question (labeled) next to the newer one, and the label entry as the leaf.
 */
const BRANCHED: SessionEntry[] = [
  { type: 'model_change', id: 'm0', parentId: null, timestamp: iso(0), provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  user('u1', 'm0', 1000, 'First question'),
  reply('a1', 'u1', 2000, '', 'read'),
  messageEntry('r1', 'a1', 3000, (timestamp) => ({ role: 'toolResult', toolCallId: 'call-a1', toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false, timestamp })),
  reply('a2', 'r1', 4000, 'Answer one'),
  user('u2', 'a2', 5000, 'Abandoned question'),
  reply('a3', 'u2', 6000, 'Abandoned answer'),
  user('u3', 'a2', 7000, 'Second question'),
  reply('a4', 'u3', 8000, 'Answer two'),
  { type: 'label', id: 'l1', parentId: 'a4', timestamp: iso(9000), targetId: 'u2', label: 'idea' }
]

/** pi's nested `get_tree` for BRANCHED, written out by hand. */
function branchedNested(): SessionTreeNode[] {
  const node = (id: string, children: SessionTreeNode[], label?: string): SessionTreeNode => {
    const entry = BRANCHED.find((e) => e.id === id)!
    return label ? { entry, children, label, labelTimestamp: iso(9000) } : { entry, children }
  }
  const abandoned = node('u2', [node('a3', [])], 'idea')
  const current = node('u3', [node('a4', [node('l1', [])])])
  return [node('m0', [node('u1', [node('a1', [node('r1', [node('a2', [abandoned, current])])])])])]
}

/** One line per readable node, pre-order, indented by depth. */
function describe(tree: BranchTree): string[] {
  const lines: string[] = []
  const stack = [{ node: tree.root, depth: 0 }]
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    const flags = [node.onPath ? 'path' : '', node.isLeaf ? 'leaf' : '', node.label ? `label=${node.label}@${node.labelEntryId}` : ''].filter(Boolean).join(' ')
    lines.push(`${'  '.repeat(depth)}${node.kind} [${node.entryIds.join(',')}] tip=${node.tipId} "${node.text}" ${flags}`.trimEnd())
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, depth: depth + 1 })
  }
  return lines
}

/** A linear session of `count` entries plus a two-entry side branch every thousand entries, nested like pi's getTree. */
function deepNested(count: number): { roots: SessionTreeNode[]; total: number } {
  const nodes: SessionTreeNode[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    const id = `e${i}`
    const entry = i % 2 === 0 ? user(id, i ? `e${i - 1}` : null, i * 10, `Question ${i}`) : reply(id, `e${i - 1}`, i * 10, `Answer ${i}`)
    const node: SessionTreeNode = { entry, children: [] }
    if (i > 0) nodes[i - 1]!.children.push(node)
    nodes.push(node)
    total++
    if (i > 0 && i % 1000 === 0) {
      const side: SessionTreeNode = { entry: user(`side${i}`, id, i * 10 + 1, 'Side question'), children: [] }
      side.children.push({ entry: reply(`side${i}-a`, `side${i}`, i * 10 + 2, 'Side answer'), children: [] })
      node.children.push(side)
      total += 2
    }
  }
  return { roots: [nodes[0]!], total }
}

function assertParentsFirst(nodes: FlatTreeNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    assert.ok(node.parentId === null || seen.has(node.parentId), `parent of ${node.entry.id} listed before it`)
    seen.add(node.entry.id)
  }
}

await check(`flattenSessionTree: a ${DEEP_ENTRIES}-deep linear tree with side branches flattens in pre-order`, () => {
  const { roots, total } = deepNested(DEEP_ENTRIES)
  const nodes = flattenSessionTree(roots)
  assert.equal(nodes.length, total)
  assertParentsFirst(nodes)
  const sideIndex = nodes.findIndex((n) => n.entry.id === 'side1000')
  assert.deepEqual(
    nodes.slice(sideIndex - 1, sideIndex + 3).map((n) => [n.entry.id, n.parentId]),
    [
      ['e1000', 'e999'],
      ['side1000', 'e1000'],
      ['side1000-a', 'side1000'],
      ['e1001', 'e1000']
    ],
    'the older side branch comes first, the main line follows'
  )
  assert.equal(nodes.at(-1)?.entry.id, `e${DEEP_ENTRIES - 1}`)
})

await check(`buildBranchTree: renders a ${DEEP_ENTRIES}-entry session under every filter without recursion`, () => {
  const { roots, total } = deepNested(DEEP_ENTRIES)
  const nodes = flattenSessionTree(roots)
  const leafId = `e${DEEP_ENTRIES - 1}`
  const folded = buildBranchTree(nodes, leafId)
  assert.equal(folded.forks, Math.floor((DEEP_ENTRIES - 1) / 1000))
  assert.equal(folded.abandoned, folded.forks * 2)
  const raw = buildBranchTree(nodes, leafId, true)
  assert.equal(describe(raw).length, total + 1, 'the all filter keeps every entry plus the start node')
  for (const mode of TREE_FILTER_MODES) assert.ok(filterBranchTree((mode === 'all' ? raw : folded).root, mode))
})

await check('flattenSessionTree: labels travel with their nodes; absent labels add no fields', () => {
  const nodes = flattenSessionTree(branchedNested())
  assert.deepEqual(
    nodes.map((n) => n.entry.id),
    ['m0', 'u1', 'a1', 'r1', 'a2', 'u2', 'a3', 'u3', 'a4', 'l1']
  )
  assert.deepEqual(nodes[5], { entry: BRANCHED[5], parentId: 'a2', label: 'idea', labelTimestamp: iso(9000) })
  assert.deepEqual(Object.keys(nodes[6]!), ['entry', 'parentId'])
})

await check('buildBranchTree: the flat form folds a branched sample into the readable tree', () => {
  const tree = buildBranchTree(flattenSessionTree(branchedNested()), 'l1')
  assert.deepEqual(describe(tree), [
    'start [m0] tip=m0 "Claude Sonnet 4.5" path',
    '  user [u1] tip=u1 "First question" path',
    '    assistant [a1,r1,a2] tip=a2 "Answer one" path',
    '      user [u2] tip=u2 "Abandoned question" label=idea@u2',
    '        assistant [a3] tip=a3 "Abandoned answer"',
    '      user [u3] tip=u3 "Second question" path',
    '        assistant [a4,l1] tip=a4 "Answer two" path leaf'
  ])
  assert.deepEqual([tree.abandoned, tree.forks, tree.labeled], [2, 1, 1])
  assert.deepEqual(buildBranchTree(sessionTreeFromEntries(BRANCHED), 'l1'), tree, 'built from get_entries: same readable tree')
})

await check('sessionTreeFromEntries: orphans and self parents are roots, siblings sort by time, labels resolve in order', () => {
  const entries: SessionEntry[] = [
    user('root', null, 0, 'Root'),
    reply('late', 'root', 5000, 'Written first, newer'),
    reply('early', 'root', 1000, 'Written second, older'),
    user('orphan', 'missing', 2000, 'Orphan'),
    user('self', 'self', 3000, 'Self parent'),
    { type: 'label', id: 'l1', parentId: 'late', timestamp: iso(6000), targetId: 'early', label: 'first' },
    { type: 'label', id: 'l2', parentId: 'l1', timestamp: iso(7000), targetId: 'early', label: 'second' },
    { type: 'label', id: 'l3', parentId: 'l2', timestamp: iso(8000), targetId: 'root', label: 'gone' },
    { type: 'label', id: 'l4', parentId: 'l3', timestamp: iso(9000), targetId: 'root', label: undefined }
  ]
  const nodes = sessionTreeFromEntries(entries)
  assert.deepEqual(
    nodes.map((n) => [n.entry.id, n.parentId]),
    [
      ['root', null],
      ['early', 'root'],
      ['late', 'root'],
      ['l1', 'late'],
      ['l2', 'l1'],
      ['l3', 'l2'],
      ['l4', 'l3'],
      ['orphan', null],
      ['self', null]
    ]
  )
  assert.deepEqual(nodes[1], { entry: entries[2], parentId: 'root', label: 'second', labelTimestamp: iso(7000) })
  assert.equal(nodes[0]!.label, undefined)
})

await check('mockLongSessionEntries: over 3000 entries, listed in tree pre-order', () => {
  const { entries, leafId } = mockLongSessionEntries({ firstMessage: 'Start', reply: 'Done', at: BASE_TIME }, 1500, null)
  assert.ok(entries.length > 3000)
  assert.deepEqual(
    sessionTreeFromEntries(entries).map((n) => n.entry.id),
    entries.map((e) => e.id)
  )
  assert.equal(leafId, entries.at(-1)?.id)
})

/** Engine double answering get_tree and get_entries from scripted results. */
class TreeEngine implements EngineHandle {
  readonly pid = 1
  readonly status = 'ready' as const
  readonly error = undefined
  readonly sent: string[] = []
  private readonly emitter = new Emitter<EngineHandleEvents>()
  constructor(private readonly answers: Record<'get_tree' | 'get_entries', () => RpcResponse>) {}
  async start(): Promise<void> {}
  async send(command: RpcCommand): Promise<RpcResponse> {
    this.sent.push(command.type)
    if (command.type !== 'get_tree' && command.type !== 'get_entries') throw new Error('unexpected command')
    return this.answers[command.type]()
  }
  respondUi(): void {}
  async stop(): Promise<void> {}
  stderr(): string {
    return ''
  }
  on<K extends keyof EngineHandleEvents>(event: K, listener: (payload: EngineHandleEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }
}

const STACK_ERROR: RpcResponse = { type: 'response', command: 'get_tree', success: false, error: 'Maximum call stack size exceeded' }
const ENTRIES: RpcResponse = { type: 'response', command: 'get_entries', success: true, data: { entries: BRANCHED, leafId: 'l1' } }

await check('requestSessionTree: a get_tree failure falls back to the tree built from get_entries', async () => {
  const engine = new TreeEngine({ get_tree: () => STACK_ERROR, get_entries: () => ENTRIES })
  const response = await requestSessionTree(engine, { type: 'get_tree' })
  assert.ok(response.success && response.command === 'get_tree')
  assert.deepEqual(response.data, { nodes: sessionTreeFromEntries(BRANCHED), leafId: 'l1' })
  assert.deepEqual(engine.sent, ['get_tree', 'get_entries'])

  const timedOut = new TreeEngine({
    get_tree: () => {
      throw new Error('Timed out waiting for "get_tree"')
    },
    get_entries: () => ENTRIES
  })
  assert.ok((await requestSessionTree(timedOut, { type: 'get_tree' })).success)
})

await check('requestSessionTree: when get_entries fails too, the get_tree failure stands', async () => {
  const entriesError: RpcResponse = { type: 'response', command: 'get_entries', success: false, error: 'no session' }
  const failing = new TreeEngine({ get_tree: () => STACK_ERROR, get_entries: () => entriesError })
  assert.deepEqual(await requestSessionTree(failing, { type: 'get_tree' }), STACK_ERROR)
  const crashed = new TreeEngine({
    get_tree: () => {
      throw new Error('Engine exited before answering "get_tree"')
    },
    get_entries: () => {
      throw new Error('Engine is not running')
    }
  })
  await assert.rejects(requestSessionTree(crashed, { type: 'get_tree' }), /exited before answering "get_tree"/)
})

await check('requestSessionTree: a working get_tree is used as is', async () => {
  const flat: RpcResponse = { type: 'response', command: 'get_tree', success: true, data: { nodes: [], leafId: null } }
  const engine = new TreeEngine({ get_tree: () => flat, get_entries: () => ENTRIES })
  assert.equal(await requestSessionTree(engine, { type: 'get_tree' }), flat)
  assert.deepEqual(engine.sent, ['get_tree'])
})

// ─── Parity with the installed engine's SessionManager.getTree (in-process SDK, temp files) ───

interface SdkSessionManager {
  getTree(): SessionTreeNode[]
  getEntries(): SessionEntry[]
}

async function sdkSessions(): Promise<{ open(path: string): SdkSessionManager } | null> {
  try {
    const location = await locateEngine(null)
    const sdk = await importPiFile<{ SessionManager: { open(path: string): SdkSessionManager } }>(join(location.packageDir, 'dist', 'index.js'))
    return sdk.SessionManager
  } catch (error) {
    console.warn(`  ⚠ installed engine not available, skipped SDK parity checks: ${(error as Error).message}`)
    return null
  }
}

function writeSessionFile(dir: string, name: string, entries: SessionEntry[]): string {
  const path = join(dir, `${name}.jsonl`)
  const header = { type: 'session', version: 3, id: name, timestamp: iso(0), cwd: dir }
  writeFileSync(path, [header, ...entries].map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const parityRoot = mkdtempSync(join(tmpdir(), 'vengeance-tree-check-'))
const sessionsDir = join(parityRoot, 'sessions')
mkdirSync(join(parityRoot, 'agent'), { recursive: true })
mkdirSync(sessionsDir, { recursive: true })
// Never the user's real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = join(parityRoot, 'agent')
try {
  const sessions = await sdkSessions()
  if (sessions) {
    const parity = (name: string, entries: SessionEntry[]) => {
      const manager = sessions.open(writeSessionFile(sessionsDir, name, entries))
      assert.deepEqual(sessionTreeFromEntries(manager.getEntries()), flattenSessionTree(manager.getTree()))
    }

    await check('sessionTreeFromEntries matches SessionManager.getTree: branched and labeled', () => parity('branched', BRANCHED))

    await check('sessionTreeFromEntries matches SessionManager.getTree: orphans, self parents, unsorted siblings, relabels', () => {
      parity('edge', [
        user('root', null, 0, 'Root'),
        reply('late', 'root', 5000, 'Newer'),
        reply('early', 'root', 1000, 'Older'),
        user('orphan', 'missing', 2000, 'Orphan'),
        user('self', 'self', 3000, 'Self parent'),
        { type: 'label', id: 'l1', parentId: 'late', timestamp: iso(6000), targetId: 'early', label: 'first' },
        { type: 'label', id: 'l2', parentId: 'l1', timestamp: iso(7000), targetId: 'early', label: 'second' },
        { type: 'label', id: 'l3', parentId: 'l2', timestamp: iso(8000), targetId: 'root', label: 'gone' },
        { type: 'label', id: 'l4', parentId: 'l3', timestamp: iso(9000), targetId: 'root', label: undefined }
      ])
    })

    await check('sessionTreeFromEntries matches SessionManager.getTree: the long mock session (3000+ entries)', () => {
      parity('long', mockLongSessionEntries({ firstMessage: 'Start', reply: 'Done', at: BASE_TIME }, 1500, null).entries)
    })
  }
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  rmSync(parityRoot, { recursive: true, force: true })
}

await check('buildBranchTree: subagent notices read as subagent events, wake-ups fold away, relayed replies read as answers', () => {
  const runId = '0e38f601-1c30-4021-a60c-fa0d664c5cda'
  const notify = 'Background task completed: **worker**\n\nworker:\nFixed the tree jump.\n…\nFull output: C:\Users\dev\out.md (5 KB, 31 lines). Read it if needed.'
  const entries: SessionEntry[] = [
    user('u1', null, 0, 'Fix the tree'),
    messageEntry('a1', 'u1', 1, (t) => assistant('Delegated', t)),
    { type: 'custom_message', id: 'c1', parentId: 'a1', timestamp: iso(2), customType: 'subagent-notify', content: notify, display: true, details: { runs: [{ agent: 'worker', status: 'completed', runId }] } },
    { type: 'custom_message', id: 'c2', parentId: 'c1', timestamp: iso(3), customType: 'subagent_control_notice', content: `Subagent needs attention: worker\nRun: ${runId}`, display: true, details: { event: { type: 'long-tool', message: "worker has had tool 'bash' open for 240s", runId, agent: 'worker' } } },
    user('u2', 'c2', 4, 'Inspect subagent updates above. Answer pending supervisor requests within your authority.'),
    messageEntry('a2', 'u2', 5, (t) => assistant('All done', t))
  ]
  const tree = buildBranchTree(sessionTreeFromEntries(entries), 'a2')
  const lines = describe(tree)
  assert.ok(lines.some((line) => line.includes('subagent [c1]') && line.includes('"worker finished · Fixed the tree jump."')), lines.join('\n'))
  assert.ok(lines.some((line) => line.startsWith('        subagent [c2') && line.includes(`"worker has had tool 'bash' open for 240s"`)), lines.join('\n'))
  assert.ok(!lines.some((line) => line.includes('Inspect subagent updates above')), 'the wake prompt is not a node')
  assert.ok(!lines.some((line) => line.includes(runId) || line.includes('C:\Users')), 'no run ids or paths')
  const all = describe(buildBranchTree(sessionTreeFromEntries(entries), 'a2', true))
  assert.ok(all.some((line) => line.includes('meta [u2]') && line.includes('Woke up for subagent updates')), all.join('\n'))
})
