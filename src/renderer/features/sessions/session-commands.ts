import { normalizeEngineId } from '@shared/api/engine'
import { invoke } from '../../lib/ipc'
import { useAgents } from '../../store/agents'
import { useApp } from '../../store/app'
import { toast } from '../../ui'
import { newSession } from '../shell/workspace'
import { openSessionFile, pickImport } from './actions'
import { useSessions } from './store'

function commandArgument(value: string): string {
  const argument = value.trim()
  const quote = argument[0]
  return argument.length > 1 && (quote === '"' || quote === "'") && argument.endsWith(quote)
    ? argument.slice(1, -1)
    : argument
}

function primeNewSessionArguments(text: string): { name?: string; prompt: string } {
  let prompt = text.trim()
  let name: string | undefined
  if (/^--name(?:\s|$)/.test(prompt)) {
    const remainder = prompt.slice('--name'.length).trimStart()
    const argument = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+))(?=\s|$)/.exec(remainder)
    if (!argument) throw new Error('Use /new --name "Session name" -- optional prompt.')
    name = argument[1]?.replace(/\\(["\\])/g, '$1') ?? argument[2] ?? argument[3]
    if (!name?.trim() || argument[3] === '--') {
      throw new Error('Enter a session name after --name.')
    }
    prompt = remainder.slice(argument[0].length).trimStart()
  }
  prompt = prompt.replace(/^--(?:\s+|$)/, '')
  return { name, prompt }
}

export async function newSessionCommand(agentId: string, text: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  try {
    const engine = normalizeEngineId(agent.info.engine)
    const { name, prompt } =
      engine === 'prime'
        ? primeNewSessionArguments(text)
        : { name: commandArgument(text) || undefined, prompt: '' }
    const created = await newSession({ cwd: agent.info.cwd, engine, name })
    if (created && prompt) await useAgents.getState().prompt(created, prompt)
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not start the session',
      description: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function resumeSessionCommand(agentId: string, text: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  const reference = commandArgument(text)
  if (!reference) {
    useApp.getState().toggleSidebar(true)
    useSessions.getState().focusSearch()
    return
  }
  try {
    const session = await invoke('sessions:resolve', {
      reference,
      cwd: agent.info.cwd,
      engine: normalizeEngineId(agent.info.engine)
    })
    await openSessionFile(session.path, { cwd: session.cwd, engine: session.engine })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not resume the session',
      description: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function importSessionCommand(agentId: string, text: string): Promise<void> {
  const agent = useAgents.getState().agents[agentId]
  if (!agent) return
  const engine = normalizeEngineId(agent.info.engine)
  const sourcePath = commandArgument(text)
  if (!sourcePath) return pickImport(engine)
  try {
    const candidate = await invoke('sessions:inspect-import', {
      sourcePath,
      cwd: agent.info.cwd,
      engine
    })
    useSessions.getState().openDialog({ kind: 'import', candidate })
  } catch (error) {
    toast({
      level: 'error',
      title: 'Could not read that session file',
      description: error instanceof Error ? error.message : String(error)
    })
  }
}
