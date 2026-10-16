import { diffWordsWithSpace, parsePatch, structuredPatch, type StructuredPatchHunk } from 'diff'

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'gap'

export interface DiffRow {
  kind: DiffRowKind
  oldNo?: number
  newNo?: number
  text: string
  /** Changed character ranges [start, end) for word-level emphasis. */
  words?: Array<[number, number]>
}

export interface DiffModel {
  rows: DiffRow[]
  added: number
  removed: number
}

const NO_NEWLINE = '\\ No newline at end of file'

function rowsFromHunks(hunks: StructuredPatchHunk[], lineOffset: number): DiffRow[] {
  const rows: DiffRow[] = []
  hunks.forEach((hunk, index) => {
    if (index > 0 || hunk.oldStart > 1 + lineOffset) rows.push({ kind: 'gap', text: '' })
    let oldNo = hunk.oldStart + lineOffset
    let newNo = hunk.newStart + lineOffset
    for (const line of hunk.lines) {
      if (line === NO_NEWLINE) continue
      const sign = line[0]
      const text = line.slice(1)
      if (sign === '+') rows.push({ kind: 'add', newNo: newNo++, text })
      else if (sign === '-') rows.push({ kind: 'del', oldNo: oldNo++, text })
      else rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text })
    }
  })
  return rows
}

/** Pair runs of deleted/added lines and mark the changed words (skipped for rewrites). */
function markWords(rows: DiffRow[]): void {
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.kind !== 'del') {
      i++
      continue
    }
    const delStart = i
    while (i < rows.length && rows[i]!.kind === 'del') i++
    const addStart = i
    while (i < rows.length && rows[i]!.kind === 'add') i++
    const pairs = Math.min(addStart - delStart, i - addStart)
    for (let k = 0; k < pairs; k++) {
      const del = rows[delStart + k]!
      const add = rows[addStart + k]!
      if (del.text.length + add.text.length > 2000) continue
      const changes = diffWordsWithSpace(del.text, add.text)
      let common = 0
      for (const c of changes) if (!c.added && !c.removed) common += c.value.trim().length
      const longest = Math.max(del.text.trim().length, add.text.trim().length)
      if (longest === 0 || common / longest < 0.4) continue
      const delWords: Array<[number, number]> = []
      const addWords: Array<[number, number]> = []
      let o = 0
      let n = 0
      for (const c of changes) {
        if (c.removed) {
          if (c.value.trim()) delWords.push([o, o + c.value.length])
          o += c.value.length
        } else if (c.added) {
          if (c.value.trim()) addWords.push([n, n + c.value.length])
          n += c.value.length
        } else {
          o += c.value.length
          n += c.value.length
        }
      }
      del.words = delWords
      add.words = addWords
    }
  }
}

function finish(rows: DiffRow[]): DiffModel {
  markWords(rows)
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { rows, added, removed }
}

/** Diff rows from a unified patch (pi's `details.patch`). */
export function diffFromPatch(patch: string): DiffModel | null {
  try {
    const files = parsePatch(patch)
    const hunks = files.flatMap((f) => f.hunks)
    if (hunks.length === 0) return null
    return finish(rowsFromHunks(hunks, 0))
  } catch {
    return null
  }
}

/**
 * Diff rows computed from edit arguments (no file context: line numbers are relative to each edit).
 * Used while arguments stream and for results without a patch.
 */
export function diffFromEdits(edits: Array<{ oldText: string; newText: string }>): DiffModel {
  const rows: DiffRow[] = []
  edits.forEach((edit, index) => {
    if (index > 0) rows.push({ kind: 'gap', text: '' })
    const patch = structuredPatch('a', 'b', edit.oldText, edit.newText, undefined, undefined, { context: 3 })
    if (patch.hunks.length === 0) {
      for (const [i, line] of edit.newText.split('\n').entries()) rows.push({ kind: 'ctx', oldNo: i + 1, newNo: i + 1, text: line })
      return
    }
    const hunkRows = rowsFromHunks(patch.hunks, 0)
    rows.push(...(hunkRows[0]?.kind === 'gap' ? hunkRows.slice(1) : hunkRows))
  })
  return finish(rows)
}

/** Diff of a full new file (write): every line added. */
export function diffFromNewFile(content: string): DiffModel {
  const lines = content.replace(/\n$/, '').split('\n')
  return { rows: lines.map((text, i) => ({ kind: 'add', newNo: i + 1, text })), added: lines.length, removed: 0 }
}
