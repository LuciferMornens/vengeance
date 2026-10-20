import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONVERSATION_PROMPT_MAX_CHARS,
  type ConversationPrompt,
  type CreateAgentArgs,
  type EngineId
} from '@shared/api/engine'
import {
  conversationPromptText,
  piAppendSystemText,
  type PiPromptSources
} from '../../engine/conversation-prompt'
import { comparablePath } from '../../paths'
import { replaceFile } from '../settings/json-file'

/**
 * Each conversation's own instructions, kept by main in `<userData>/conversation-prompts.json` and keyed by
 * engine and session file: neither engine restores launch-time prompt flags when a session is reopened.
 * The Engine reads the text from content-addressed files in `<userData>/conversation-prompts/`; it takes a
 * missing path as literal text, so a file the store still names is never removed.
 */

const STORE_VERSION = 1
const FILE_EXTENSION = '.md'

interface StoreFile {
  version: number
  prompts: Record<string, ConversationPrompt>
}

/** The prompt a renderer sent, checked at the IPC boundary; `null` clears and `undefined` leaves it unset. */
export function parseConversationPrompt(value: unknown): ConversationPrompt | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'object') throw new Error('Conversation instructions are invalid')
  const { mode, text, updatedAt } = value as Partial<Record<keyof ConversationPrompt, unknown>>
  if (mode !== 'append' && mode !== 'replace') {
    throw new Error('Choose whether the instructions add to or replace the engine prompt')
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Conversation instructions cannot be empty. Remove them instead.')
  }
  if (text.length > CONVERSATION_PROMPT_MAX_CHARS) {
    const limit = CONVERSATION_PROMPT_MAX_CHARS.toLocaleString('en-US')
    throw new Error(`Conversation instructions are limited to ${limit} characters`)
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new Error('Conversation instructions need a valid update time')
  }
  return { mode, text, updatedAt }
}

function storedPrompt(value: unknown): ConversationPrompt | undefined {
  try {
    return parseConversationPrompt(value) ?? undefined
  } catch {
    return undefined
  }
}

/** The saved entries of a parsed store file; throws when the file does not have the store's shape. */
function savedPrompts(parsed: unknown): Record<string, unknown> {
  const prompts =
    parsed && typeof parsed === 'object' ? (parsed as Partial<StoreFile>).prompts : undefined
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) {
    throw new Error('The file does not list conversation instructions')
  }
  return prompts
}

function textFileName(text: string): string {
  return `${createHash('sha256').update(text).digest('hex')}${FILE_EXTENSION}`
}

function promptFileName(prompt: ConversationPrompt): string {
  return textFileName(conversationPromptText(prompt))
}

