import { stat } from 'node:fs/promises'
import {
  normalizeEngineId,
  type AgentInfo,
  type ConversationPrompt,
  type CreateAgentArgs,
  type EngineId
} from '@shared/api/engine'
import type { RpcCommand } from '@shared/engine-types'
import {
  parseConversationPrompt,
  type ConversationPromptStore
} from '../features/sessions/conversation-prompts'
import { samePath } from '../paths'
import { resumedSessionFile, type InstructionsFor } from './manager'

/**
 * Which conversation's instructions an engine process runs with (SPEC §3.6). Instructions are launch
 * flags of the process started with them, while the process can move to another session file: through
 * a session command the app routes, or one it never sees (an extension command, a native session
 * replacement). These rules keep one conversation's instructions out of another across restarts,
 * engine switches and forks.
 */

/** The saved instructions of session files. */
export type SavedPrompts = Pick<ConversationPromptStore, 'get'>

/** Instructions to save for a session file; `null` forgets them. */
export interface PromptSave {
  engine: EngineId
  sessionFile: string
  prompt: ConversationPrompt | null
}

type AgentSession = Pick<AgentInfo, 'args' | 'sessionFile'>

/**
 * An agent's saved conversation file, when it has one: the one its engine reported, else the one its spawn
 * resumed (a startup state read that failed under load leaves `sessionFile` unset).
 */
export function savedSessionFile(agent: AgentSession): string | undefined {
  return agent.args.noSession ? undefined : (agent.sessionFile ?? resumedSessionFile(agent.args))
}

/** The conversation an agent runs: its session file, else null for a temporary chat or one not saved yet. */
export function conversationOf(agent: AgentSession, fallback?: string): string | null {
  return agent.args.noSession ? null : (agent.sessionFile ?? fallback ?? null)
}

/**
 * The conversation's instructions for a spawn: the ones the args carry, else the saved ones of the session
 * file it resumes or forks.
 */
export function withConversationPrompt(
  args: CreateAgentArgs,
  engine: EngineId,
  prompts: SavedPrompts
): CreateAgentArgs {
  const given = parseConversationPrompt(args.conversationPrompt)
  if (given !== undefined) return { ...args, conversationPrompt: given }
  const source = args.forkFrom ?? args.sessionPath
  const saved = source ? prompts.get(engine, source) : undefined
  return saved ? { ...args, conversationPrompt: saved } : args
}

/**
 * The instructions a spawn carried into a session file other than the one it resumed (a fork, Switch
 * engine), to save for that file.
 */
export function carriedPrompt(
  agent: AgentSession & Pick<AgentInfo, 'engine'>,
  prompt: ConversationPrompt | null | undefined,
  resumed: string | undefined
): PromptSave | undefined {
  const sessionFile = savedSessionFile(agent)
  if (!prompt || !sessionFile || (resumed && samePath(resumed, sessionFile))) return undefined
  return { engine: agent.engine, sessionFile, prompt }
}

/**
 * The instructions a restart applied, to save for the successor's session file: a change, or a removal
 * (`null`). A spawn that crashed before they took effect keeps them in its args, so the next restart
 * applies, and then saves, them.
 */
export function appliedPrompt(successor: AgentSession): PromptSave | undefined {
  const sessionFile = savedSessionFile(successor)
  const prompt = successor.args.conversationPrompt
  if (!sessionFile || prompt === undefined) return undefined
  return { engine: normalizeEngineId(successor.args.engine), sessionFile, prompt }
}

/**
 * How a session command replaces the conversation of the process that runs it: in place with another
 * conversation (`switch`, to `target` when it names one), or with a file derived from its own
 * (`derive`).
 */
export type SessionReplacement = { kind: 'switch'; target?: string } | { kind: 'derive' } | null

/** The replacement an Engine RPC command makes. */
export function piSessionReplacement(command: RpcCommand): SessionReplacement {
  switch (command.type) {
    case 'switch_session':
      return { kind: 'switch', target: command.sessionPath }
    case 'new_session':
      return { kind: 'switch' }
    case 'fork':
    case 'clone':
      return { kind: 'derive' }
    default:
      return null
  }
}

