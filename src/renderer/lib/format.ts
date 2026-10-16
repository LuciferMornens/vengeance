/** Display formatting helpers (numbers use tabular figures in the UI). */

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return usd < 1000 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - epochMs)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Last path segment for display (works with \ and /). */
export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`
}
