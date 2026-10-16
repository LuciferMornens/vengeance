const FENCE = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s/

interface MarkdownBlock {
  source: string
  start: number
}

/**
 * Split markdown into independently renderable top-level blocks (separated by blank lines outside code
 * fences). Streaming renders each block as its own memoized unit, so only the growing tail re-parses.
 * Indented continuations and consecutive list items stay with their block so lists keep numbering and
 * list items keep their nested paragraphs/code.
 */
function markdownBlocks(text: string): MarkdownBlock[] {
  const chunks: Array<{ lines: string[]; start: number }> = []
  let current: string[] = []
  let currentStart = 0
  let lineStart = 0
  let fence: string | null = null
  const flush = () => {
    if (current.length > 0) {
      chunks.push({ lines: current, start: currentStart })
      current = []
    }
  }
  for (const line of text.split('\n')) {
    if (current.length === 0) currentStart = lineStart
    lineStart += line.length + 1
    if (fence) {
      current.push(line)
      const close = FENCE.exec(line)
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        line.trim() === close[1]
      )
        fence = null
      continue
    }
    const open = FENCE.exec(line)
    if (open) {
      fence = open[1]!
      current.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()

  const blocks: MarkdownBlock[] = []
  let previousIsList = false
  for (const chunk of chunks) {
    const first = chunk.lines[0]!
    const isList = LIST_ITEM.test(first)
    const continuation = blocks.length > 0 && (/^\s/.test(first) || (previousIsList && isList))
    const source = chunk.lines.join('\n')
    if (continuation) {
      blocks[blocks.length - 1]!.source += `\n\n${source}`
    } else {
      blocks.push({ source, start: chunk.start })
      previousIsList = isList
    }
  }
  return blocks
}

export function splitMarkdownBlocks(text: string): string[] {
  return markdownBlocks(text).map((block) => block.source)
}

/** Keep the preceding block in case an unfinished list marker joins it on the next update. */
const UNSTABLE_BLOCK_COUNT = 2

/** Completed paragraphs need no further line scans while the trailing blocks keep streaming. */
export class MarkdownBlockSplitter {
  private text = ''
  private blocks: string[] = []
  private parsed: MarkdownBlock[] = []

  split(text: string): string[] {
    if (text === this.text) return this.blocks

    const appended = text.startsWith(this.text)
    const stableCount = appended ? Math.max(0, this.parsed.length - UNSTABLE_BLOCK_COUNT) : 0
    const start = appended ? (this.parsed[stableCount]?.start ?? 0) : 0
    const prefix = this.parsed.slice(0, stableCount)
    const tail = markdownBlocks(text.slice(start))
    this.text = text
    this.parsed = [
      ...prefix,
      ...tail.map((block) => ({ source: block.source, start: start + block.start }))
    ]
    this.blocks = this.parsed.map((block) => block.source)
    return this.blocks
  }
}
