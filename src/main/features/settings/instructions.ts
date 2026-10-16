import { shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextOverview, InstructionFileRef, InstructionFileState } from '@shared/api/settings'
import { sdkHostCall } from '../../engine/sdk-host/client'
import { agentDir, projectRoot } from './agent-dir'
import { writeFileAtomic } from './json-file'

/** Context files the engine loads (AGENTS.md / CLAUDE.md) and the editable system prompt files. */

export async function contextOverview(override: string | null, cwd: string | null): Promise<ContextOverview> {
  const root = cwd ? projectRoot(cwd) : agentDir()
  const contextFiles = await sdkHostCall(override, 'context-files', { cwd: root, agentDir: agentDir() })
  const systemFiles: ContextOverview['systemFiles'] = []
  for (const kind of ['SYSTEM.md', 'APPEND_SYSTEM.md'] as const) {
    const projectFile = cwd ? join(root, '.pi', kind) : null
    if (projectFile && existsSync(projectFile)) systemFiles.push({ path: projectFile, kind, scope: 'project' })
    else if (existsSync(join(agentDir(), kind))) systemFiles.push({ path: join(agentDir(), kind), kind, scope: 'global' })
  }
  return { contextFiles, systemFiles, defaultSessionDir: join(agentDir(), 'sessions') }
}

/** Per directory the engine reads the first of these (pi docs/configuration.md "Context files"). */
const CONTEXT_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']

/** Paths are derived from kind + scope only; the renderer never names a file to write. */
function instructionPath(cwd: string | null, ref: InstructionFileRef): string {
  if (ref.scope === 'project' && !cwd) throw new Error('Open a project to edit its instructions.')
  const base = ref.scope === 'global' ? agentDir() : projectRoot(cwd!)
  if (ref.kind !== 'AGENTS.md') return ref.scope === 'global' ? join(base, ref.kind) : join(base, '.pi', ref.kind)
  const existing = CONTEXT_FILE_NAMES.map((name) => join(base, name)).find((path) => existsSync(path))
  return existing ?? join(base, 'AGENTS.md')
}

export function readInstructionFile(cwd: string | null, ref: InstructionFileRef): InstructionFileState {
  const path = instructionPath(cwd, ref)
  if (!existsSync(path)) return { ...ref, path, exists: false, text: '' }
  return { ...ref, path, exists: true, text: readFileSync(path, 'utf8').replace(/^\uFEFF/, '') }
}

/** Save (atomic) or, with `null`, move the file to the recycle bin. */
export async function writeInstructionFile(cwd: string | null, ref: InstructionFileRef, text: string | null): Promise<InstructionFileState> {
  const path = instructionPath(cwd, ref)
  if (text === null) {
    if (existsSync(path)) await shell.trashItem(path)
  } else {
    await writeFileAtomic(path, text.endsWith('\n') || text === '' ? text : `${text}\n`)
  }
  return readInstructionFile(cwd, ref)
}
