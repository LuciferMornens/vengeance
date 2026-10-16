import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildEngineHandoffHistory,
  writePiHandoffHistory,
  type EngineHandoffArgs,
  type EngineHandoffHistory,
  type PiHandoffModule
} from '../../src/main/features/sessions/handoff'
import { importPiFile } from '../../src/main/engine/runtime'
import type { SessionEntry } from '../../src/shared/engine-types'
import { check } from './harness'

const fixtureTimestamp = 1_700_000_000_000
const imageData = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function fixtureEntries(): SessionEntry[] {
  const content = [
    {
      type: 'message',
      message: { role: 'user', content: 'Keep every turn', timestamp: fixtureTimestamp }
    },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'a.txt' } }
        ],
        api: 'openai-responses',
        provider: 'openai',
        model: 'fixture-model',
        stopReason: 'toolUse',
        usage,
        timestamp: fixtureTimestamp
      }
    },
    {
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'read-call',
        toolName: 'read',
        content: [{ type: 'text', text: 'full tool output' }],
        isError: false,
        timestamp: fixtureTimestamp
      }
    },
    {
      type: 'compaction',
      summary: 'An existing summary',
      firstKeptEntryId: 'entry-2',
      tokensBefore: 99
    },
    {
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'image', data: imageData, mimeType: 'image/gif' }],
        timestamp: fixtureTimestamp
      }
    }
  ]
  // Native entry envelopes are a protocol boundary; fixture payloads deliberately include every role.
  return content.map((entry, index) => ({
    ...entry,
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: new Date(fixtureTimestamp).toISOString()
  })) as SessionEntry[]
}

function fixtureArgs(): EngineHandoffArgs {
  return {
    sourceEngine: 'prime',
    targetEngine: 'pi',
    cwd: process.cwd(),
    entries: fixtureEntries(),
    leafId: 'entry-4',
    name: 'Carried conversation'
  }
}

await check('engine handoff keeps pre-compaction turns, tool pairs and image bytes', () => {
  const history = buildEngineHandoffHistory(fixtureArgs())
  assert.equal(history.entries.length, 5)
  assert.equal(history.entries[0]?.type, 'message')
  assert.equal(history.entries[3]?.fields.firstKeptEntryId, 'entry-2')
  assert.ok(JSON.stringify(history).includes('full tool output'))
  assert.ok(JSON.stringify(history).includes(imageData))
})

await check('engine handoff rejects missing parents and incomplete window-only snapshots', () => {
  const args = fixtureArgs()
  assert.throws(
    () => buildEngineHandoffHistory({ ...args, entries: args.entries.slice(1) }),
    /incomplete parent chain/
  )
  assert.throws(
    () =>
      buildEngineHandoffHistory({
        ...args,
        entries: [],
        leafId: null,
        messages: [{ role: 'user', content: 'Missing full history', timestamp: fixtureTimestamp }]
      }),
    /complete conversation history/
  )
})

await check(
  'engine handoff makes unknown roles and old system instructions explicit historical context',
  () => {
    const args = fixtureArgs()
    const entries = args.entries.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            type: 'message',
            message: { role: 'future', content: 'Future-role content', timestamp: fixtureTimestamp }
          }
        : entry
    ) as SessionEntry[]
    const history = buildEngineHandoffHistory({ ...args, entries })
    assert.equal(history.entries[0]?.type, 'custom_message')
    assert.match(String(history.entries[0]?.fields.content), /Future-role content/)
    assert.match(String(history.entries[0]?.fields.content), /Historical future message/)
  }
)

await check('Engine 2 handoff applies context edits while archiving original content', () => {
  const args = fixtureArgs()
  const edit: SessionEntry = {
    type: 'context_edit',
    id: 'edit',
    parentId: args.leafId,
    timestamp: new Date(fixtureTimestamp).toISOString(),
    targetId: 'entry-0',
    replacement: { content: 'Edited model context' }
  }
  const history = buildEngineHandoffHistory({
    ...args,
    targetEngine: 'prime',
    entries: [...args.entries, edit],
    leafId: edit.id
  })
  assert.ok(JSON.stringify(history).includes('Keep every turn'))
  const firstMessage = history.entries.find((entry) => entry.type === 'message')
  assert.equal(
    (firstMessage?.fields.message as { content: string }).content,
    'Edited model context'
  )
  assert.equal(history.entries.at(-1)?.type, 'custom')
  const assistantEdit = { ...edit, targetId: 'entry-1' }
  const assistantHistory = buildEngineHandoffHistory({
    ...args,
    targetEngine: 'prime',
    entries: [...args.entries, assistantEdit],
    leafId: edit.id
  })
  const assistant = assistantHistory.entries.find((entry) => entry.id === 'entry-1')
  assert.deepEqual((assistant?.fields.message as { content: unknown }).content, [
    { type: 'text', text: 'Edited model context' }
  ])
  const toolEdit = { ...edit, targetId: 'entry-2' }
  const toolHistory = buildEngineHandoffHistory({
    ...args,
    targetEngine: 'prime',
    entries: [...args.entries, toolEdit],
    leafId: edit.id
  })
  const toolResult = toolHistory.entries.find((entry) => entry.id === 'entry-2')
  assert.deepEqual((toolResult?.fields.message as { content: unknown }).content, [
    { type: 'text', text: 'Edited model context' }
  ])
})

