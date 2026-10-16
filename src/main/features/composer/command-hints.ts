import { open } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'

/** Frontmatter lives at the top of the file; a template's head is plenty to find it. */
const HEAD_BYTES = 8 * 1024

async function readHead(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

/** `argument-hint` from YAML frontmatter (prompt-templates.md), unquoted. */
export function parseArgumentHint(source: string): string | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!match) return undefined
  const line = /^argument-hint:[ \t]*(.*)$/m.exec(match[1]!)
  if (!line) return undefined
  const raw = line[1]!.trim()
  const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw
  return unquoted.trim() || undefined
}

/**
 * Argument hints for markdown-backed commands (prompt templates, skills), keyed by the given path.
 * Relative paths resolve against the agent's workspace. Unreadable files and files without a hint are omitted.
 */
export async function readCommandHints(cwd: string, paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths)].filter((path) => extname(path).toLowerCase() === '.md')
  const entries = await Promise.all(
    unique.map(async (path): Promise<[string, string] | null> => {
      try {
        const hint = parseArgumentHint(await readHead(isAbsolute(path) ? path : resolve(cwd, path)))
        return hint ? [path, hint] : null
      } catch {
        return null
      }
    })
  )
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry !== null))
}
