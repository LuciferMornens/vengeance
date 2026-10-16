import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineId } from '@shared/api/engine'
import type { EngineHandoffArgs } from '../features/sessions/handoff'
import type { HandoffSnapshot } from './switch'

type MockHistory = Pick<HandoffSnapshot, 'messages' | 'entries' | 'leafId'>

interface MockHandoffFile extends MockHistory {
  type: 'vengeance-mock-handoff'
  engine: EngineId
}

export async function createEngineHandoff(
  args: EngineHandoffArgs,
  _overridePath: string | null
): Promise<{ path: string; cwd: string; engine: EngineId }> {
  const directory = join(tmpdir(), 'vengeance-mock', 'handoffs')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${randomUUID()}.json`)
  const content: MockHandoffFile = {
    type: 'vengeance-mock-handoff',
    engine: args.targetEngine,
    messages: [...(args.messages ?? [])],
    entries: [...(args.entries ?? [])],
    leafId: args.leafId ?? null
  }
  await writeFile(path, JSON.stringify(content), { flag: 'wx' })
  return { path, cwd: args.cwd, engine: args.targetEngine }
}

export async function readMockHandoff(
  path: string | undefined,
  engine: EngineId
): Promise<MockHistory | undefined> {
  if (!path?.endsWith('.json')) return undefined
  const content = JSON.parse(await readFile(path, 'utf8')) as Partial<MockHandoffFile>
  if (content.type !== 'vengeance-mock-handoff') return undefined
  if (
    content.engine !== engine ||
    !Array.isArray(content.messages) ||
    !Array.isArray(content.entries)
  ) {
    throw new Error('The mock handoff does not belong to this engine')
  }
  return { messages: content.messages, entries: content.entries, leafId: content.leafId ?? null }
}
