const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const SGR_OR_OTHER = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** Remove ANSI escape sequences (SGR, cursor, OSC). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export function hasAnsi(text: string): boolean {
  ANSI_PATTERN.lastIndex = 0
  return ANSI_PATTERN.test(text)
}

/** Text run with resolved SGR styling (colors are CSS values). */
export interface AnsiSegment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

/** 16-color palette tuned for Obsidian & Ember (normal 0–7, bright 8–15). */
export const ANSI_PALETTE = [
  '#3a3a44', '#ff5c6c', '#3ddc97', '#f5b84b', '#6ca8ff', '#c084fc', '#5eead4', '#d4d4dc',
  '#6b6b78', '#ff8a95', '#7ef0bd', '#ffd38a', '#9cc4ff', '#d8b4fe', '#99f6e4', '#ededf2'
]

function color256(n: number): string {
  if (n < 16) return ANSI_PALETTE[n]!
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v},${v},${v})`
  }
  const i = n - 16
  const steps = [0, 95, 135, 175, 215, 255]
  return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`
}

function applySgr(style: Omit<AnsiSegment, 'text'>, params: number[]): Omit<AnsiSegment, 'text'> {
  const next = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) {
      for (const key of Object.keys(next) as (keyof typeof next)[]) delete next[key]
    } else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 22) {
      next.bold = false
      next.dim = false
    } else if (p === 23) next.italic = false
    else if (p === 24) next.underline = false
    else if (p >= 30 && p <= 37) next.fg = ANSI_PALETTE[p - 30]
    else if (p >= 90 && p <= 97) next.fg = ANSI_PALETTE[p - 90 + 8]
    else if (p === 39) delete next.fg
    else if (p >= 40 && p <= 47) next.bg = ANSI_PALETTE[p - 40]
    else if (p >= 100 && p <= 107) next.bg = ANSI_PALETTE[p - 100 + 8]
    else if (p === 49) delete next.bg
    else if ((p === 38 || p === 48) && params[i + 1] === 5) {
      const c = color256(params[i + 2] ?? 0)
      if (p === 38) next.fg = c
      else next.bg = c
      i += 2
    } else if ((p === 38 || p === 48) && params[i + 1] === 2) {
      const c = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`
      if (p === 38) next.fg = c
      else next.bg = c
      i += 4
    }
  }
  return next
}

/** Split ANSI text into styled segments (SGR only; other escapes are dropped). */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  let style: Omit<AnsiSegment, 'text'> = {}
  let last = 0
  SGR_OR_OTHER.lastIndex = 0
  for (let m = SGR_OR_OTHER.exec(text); m; m = SGR_OR_OTHER.exec(text)) {
    if (m.index > last) segments.push({ ...style, text: text.slice(last, m.index) })
    if (m[1] !== undefined) {
      const params = m[1] === '' ? [0] : m[1].split(';').map((n) => Number(n) || 0)
      style = applySgr(style, params)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ ...style, text: text.slice(last) })
  return segments
}
