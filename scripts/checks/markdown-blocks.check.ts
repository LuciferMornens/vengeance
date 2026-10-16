import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { MarkdownBlockSplitter, splitMarkdownBlocks } from '../../src/renderer/ui/markdown-blocks'
import { check } from './harness'

const PARAGRAPH_COUNT = 1000
const TAIL_UPDATES = 200

const DOCUMENTS = [
  'First paragraph.\n\nSecond paragraph.\n\n',
  '# Heading\n\n1. First item\n\n2. Second item\n\n   Continued item.\n\nAfter the list.',
  'Before.\n\n```typescript\nconst value = 1\n\nvalue++\n```\n\nAfter.',
  '> Quoted text.\n>\n> Still quoted.\n\n| A | B |\n| - | - |\n| 1 | 2 |',
  '~~~\nA fence with ``` inside.\n~~~~\n\n    An indented continuation.\n\nTail.',
  '\n\n- A list\n\n  continuation\n\n- second item\n\n## Heading\n\nBody.',
  '- A list\n\n1. A numbered continuation\n\n2. Another continuation.'
]

await check('markdown splits retain fenced code and continued lists as complete blocks', () => {
  assert.deepEqual(splitMarkdownBlocks(DOCUMENTS[1]!), [
    '# Heading',
    '1. First item\n\n2. Second item\n\n   Continued item.',
    'After the list.'
  ])
  assert.deepEqual(splitMarkdownBlocks(DOCUMENTS[2]!), [
    'Before.',
    '```typescript\nconst value = 1\n\nvalue++\n```',
    'After.'
  ])
})

await check('streamed markdown matches a complete split at every chunk boundary', () => {
  for (const document of DOCUMENTS) {
    const splitter = new MarkdownBlockSplitter()
    for (let length = 0; length < document.length; length++) {
      const text = document.slice(0, length)
      assert.deepEqual(splitter.split(text), splitMarkdownBlocks(text))
    }
    assert.deepEqual(splitter.split(document), splitMarkdownBlocks(document))
  }
})

await check('markdown replacement, shortening and emptying cannot reuse stale paragraphs', () => {
  const splitter = new MarkdownBlockSplitter()
  for (const text of [...DOCUMENTS, 'Shorter.', '', 'Replaced.\n\nNew tail.']) {
    assert.deepEqual(splitter.split(text), splitMarkdownBlocks(text))
  }
  const stable = splitter.split('Replaced.\n\nNew tail.')
  assert.strictEqual(splitter.split('Replaced.\n\nNew tail.'), stable)
})

await check('long streamed answers scan only the changing paragraph', () => {
  const prefix = Array.from(
    { length: PARAGRAPH_COUNT },
    (_, index) => `Paragraph ${index}: an answer with enough text to span several words.`
  ).join('\n\n')
  const updates = Array.from(
    { length: TAIL_UPDATES },
    (_, index) => `${prefix}\n\nTail ${'x'.repeat(index)}`
  )
  const fullStarted = performance.now()
  for (const text of updates) splitMarkdownBlocks(text)
  const fullElapsed = performance.now() - fullStarted
  const splitter = new MarkdownBlockSplitter()
  const streamedStarted = performance.now()
  let blocks: string[] = []
  for (const text of updates) blocks = splitter.split(text)
  const streamedElapsed = performance.now() - streamedStarted

  assert.deepEqual(blocks, splitMarkdownBlocks(updates[updates.length - 1]!))
  console.log(
    `      ${TAIL_UPDATES} updates after ${PARAGRAPH_COUNT} paragraphs: ` +
      `${fullElapsed.toFixed(1)} ms full, ${streamedElapsed.toFixed(1)} ms incremental`
  )
})
