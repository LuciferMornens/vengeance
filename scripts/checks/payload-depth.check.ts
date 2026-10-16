import { strict as assert } from 'node:assert'
import { limitPayloadDepth, MAX_BRIDGE_DEPTH, TOO_DEEP_PLACEHOLDER } from '../../src/main/ipc/payload-depth'
import { check } from './harness'

/** Deeper than V8's recursive JSON.stringify manages, like adversarial model or MCP JSON. */
const ADVERSARIAL_DEPTH = 20_000

/** `{ next: { next: … { leaf: true } } }`, `levels` objects deep. */
function chain(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let current = root
  for (let level = 1; level < levels; level++) {
    const next: Record<string, unknown> = {}
    current.next = next
    current = next
  }
  current.leaf = true
  return root
}

/** contextBridge recursion steps of the deepest container (object 2, array 1), counted without recursion. */
function bridgeDepthOf(value: unknown): number {
  let deepest = 0
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const item = stack.pop()!
    if (item.value === null || typeof item.value !== 'object') continue
    const depth = item.depth + (Array.isArray(item.value) ? 1 : 2)
    deepest = Math.max(deepest, depth)
    for (const child of Object.values(item.value)) stack.push({ value: child, depth })
  }
  return deepest
}

await check('limitPayloadDepth: payloads within the bridge budget pass through untouched (same object)', () => {
  // 440 nested objects: 880 steps plus the two wrapping objects.
  const payload = { agentId: 'a1', event: { type: 'message_end', details: chain(440) } }
  assert.equal(bridgeDepthOf(payload), 884)
  assert.equal(limitPayloadDepth(payload), payload)
  assert.equal(limitPayloadDepth('text'), 'text')
  assert.equal(limitPayloadDepth(null), null)
})

await check('limitPayloadDepth: 500 nested objects (contextBridge refuses them) are cut with a placeholder', () => {
  const payload = { agentId: 'a1', event: { type: 'tool_execution_end', result: { details: chain(500) } }, keep: [1, 'two'] }
  const bounded = limitPayloadDepth(payload)
  assert.notEqual(bounded, payload, 'a copy, the original stays intact')
  assert.equal(bridgeDepthOf(payload), 1006)
  assert.ok(bridgeDepthOf(bounded) <= MAX_BRIDGE_DEPTH)
  assert.ok(JSON.stringify(bounded).includes(JSON.stringify(TOO_DEEP_PLACEHOLDER)))
  assert.deepEqual(bounded.keep, [1, 'two'])
  assert.equal(bounded.event.type, 'tool_execution_end')
})

await check(`limitPayloadDepth: ${ADVERSARIAL_DEPTH}-deep objects and arrays and cycles end in a placeholder`, () => {
  assert.ok(bridgeDepthOf(limitPayloadDepth({ details: chain(ADVERSARIAL_DEPTH) })) <= MAX_BRIDGE_DEPTH)

  let nested: unknown[] = []
  for (let level = 0; level < ADVERSARIAL_DEPTH; level++) nested = [nested]
  assert.equal(bridgeDepthOf(limitPayloadDepth({ nested })), MAX_BRIDGE_DEPTH, 'arrays cost one step each')

  const cyclic: Record<string, unknown> = { name: 'loop' }
  cyclic.self = cyclic
  const bounded = limitPayloadDepth(cyclic, 10)
  assert.deepEqual(bounded, { name: 'loop', self: { name: 'loop', self: { name: 'loop', self: { name: 'loop', self: { name: 'loop', self: TOO_DEEP_PLACEHOLDER } } } } })
})