export function conversationPromptKey(engine: EngineId, sessionFile: string): string {
  return `${engine}:${comparablePath(sessionFile)}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class ConversationPromptStore {
  private prompts: Map<string, ConversationPrompt> | undefined
  /** The saved file could not be parsed: it is moved aside before the first write replaces it. */
  private damaged = false
  private writes: Promise<void> = Promise.resolve()
  /** Startup cleanup; prompt files are written only after it finishes. */
  private cleanup: Promise<void> | undefined
  /** Prompt files written or handed to an engine in this run; startup cleanup never removes them. */
  private readonly pinned = new Set<string>()

  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'conversation-prompts.json')
  }

  private get folder(): string {
    return join(this.root, 'conversation-prompts')
  }

  /**
   * The saved instructions, read once. A file that cannot be read now (a scanner holds it, permissions)
   * throws and is read again on the next call, so nothing is written or cleaned up over it. One that cannot
   * be parsed counts as empty, and is kept aside when the first change is saved.
   */
  private entries(): Map<string, ConversationPrompt> {
    if (this.prompts) return this.prompts
    let text: string | undefined
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Conversation instructions could not be read: ${(error as Error).message}`)
      }
    }
    const prompts = new Map<string, ConversationPrompt>()
    if (text !== undefined) {
      try {
        for (const [key, value] of Object.entries(savedPrompts(JSON.parse(text)))) {
          const prompt = storedPrompt(value)
          if (prompt) prompts.set(key, prompt)
        }
      } catch (error) {
        console.error(
          '[vengeance] conversation instructions are damaged and will be kept aside:',
          error
        )
        this.damaged = true
      }
    }
    this.prompts = prompts
    return prompts
  }

  /** Throws while the saved instructions cannot be read, so a change can be refused before it applies. */
  assertReadable(): void {
    this.entries()
  }

  /** The session file's saved instructions; none while the store cannot be read (logged, read again later). */
  get(engine: EngineId, sessionFile: string): ConversationPrompt | undefined {
    let entries: Map<string, ConversationPrompt>
    try {
      entries = this.entries()
    } catch (error) {
      console.error('[vengeance]', error)
      return undefined
    }
    const prompt = entries.get(conversationPromptKey(engine, sessionFile))
    return prompt ? { ...prompt } : undefined
  }

  /** Save the session file's instructions, or forget them with `null`. */
  async set(
    engine: EngineId,
    sessionFile: string,
    prompt: ConversationPrompt | null
  ): Promise<void> {
    const key = conversationPromptKey(engine, sessionFile)
    const entries = this.entries()
    const current = entries.get(key)
    if (prompt === null ? !current : samePrompt(current, prompt)) return
    if (prompt) entries.set(key, { ...prompt })
    else entries.delete(key)
    await this.persist()
  }

  /** Give a session file that was derived from another (fork, branch, clone) the same instructions. */
  async copy(
    from: { engine: EngineId; sessionFile: string },
    to: { engine: EngineId; sessionFile: string }
  ): Promise<void> {
    const prompt = this.entries().get(conversationPromptKey(from.engine, from.sessionFile))
    if (prompt) await this.set(to.engine, to.sessionFile, prompt)
  }

  /** Forget a deleted session file's instructions under every engine. */
  async forget(sessionFile: string): Promise<void> {
    const entries = this.entries()
    const path = comparablePath(sessionFile)
    const keys = [...entries.keys()].filter((key) => key.slice(key.indexOf(':') + 1) === path)
    if (!keys.length) return
    for (const key of keys) entries.delete(key)
    await this.persist()
  }

  /** The content-addressed file holding the prompt's text, written when missing. */
  promptFile(prompt: ConversationPrompt): Promise<string> {
    return this.textFile(conversationPromptText(prompt))
  }

  /**
   * A content-addressed file holding `text`, written when missing. It stays for this run's spawns; a later
   * run's startup cleanup removes it unless a saved conversation's instructions have the same text.
   */
  async textFile(text: string): Promise<string> {
    const name = textFileName(text)
    this.pinned.add(name)
    await this.cleanup?.catch(() => undefined)
    const path = join(this.folder, name)
    if (!(await exists(path))) await replaceFile(path, text)
    return path
  }

  /** Remove prompt files no saved conversation names; run once at startup. */
  collectGarbage(): Promise<void> {
    this.cleanup ??= this.removeUnreferenced()
    return this.cleanup
  }

  private async removeUnreferenced(): Promise<void> {
    const entries = this.entries()
    // A damaged store may still name files that someone recovers it with.
    if (this.damaged) return
    const referenced = new Set([...entries.values()].map(promptFileName))
    let names: string[]
    try {
      names = await readdir(this.folder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await Promise.all(
      names
        .filter(
          (name) => name.endsWith(FILE_EXTENSION) && !referenced.has(name) && !this.pinned.has(name)
        )
        .map((name) => rm(join(this.folder, name), { force: true }))
    )
  }

  private persist(): Promise<void> {
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        if (this.damaged) {
          await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
          this.damaged = false
        }
        const data: StoreFile = {
          version: STORE_VERSION,
          prompts: Object.fromEntries(this.entries())
        }
        await replaceFile(this.file, `${JSON.stringify(data, null, 2)}\n`)
      })
    this.writes = write
    return write
  }
}

function samePrompt(current: ConversationPrompt | undefined, next: ConversationPrompt): boolean {
  return (
    !!current &&
    current.mode === next.mode &&
    current.text === next.text &&
    current.updatedAt === next.updatedAt
  )
}

/**
 * The Engine's prompt sources for a spawn of `args`, or undefined when the conversation has no
 * instructions. `projectTrusted` answers the Engine's trust default for a spawn without a pinned decision.
 */
export async function piConversationPromptSources(
  store: ConversationPromptStore,
  args: CreateAgentArgs,
  agentDir: string,
  projectTrusted: (cwd: string) => Promise<boolean>
): Promise<PiPromptSources | undefined> {
  const prompt = args.conversationPrompt
  if (!prompt) return undefined
  const conversationFile = await store.promptFile(prompt)
  if (prompt.mode === 'replace' || args.launch?.appendSystemPrompt?.length) {
    return { conversationFile }
  }
  const trusted = args.approve ?? (await projectTrusted(args.cwd))
  const appendSystem = await piAppendSystemText(args.cwd, agentDir, trusted)
  return appendSystem === undefined
    ? { conversationFile }
    : { conversationFile, appendSystemFile: await store.textFile(appendSystem) }
}
