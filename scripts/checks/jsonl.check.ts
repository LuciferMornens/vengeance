import { strict as assert } from 'node:assert'
import { JsonlDecoder } from '../../src/main/engine/rpc-process'
import { check } from './harness'

function decodeAll(chunks: Buffer[]): string[] {
  const decoder = new JsonlDecoder()
  const lines = chunks.flatMap((chunk) => decoder.push(chunk))
  return [...lines, ...decoder.end()]
}

await check('JsonlDecoder: splits only on LF, strips CR, keeps U+2028/U+2029 inside records', () => {
  const records = [JSON.stringify({ text: 'a\u2028b\u2029c' }), JSON.stringify({ n: 2 })]
  const lines = decodeAll([Buffer.from(`${records[0]}\r\n${records[1]}\n`)])
  assert.deepEqual(lines, records)
})

await check('JsonlDecoder: records split across chunks, incl. a multi-byte char and a CR/LF boundary', () => {
  const record = JSON.stringify({ text: 'héllo — 🌋' })
  const bytes = Buffer.from(`${record}\r\n{"n":1}\n`)
  const emoji = bytes.indexOf(Buffer.from('🌋'))
  const crlf = bytes.indexOf(Buffer.from('\r\n'))
  const chunks = [bytes.subarray(0, emoji + 2), bytes.subarray(emoji + 2, crlf + 1), bytes.subarray(crlf + 1)]
  assert.deepEqual(decodeAll(chunks), [record, '{"n":1}'])
})

await check('JsonlDecoder: unterminated final record is returned by end()', () => {
  assert.deepEqual(decodeAll([Buffer.from('{"a":1}\n{"b":2}')]), ['{"a":1}', '{"b":2}'])
})

await check('JsonlDecoder: a 32 MB line in 64 KB chunks decodes in linear time (< 1.5 s)', () => {
  const payload = 'x'.repeat(32 * 1024 * 1024)
  const bytes = Buffer.from(`{"data":"${payload}"}\n`)
  const decoder = new JsonlDecoder()
  const started = performance.now()
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) lines.push(...decoder.push(bytes.subarray(offset, offset + 64 * 1024)))
  const elapsed = performance.now() - started
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.length, payload.length + 11)
  console.log(`    (${elapsed.toFixed(0)} ms)`)
  assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`)
})
