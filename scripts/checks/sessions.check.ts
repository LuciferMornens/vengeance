import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  RpcResponse,
  RpcSessionState,
  SessionEntry,
  SessionStats
} from '../../src/shared/engine-types'
import { withAbsoluteSessionFile } from '../../src/main/engine/manager'
import { sessionTreeFromEntries } from '../../src/main/engine/session-tree'
import { restorableOpenSessions } from '../../src/main/features/sessions/open-sessions'
import { buildBranchTree, type BranchNode } from '../../src/renderer/features/inspector/tree-model'
import { agentSessionFile } from '../../src/renderer/features/sessions/model'
import { createAgentState } from '../../src/renderer/store/agent-state'
import { check } from './harness'

const sessionState: RpcSessionState = {
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionId: 's1',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0
}

function stateReply(sessionFile: string | undefined): RpcResponse {
  return {
    type: 'response',
    command: 'get_state',
    success: true,
    data: { ...sessionState, sessionFile }
  }
}

function replyFile(response: RpcResponse): string | undefined {
  assert.ok(
    response.success &&
      (response.command === 'get_state' || response.command === 'get_session_stats')
  )
  return (response.data as RpcSessionState | SessionStats).sessionFile
}

await check(
  'withAbsoluteSessionFile: a relative sessionDir path resolves against the engine cwd',
  () => {
    const cwd = resolve(tmpdir(), 'project')
    const relative = join('.project-sessions', 'session.jsonl')
    assert.equal(replyFile(withAbsoluteSessionFile(stateReply(relative), cwd)), join(cwd, relative))

    const absolute = resolve(tmpdir(), 'sessions', 'session.jsonl')
    assert.equal(replyFile(withAbsoluteSessionFile(stateReply(absolute), cwd)), absolute)
    assert.equal(replyFile(withAbsoluteSessionFile(stateReply(undefined), cwd)), undefined)

    const stats: RpcResponse = {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: {
        sessionFile: relative,
        sessionId: 's1',
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0
      }
    }
    assert.equal(replyFile(withAbsoluteSessionFile(stats, cwd)), join(cwd, relative))

    const failed: RpcResponse = {
      type: 'response',
      command: 'get_state',
      success: false,
      error: 'no'
    }
    assert.equal(withAbsoluteSessionFile(failed, cwd), failed)
  }
)

await check(
  'restorableOpenSessions: keeps missing-workspace history and skips missing session files',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'vengeance-open-sessions-'))
    try {
      const cwd = join(root, 'workspace')
      mkdirSync(cwd)
      const file = (name: string) => {
        const path = join(root, `${name}.jsonl`)
        writeFileSync(path, '{}\n')
        return path
      }
      const first = file('first')
      const third = file('third')
      const fourth = file('fourth')
      const missing = join(root, 'never-prompted.jsonl')
      const goneFolder = file('gone-folder')
      const stored = {
        openSessions: [
          { path: first, cwd },
          { path: missing, cwd },
          { path: goneFolder, cwd: join(root, 'deleted-workspace'), engine: 'prime' },
          { path: third, cwd },
          { bad: true },
          { path: fourth, cwd }
        ] as never,
        activeSession: missing
      }
      assert.deepEqual(restorableOpenSessions(stored), {
        openSessions: [
          { path: first, cwd, engine: 'pi' },
          { path: goneFolder, cwd: join(root, 'deleted-workspace'), engine: 'prime' },
          { path: third, cwd, engine: 'pi' },
          { path: fourth, cwd, engine: 'pi' }
        ],
        activeSession: goneFolder
      })
      assert.equal(
        restorableOpenSessions({ ...stored, activeSession: fourth }).activeSession,
        fourth
      )
      assert.equal(restorableOpenSessions({ ...stored, activeSession: null }).activeSession, first)
      assert.deepEqual(restorableOpenSessions({}), { openSessions: [], activeSession: null })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

await check('failed resumes retain their file identity before the first native state', () => {
  for (const engine of ['pi', 'prime'] as const) {
    const cwd = resolve(tmpdir(), 'history-workspace')
    const sessionPath = join(cwd, 'history.jsonl')
    const agent = createAgentState({
      agentId: `failed-${engine}`,
      engine,
      cwd,
      status: 'crashed',
      mock: false,
      busy: false,
      bridge: false,
      createdAt: 0,
      args: { engine, cwd, sessionPath }
    })
    assert.equal(agentSessionFile(agent), sessionPath)
    assert.equal(agentSessionFile({ ...agent, session: sessionState }), undefined)
    const forkPath = join(cwd, 'fork.jsonl')
    assert.equal(
      agentSessionFile({ ...agent, session: { ...sessionState, sessionFile: forkPath } }),
      forkPath
    )
  }
})

function notice(id: string, parentId: string | null, details: unknown): SessionEntry {
  return {
    type: 'custom_message',
    id,
    parentId,
    timestamp: new Date(0).toISOString(),
    customType: 'subagent-notify',
    content: 'Background task completed: **worker**\n\nworker:\nDone.',
    display: true,
    details
  }
}

function findNode(node: BranchNode, id: string): BranchNode | undefined {
  if (node.id === id) return node
  for (const child of node.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

await check(
  'buildBranchTree: subagent notices carry the run ids whose child sessions can be opened',
  () => {
    const entries = [
      notice('n1', null, {
        runs: [
          { agent: 'worker', status: 'completed', runId: 'run-a' },
          { agent: 'reviewer', status: 'completed', runId: 'run-b' }
        ]
      }),
      notice('n2', 'n1', { runId: 'run-c' }),
      notice('n3', 'n2', undefined)
    ]
    const tree = buildBranchTree(sessionTreeFromEntries(entries), 'n3')
    assert.deepEqual(findNode(tree.root, 'n1')?.subagentRunIds, ['run-a', 'run-b'])
    assert.deepEqual(findNode(tree.root, 'n2')?.subagentRunIds, ['run-c'])
    assert.equal(findNode(tree.root, 'n3')?.subagentRunIds, undefined)
  }
)
