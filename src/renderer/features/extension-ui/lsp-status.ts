import { stripAnsi } from '../../lib/ansi'

/** pi-lens publishes its language-server state under this status key (`updateLspStatus`). */
export const LSP_STATUS_KEY = 'pi-lens-lsp'

export type LspTone = 'success' | 'idle' | 'warning'

export interface LspChip {
  label: string
  tone: LspTone
  tooltip: string
}

const SERVER_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  pyright: 'Python',
  basedpyright: 'Python',
  marksman: 'Markdown',
  'rust-analyzer': 'Rust',
  gopls: 'Go',
  eslint: 'ESLint'
}

function serverName(id: string): string {
  return SERVER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

function serverIds(list: string): string[] {
  return list
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

const IDLE: LspChip = {
  label: 'Code intelligence idle',
  tone: 'idle',
  tooltip: 'No language server is running in this session. One starts when the agent reads or edits a source file in this project, and stops after a few idle minutes.'
}

/**
 * pi-lens LSP status text (`LSP Active: <ids>`, `LSP Failed: <ids>`, `LSP Inactive`, compact `LSP ✓/✗`, parts
 * joined by ` · `) as chips in plain words, active first. Null when the text is not a pi-lens LSP status.
 */
export function formatLspStatus(text: string): LspChip[] | null {
  const chips: LspChip[] = []
  for (const part of stripAnsi(text).split('·').map((p) => p.trim())) {
    const active = /^LSP Active:\s*(.+)$/.exec(part)
    const failed = /^LSP Failed:\s*(.+)$/.exec(part)
    if (active) {
      const names = [...new Set(serverIds(active[1]!).map(serverName))]
      chips.push({ label: names.join(' · '), tone: 'success', tooltip: 'Language servers running in this session.' })
    } else if (failed) {
      const ids = serverIds(failed[1]!)
      const names = [...new Set(ids.map(serverName))]
      chips.push({
        label: `${names.join(', ')} ${names.length === 1 ? 'server' : 'servers'} unavailable`,
        tone: 'warning',
        tooltip: `${ids.join(', ')} could not start. Install it or ignore it; other languages are unaffected.`
      })
    } else if (part === 'LSP Inactive' || part === 'LSP ✗') chips.push(IDLE)
    else if (part === 'LSP ✓') chips.push({ label: 'Code intelligence', tone: 'success', tooltip: 'Language servers running in this session.' })
    else return null
  }
  return chips.length ? chips : null
}

/** Whether the chips report a running language server. */
export function isLspActive(chips: LspChip[] | null): boolean {
  return chips?.some((chip) => chip.tone === 'success') ?? false
}

/**
 * An idle-only status is noise until a language server has run in the session: sessions that never touch code
 * show no chip. After one ran, "Code intelligence idle" explains why it went quiet. Failures always show.
 */
export function hidesIdleLsp(chips: LspChip[] | null, activeEarlier: boolean): boolean {
  if (!chips || activeEarlier) return false
  return chips.every((chip) => chip.tone === 'idle')
}
