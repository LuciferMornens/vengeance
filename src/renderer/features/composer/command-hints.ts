import { useEffect, useMemo, useState } from 'react'
import type { RpcSlashCommand } from '@shared/engine-types'
import { invoke } from '../../lib/ipc'

/** Hints by `sourceInfo.path`, cached per workspace + command set (commands change on reload only). */
const cache = new Map<string, Record<string, string>>()

/**
 * `argument-hint` frontmatter of prompt templates and skills (prompt-templates.md), read in main because
 * `get_commands` does not carry it. Returns hints by command name; empty until loaded.
 */
export function useCommandHints(cwd: string, commands: RpcSlashCommand[]): Map<string, string> {
  const paths = useMemo(() => commands.filter((c) => c.source !== 'extension').map((c) => c.sourceInfo.path), [commands])
  const key = `${cwd}\u0000${paths.join('\u0000')}`
  const [byPath, setByPath] = useState<Record<string, string>>(() => cache.get(key) ?? {})

  useEffect(() => {
    const cached = cache.get(key)
    if (cached) return setByPath(cached)
    if (!cwd || paths.length === 0) return setByPath({})
    let alive = true
    invoke('composer:command-hints', cwd, paths)
      .then((hints) => {
        cache.set(key, hints)
        if (alive) setByPath(hints)
      })
      .catch(() => alive && setByPath({}))
    return () => {
      alive = false
    }
  }, [key, cwd, paths])

  return useMemo(() => {
    const hints = new Map<string, string>()
    for (const command of commands) {
      const hint = byPath[command.sourceInfo.path]
      if (hint) hints.set(command.name, hint)
    }
    return hints
  }, [commands, byPath])
}
