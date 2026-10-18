import { shell } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ContextOverview,
  InstructionFileRef,
  InstructionFileState,
  InstructionFileWriteRef,
  SystemPromptDefault
} from '@shared/api/settings'
import { sdkHostCall } from '../../engine/sdk-host/client'
import { agentDir, projectRoot } from './agent-dir'
import { withFileRemovalOwnership, writeFileAtomic } from './json-file'
import { trustPreflight } from '../launch/trust'

/** Context files the engine loads (AGENTS.md / CLAUDE.md) and the editable system prompt files. */

export async function contextOverview(
  override: string | null,
  cwd: string | null
): Promise<ContextOverview> {
  const root = cwd ? projectRoot(cwd) : agentDir()
  const contextFiles = await sdkHostCall(override, 'context-files', {
    cwd: root,
    agentDir: agentDir()
  })
  const systemFiles: ContextOverview['systemFiles'] = []
  const trusted = cwd ? (await trustPreflight(override, cwd)).engineDefault : false
  for (const kind of ['SYSTEM.md', 'APPEND_SYSTEM.md'] as const) {
    const projectFile = cwd && trusted ? join(root, '.pi', kind) : null
    if (projectFile && existsSync(projectFile))
      systemFiles.push({ path: projectFile, kind, scope: 'project' })
    else if (existsSync(join(agentDir(), kind)))
      systemFiles.push({ path: join(agentDir(), kind), kind, scope: 'global' })
  }
  return { contextFiles, systemFiles, defaultSessionDir: join(agentDir(), 'sessions') }
}

/** Per directory the engine reads the first of these (pi docs/configuration.md "Context files"). */
const CONTEXT_FILE_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD'
]

/** Paths are derived from kind + scope only; the renderer never names a file to write. */
function instructionPath(cwd: string | null, ref: InstructionFileRef): string {
  if (!['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].includes(ref.kind))
    throw new Error('Unknown instruction file.')
  if (!['global', 'project'].includes(ref.scope)) throw new Error('Unknown instruction scope.')
  if (ref.scope === 'project' && !cwd) throw new Error('Open a project to edit its instructions.')
  const base = ref.scope === 'global' ? agentDir() : projectRoot(cwd!)
  if (ref.kind !== 'AGENTS.md')
    return ref.scope === 'global' ? join(base, ref.kind) : join(base, '.pi', ref.kind)
  const existing = CONTEXT_FILE_NAMES.map((name) => join(base, name)).find((path) =>
    existsSync(path)
  )
  return existing ?? join(base, 'AGENTS.md')
}

export function readInstructionFile(
  cwd: string | null,
  ref: InstructionFileRef
): InstructionFileState {
  const path = instructionPath(cwd, ref)
  if (!existsSync(path)) return { ...ref, path, exists: false, text: '' }
  if (statSync(path).size > MAX_INSTRUCTION_BYTES)
    throw new Error('This instruction file is too large to edit.')
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  return { ...ref, path, exists: true, text }
}

const MAX_INSTRUCTION_BYTES = 1024 * 1024

export function defaultSystemPrompt(override: string | null): Promise<SystemPromptDefault> {
  return sdkHostCall(override, 'system-prompt-default', {})
}

/** Save (atomic) or, with `null`, move the file to the recycle bin. */
export async function writeInstructionFile(
  cwd: string | null,
  ref: InstructionFileWriteRef,
  text: string | null
): Promise<InstructionFileState> {
  const path = instructionPath(cwd, ref)
  const current = readInstructionFile(cwd, { kind: ref.kind, scope: ref.scope })
  if (
    ref.expected &&
    (ref.expected.exists !== current.exists || ref.expected.text !== current.text)
  )
    throw new Error('This file changed outside the editor. Reopen it to review the latest version.')
  if (ref.kind === 'SYSTEM.md' && text !== null && !text.trim())
    throw new Error('A replacement prompt cannot be empty. Restore the inherited prompt instead.')
  if (text === null) {
    if (existsSync(path)) {
      await withFileRemovalOwnership(path, () => shell.trashItem(path))
    }
  } else {
    const normalized = text.endsWith('\n') || text === '' ? text : `${text}\n`
    if (Buffer.byteLength(normalized) > MAX_INSTRUCTION_BYTES)
      throw new Error('This instruction file is too large.')
    await writeFileAtomic(path, normalized)
  }
  return readInstructionFile(cwd, { kind: ref.kind, scope: ref.scope })
}