/** The replacement an Engine 2 native command makes. */
export function primeSessionReplacement(
  type: string,
  payload: Record<string, unknown> | undefined
): SessionReplacement {
  switch (type) {
    case 'switch_session':
      return {
        kind: 'switch',
        target: typeof payload?.sessionPath === 'string' ? payload.sessionPath : undefined
      }
    case 'new_session':
    case 'import_jsonl':
      return { kind: 'switch' }
    case 'fork':
      return { kind: 'derive' }
    default:
      return null
  }
}

/**
 * Refuses an in-place switch from or to a conversation with instructions: the process keeps the prompt
 * flags it started with, so it would apply one conversation's instructions to the other.
 */
export function assertInPlaceSwitch(
  agent: Pick<AgentInfo, 'args' | 'engine'>,
  prompts: SavedPrompts,
  target: string | undefined
): void {
  if (agent.args.conversationPrompt || (target && prompts.get(agent.engine, target))) {
    throw new Error(
      'Conversations with their own instructions run in their own engine. Open this session separately.'
    )
  }
}

/**
 * Forgets the instructions a closed Engine chat saved for a file it never wrote: the Engine writes a new
 * session's file only once it has a conversation, so a chat closed before its first message leaves an
 * entry no list or trash ever reaches. Its process stopped, so the file stays missing unless another
 * open agent runs it. A file that cannot be checked is kept.
 */
export async function unwrittenPrompt(
  closed: AgentSession & Pick<AgentInfo, 'engine'>,
  open: readonly AgentSession[],
  prompts: SavedPrompts
): Promise<PromptSave | undefined> {
  const sessionFile = closed.engine === 'pi' ? savedSessionFile(closed) : undefined
  if (!sessionFile || !prompts.get(closed.engine, sessionFile)) return undefined
  const running = open.some((agent) => {
    const other = savedSessionFile(agent)
    return other !== undefined && samePath(other, sessionFile)
  })
  if (running) return undefined
  try {
    await stat(sessionFile)
    return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  return { engine: closed.engine, sessionFile, prompt: null }
}

/** The conversation each agent's in-memory instructions were set for (see `conversationOf`). */
export class ConversationPromptOwners {
  private readonly owners = new Map<string, string | null>()

  constructor(private readonly prompts: SavedPrompts) {}

  /** A spawn started (created, restarted, switched engine); `resumed` stands in for an unread file. */
  started(agent: AgentSession & Pick<AgentInfo, 'agentId'>, resumed?: string): void {
    this.owners.set(agent.agentId, conversationOf(agent, resumed))
  }

  /**
   * A session command ran on the agent's process, or failed after its engine may have moved: once the
   * file it runs now is known, the instructions in its args belong to that file.
   */
  replaced(after: AgentSession & Pick<AgentInfo, 'agentId'>): void {
    const file = conversationOf(after)
    if (file !== null) this.owners.set(after.agentId, file)
  }

  closed(agentId: string): void {
    this.owners.delete(agentId)
  }

  /** The instructions for the conversation an agent's process runs now, in `sessionFile`. */
  instructionsFor(agent: Pick<AgentInfo, 'agentId' | 'args' | 'engine'>): InstructionsFor {
    return (sessionFile) => {
      const own = agent.args.conversationPrompt
      if (!sessionFile) return own
      const owner = this.owners.get(agent.agentId)
      const saved = () => this.prompts.get(agent.engine, sessionFile)
      // A change or removal in the args (one a crashed spawn never applied) wins over the saved entry.
      if (owner && samePath(owner, sessionFile)) return own !== undefined ? own : saved()
      if (owner !== null) return saved()
      // A saved chat whose file was not known yet, or an Engine 2 temporary chat promoted to a saved
      // one, is the same conversation unless that file has its own. An Engine temporary chat keeps new
      // and forked sessions in memory, so a file it runs is always another conversation.
      if (agent.engine === 'pi' && agent.args.noSession) return saved()
      return saved() ?? own
    }
  }
}
