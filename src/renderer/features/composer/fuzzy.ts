/** Subsequence fuzzy match with bonuses for prefixes, word starts and consecutive runs. */
export interface FuzzyResult {
  score: number
  /** Matched character positions in `text` (for highlighting). */
  indices: number[]
}

const WORD_BREAK = /[\s/\\._:-]/

export function fuzzyMatch(text: string, query: string): FuzzyResult | null {
  if (!query) return { score: 0, indices: [] }
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const indices: number[] = []
  let score = 0
  let from = 0
  let previous = -2
  for (const ch of needle) {
    const at = hay.indexOf(ch, from)
    if (at < 0) return null
    indices.push(at)
    if (at === 0) score += 12
    else if (WORD_BREAK.test(text[at - 1]!)) score += 8
    if (at === previous + 1) score += 6
    score += 1 - Math.min(at - from, 10) * 0.08
    previous = at
    from = at + 1
  }
  if (hay.startsWith(needle)) score += 20
  // Prefer shorter candidates when everything else is equal.
  score -= text.length * 0.02
  return { score, indices }
}
