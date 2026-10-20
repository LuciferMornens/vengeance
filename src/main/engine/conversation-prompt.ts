import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationPrompt, CreateAgentArgs } from '@shared/api/engine'
import type { LaunchOptions, PrimeLaunchOptions } from '@shared/api/launch'

/**
 * A conversation's own instructions, applied through each engine's native prompt sources. Both engines
 * stop discovering APPEND_SYSTEM.md once any explicit append source is given, so append mode passes what
 * the engine would have discovered (or the launch-time append sources) first, then the conversation.
 * The discovered file goes in as a copy of its text taken at the spawn: both engines read their explicit
 * sources again later (the Engine on every resource reload, Engine 2 whenever a worker is recreated) and
 * take a path that no longer exists as literal text, while Settings can remove APPEND_SYSTEM.md at any
 * time. Every restart composes the sources again, so edits to the file apply from there.
 */

/** The text engines receive: ending in a newline, so Engine 2 can never mistake it for a path. */
export function conversationPromptText(prompt: ConversationPrompt): string {
  return prompt.text.endsWith('\n') ? prompt.text : `${prompt.text}\n`
}

/** Where the Engine reads a conversation's instructions from at one spawn. */
export interface PiPromptSources {
  /** The conversation's text as a file: an existing path is read, and long text stays off the command line. */
  conversationFile: string
  /** A copy of the APPEND_SYSTEM.md the Engine would discover for this spawn, when one has text. */
  appendSystemFile?: string
}

/** Launch flags carrying the conversation's instructions; replace mode wins over a launch-time system prompt. */
export function withPiConversationPrompt(
  launch: LaunchOptions | undefined,
  prompt: ConversationPrompt,
  sources: PiPromptSources
): LaunchOptions {
  if (prompt.mode === 'replace') return { ...launch, systemPrompt: sources.conversationFile }
  const inherited = launch?.appendSystemPrompt?.length
    ? launch.appendSystemPrompt
    : sources.appendSystemFile
      ? [sources.appendSystemFile]
      : []
  return { ...launch, appendSystemPrompt: [...inherited, sources.conversationFile] }
}

/** A prompt file's text, or undefined when it cannot be read or holds only whitespace. */
async function promptFileText(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * The text of the APPEND_SYSTEM.md the Engine would discover (resource loader
 * `discoverAppendSystemPromptFile`): the project's file when the spawn trusts the project, else the agent
 * dir's.
 */
export async function piAppendSystemText(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean
): Promise<string | undefined> {
  const project = join(cwd, '.pi', 'APPEND_SYSTEM.md')
  const global = join(agentDir, 'APPEND_SYSTEM.md')
  const discovered =
    projectTrusted && existsSync(project) ? project : existsSync(global) ? global : undefined
  return discovered ? promptFileText(discovered) : undefined
}

/**
 * Engine 2's native configuration with the conversation's instructions. Both travel as literals ending in
 * a newline, which the resident's descriptor replays as is; a file path could go missing and turn into
 * literal path text.
 */
function withPrimeConversationPrompt(
  launch: PrimeLaunchOptions | undefined,
  prompt: ConversationPrompt | null | undefined,
  appendSystemText: string | undefined
): PrimeLaunchOptions | undefined {
  if (!prompt) return launch
  const text = conversationPromptText(prompt)
  if (prompt.mode === 'replace') return { ...launch, systemPrompt: text }
  const inherited = launch?.appendSystemPrompt?.length
    ? launch.appendSystemPrompt
    : appendSystemText
      ? [appendSystemText]
      : []
  return { ...launch, appendSystemPrompt: [...inherited, text] }
}

/** Arguments whose Engine 2 configuration is what the native resident runs with. */
export function primeConfiguredArgs(
  args: CreateAgentArgs,
  appendSystemText: string | undefined
): CreateAgentArgs {
  if (!args.conversationPrompt) return args
  return {
    ...args,
    launch: {
      ...args.launch,
      prime: withPrimeConversationPrompt(
        args.launch?.prime,
        args.conversationPrompt,
        appendSystemText
      )
    }
  }
}

/**
 * The text of Engine 2's APPEND_SYSTEM.md discovery (the project's `.prime/agent` file, else the agent
 * dir's) as a source literal, ending in a newline like the conversation's text.
 */
export async function primeAppendSystemText(
  cwd: string,
  agentDir: string
): Promise<string | undefined> {
  const discovered = [
    join(cwd, '.prime', 'agent', 'APPEND_SYSTEM.md'),
    join(agentDir, 'APPEND_SYSTEM.md')
  ].find((path) => existsSync(path))
  const text = discovered ? await promptFileText(discovered) : undefined
  return text === undefined || text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Mock engines' assembled prompt: replace mode swaps the foundation, and runtime sections (project context
 * and the like) always stay. Append mode adds the text where the engine does: Engine 2 at the end, the
 * Engine (`addendum`) in its `<addendum>` section, between the foundation and the runtime sections.
 */
export function mockAssembledPrompt(
  foundation: string,
  runtime: string,
  prompt: ConversationPrompt | null | undefined,
  placement: 'addendum' | 'end' = 'end'
): string {
  if (prompt?.mode === 'replace') return [prompt.text, runtime].join('\n\n')
  if (prompt?.mode !== 'append') return [foundation, runtime].join('\n\n')
  const sections =
    placement === 'addendum'
      ? [foundation, `<addendum>\n${prompt.text}\n</addendum>`, runtime]
      : [foundation, runtime, prompt.text]
  return sections.join('\n\n')
}
