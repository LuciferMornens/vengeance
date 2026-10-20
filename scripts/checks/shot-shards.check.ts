import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { check } from './harness'

interface Shard {
  files: string[]
  seconds: number
}

/** The shard functions of scripts/shots.mjs, which launches nothing when imported. */
interface ShotsHarness {
  scenarioFiles(): Promise<string[]>
  parseShard(args: string[]): { index: number; count: number } | null
  splitShards(files: string[], count: number): Shard[]
}

// A non-literal specifier keeps esbuild from bundling the harness and Playwright into the checks.
const harnessUrl = pathToFileURL(join(process.cwd(), 'scripts', 'shots.mjs')).href
const shots = (await import(harnessUrl)) as ShotsHarness
const files = await shots.scenarioFiles()

await check('shot shards: every shard count puts each scenario file in exactly one shard', () => {
  assert.ok(files.length > 1, 'scripts/shots has scenario files to split')
  const withNewFile = [...files, 'zz-new-scenario.mjs'].sort()
  for (const list of [files, withNewFile]) {
    for (let count = 1; count <= list.length; count++) {
      const shards = shots.splitShards(list, count)
      assert.equal(shards.length, count)
      for (const shard of shards) assert.ok(shard.files.length > 0, `${count} shards: none empty`)
      const assigned = shards.flatMap((shard) => shard.files).sort()
      assert.deepEqual(assigned, list, `${count} shards: each file once`)
    }
  }
})

await check('shot shards: the split is deterministic and balanced by expected seconds', () => {
  const shards = shots.splitShards(files, 2)
  assert.deepEqual(shots.splitShards([...files].reverse(), 2), shards, 'input order is irrelevant')
  for (const shard of shards) assert.deepEqual(shard.files, [...shard.files].sort(), 'name order')

  const seconds = (list: string[]): number => shots.splitShards(list, 1)[0]!.seconds
  const heaviest = files.reduce((a, b) => (seconds([b]) > seconds([a]) ? b : a))
  const [first, second] = shards.map((shard) => shard.seconds) as [number, number]
  assert.ok(Math.abs(first - second) <= seconds([heaviest]), `${first} s vs ${second} s`)

  // Unlisted files that together take less than the heaviest file all share the other shard:
  // expected seconds decide, not file counts.
  const lightCount = Math.floor((seconds([heaviest]) - 1) / seconds(['zz-new.mjs']))
  const light = Array.from({ length: lightCount }, (_, index) => `zz-new-${index}.mjs`).sort()
  assert.ok(light.length >= 2, 'enough light files to tell seconds from file counts')
  const [alone, together] = shots.splitShards([heaviest, ...light], 2) as [Shard, Shard]
  assert.deepEqual(alone.files, [heaviest])
  assert.deepEqual(together.files, light)
})

await check('shot shards: --shard=<i>/<n> parses whole numbers 1 <= i <= n only', () => {
  assert.equal(shots.parseShard([]), null)
  assert.equal(shots.parseShard(['chat', 'composer']), null)
  assert.deepEqual(shots.parseShard(['--shard=1/2']), { index: 1, count: 2 })
  assert.deepEqual(shots.parseShard(['--shard=3/3']), { index: 3, count: 3 })
  for (const arg of [
    '--shard',
    '--shard=',
    '--shard=1',
    '--shard=0/2',
    '--shard=3/2',
    '--shard=1/0',
    '--shard=-1/2',
    '--shard=1.5/2',
    '--shard=a/b',
    '--shard=1/2/3',
    '--shard= 1/2'
  ]) {
    assert.throws(() => shots.parseShard([arg]), /expected --shard=<i>\/<n>/, arg)
  }
  assert.throws(() => shots.parseShard(['--shard=1/2', '--shard=2/2']), /given 2 times/)
  assert.throws(() => shots.parseShard(['--shard=1/2', 'chat']), /drop the scenario names chat/)
  assert.throws(
    () => shots.splitShards(files, files.length + 1),
    new RegExp(`only ${files.length} scenario files`)
  )
})