await check('Engine 2 handoff applies replacements and omissions to custom messages', () => {
  const args = fixtureArgs()
  const custom: SessionEntry = {
    type: 'custom_message',
    id: 'custom',
    parentId: args.leafId,
    timestamp: new Date(fixtureTimestamp).toISOString(),
    customType: 'source-extension',
    content: 'Unedited extension context',
    display: true
  }
  for (const replacement of [{ content: 'Edited extension context' }, null]) {
    const edit: SessionEntry = {
      type: 'context_edit',
      id: 'edit-custom',
      parentId: custom.id,
      timestamp: custom.timestamp,
      targetId: custom.id,
      replacement
    }
    const history = buildEngineHandoffHistory({
      ...args,
      targetEngine: 'prime',
      entries: [...args.entries, custom, edit],
      leafId: edit.id
    })
    const transferred: EngineHandoffHistory['entries'][number] | undefined = history.entries.find(
      (entry) => entry.id === custom.id
    )
    assert.equal(transferred?.type, replacement ? 'custom_message' : 'custom')
    assert.equal(transferred?.fields.content, replacement?.content)
    assert.ok(JSON.stringify(history).includes('Unedited extension context'))
  }
})

await check(
  'native Engine writer creates a resumable session and cleans up failed transfers',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vengeance-handoff-check-'))
    try {
      const native = await importPiFile<PiHandoffModule>(
        join(
          process.cwd(),
          '.engine-staging',
          'bundled',
          'pi',
          'node_modules',
          '@earendil-works',
          'pi-coding-agent',
          'dist',
          'core',
          'session-manager.js'
        )
      )
      const history = buildEngineHandoffHistory(fixtureArgs())
      const path = writePiHandoffHistory(native, history, directory)
      const reopened = native.SessionManager.open(path).getEntries()
      const compaction = reopened.find((entry) => entry.type === 'compaction')
      assert.ok(compaction?.type === 'compaction')
      const kept = reopened.find((entry) => entry.id === compaction.firstKeptEntryId)
      assert.ok(kept?.type === 'message' && kept.message.role === 'toolResult')
      assert.ok((await readFile(path, 'utf8')).includes(imageData))
      assert.ok((await readFile(path, 'utf8')).includes('full tool output'))
      await rm(path)

      const customHistory = {
        ...history,
        entries: history.entries.filter((entry) => entry.type === 'custom_message')
      }
      customHistory.entries.push({
        id: 'standalone-custom',
        type: 'custom_message',
        fields: { customType: 'history', content: 'Standalone custom context', display: true }
      })
      const customPath = writePiHandoffHistory(native, customHistory, directory)
      assert.ok((await readFile(customPath, 'utf8')).includes('Standalone custom context'))
      await rm(customPath)

      const bashHistory = {
        ...history,
        entries: [
          {
            id: 'standalone-bash',
            type: 'message' as const,
            fields: {
              message: {
                role: 'bashExecution',
                command: 'echo historical',
                output: 'Standalone shell output',
                cancelled: false,
                truncated: false,
                exitCode: 0,
                timestamp: fixtureTimestamp
              }
            }
          }
        ]
      }
      const bashPath = writePiHandoffHistory(native, bashHistory, directory)
      assert.ok((await readFile(bashPath, 'utf8')).includes('Standalone shell output'))
      await rm(bashPath)

      const broken = buildEngineHandoffHistory(fixtureArgs())
      broken.entries[3]!.fields.firstKeptEntryId = 'missing'
      assert.throws(
        () => writePiHandoffHistory(native, broken, directory),
        /invalid firstKeptEntryId/
      )
      assert.deepEqual(await readdir(directory), [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
