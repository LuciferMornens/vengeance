import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { check } from './harness'

type Yaml = string | boolean | Yaml[] | YamlMap | null
interface YamlMap {
  [key: string]: Yaml
}

/** The receipt's rule for the cache key of a payload a release dry run restored. */
interface ReleaseReceipt {
  checkEnginesCacheKey(key: string, context: { platform: string; event: string | undefined }): void
}

/**
 * Parses the YAML subset the workflows use: block mappings and sequences, plain and quoted
 * scalars, flow sequences of scalars, `{}`, block scalars and comments. Anything else throws
 * instead of being misread.
 */
function parseYaml(source: string, file: string): YamlMap {
  const lines = source.split(/\r?\n/)
  let at = 0
  const problem = (message: string): Error => new Error(`${file}:${at + 1}: ${message}`)
  const indentOf = (line: string): number => line.length - line.trimStart().length
  /** The indent of the next line with content, past blank and comment lines; -1 at the end. */
  const nextIndent = (): number => {
    while (at < lines.length && /^\s*(#.*)?$/.test(lines[at]!)) at++
    if (at === lines.length) return -1
    if (/^ *\t/.test(lines[at]!)) throw problem('tab indentation')
    return indentOf(lines[at]!)
  }
  const isItem = (indent: number): boolean => /^-( |$)/.test(lines[at]!.slice(indent))

  function mapping(indent: number): YamlMap {
    const result: YamlMap = {}
    while (nextIndent() === indent && !isItem(indent)) {
      const entry = /^([\w.-]+):(?: +(.*))?$/.exec(lines[at]!.slice(indent))
      if (!entry) throw problem('expected a key')
      const [, key = '', text = ''] = entry
      if (key in result) throw problem(`duplicate key ${key}`)
      if (text === '' || text.startsWith('#')) {
        at++
        // The block below the key; a sequence may share the key's indent.
        const child = nextIndent()
        if (child > indent) result[key] = isItem(child) ? sequence(child) : mapping(child)
        else result[key] = child === indent && isItem(indent) ? sequence(indent) : null
      } else {
        result[key] = value(text, indent)
      }
    }
    if (nextIndent() > indent) throw problem('unexpected indentation')
    return result
  }

  function sequence(indent: number): Yaml[] {
    const items: Yaml[] = []
    while (nextIndent() === indent && isItem(indent)) {
      const rest = lines[at]!.slice(indent + 2)
      if (/^[\w.-]+:( |$)/.test(rest)) {
        // The item's first key starts its mapping: read it as though the dash were indentation.
        lines[at] = ' '.repeat(indent + 2) + rest
        items.push(mapping(indent + 2))
      } else if (rest.trim() !== '') {
        items.push(value(rest, indent))
      } else {
        throw problem('unsupported empty sequence item')
      }
    }
    if (nextIndent() > indent) throw problem('unexpected indentation')
    return items
  }

  function value(text: string, indent: number): Yaml {
    const block = /^([|>])(-?)$/.exec(text)
    if (block) return blockScalar(indent, block[1] === '>', block[2] === '-')
    let result: Yaml
    if (text.startsWith('[')) {
      if (!text.endsWith(']')) throw problem('unsupported flow sequence')
      const inner = text.slice(1, -1).trim()
      result = inner ? inner.split(',').map((item) => scalar(item.trim())) : []
    } else {
      result = text === '{}' ? {} : scalar(text)
    }
    at++
    return result
  }

  function scalar(text: string): string | boolean {
    const single = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(text)
    if (single) return single[1]!.replace(/''/g, "'")
    const double = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(text)
    if (double) return JSON.parse(`"${double[1]}"`) as string
    const plain = text.replace(/\s+#.*$/, '').trim()
    if (/^['"&*!|>{%@`]/.test(plain)) throw problem(`unsupported scalar ${plain}`)
    return plain === 'true' || plain === 'false' ? plain === 'true' : plain
  }

  function blockScalar(indent: number, folded: boolean, strip: boolean): string {
    at++
    const body: string[] = []
    while (at < lines.length && (lines[at]!.trim() === '' || indentOf(lines[at]!) > indent)) {
      body.push(lines[at++]!)
    }
    while (body.length && body.at(-1)!.trim() === '') body.pop()
    const first = body.find((line) => line.trim() !== '')
    if (first === undefined) return ''
    const depth = indentOf(first)
    if (body.some((line) => line.trim() !== '' && indentOf(line) < depth)) {
      throw problem('a block scalar line is indented less than its first line')
    }
    const text = body.map((line) => line.slice(depth))
    return folded ? text.join(' ') : text.join('\n') + (strip ? '' : '\n')
  }

  const document = mapping(0)
  if (nextIndent() !== -1) throw problem('unexpected content')
  return document
}

function asMap(node: Yaml | undefined, what: string): YamlMap {
  if (node === null || node === undefined || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${what} is not a mapping`)
  }
  return node
}

function asList(node: Yaml | undefined, what: string): Yaml[] {
  if (!Array.isArray(node)) throw new Error(`${what} is not a sequence`)
  return node
}

function asText(node: Yaml | undefined, what: string): string {
  if (typeof node !== 'string') throw new Error(`${what} is not a string`)
  return node
}

const PAYLOAD_PATHS = '.engine-staging/bundled\nresources/prime-auth/bin\n'
const ENGINE_INPUTS = [
  'engines.lock.json',
  'patches/**',
  'scripts/engines/**',
  'scripts/build-prime-auth.mjs',
  'resources/prime-auth/**',
  '!resources/prime-auth/bin/**',
  'rust-toolchain.toml',
  '.node-version'
]
const INPUT_HASH = '0123456789abcdef'.repeat(4)

/** A job that uses the staged engine payload's cache entry. */
interface CacheJob {
  name: string
  job: YamlMap
  rows: YamlMap[]
  platforms: string[]
  /** The first cache step, a restore that computes the key; the others reuse its primary key. */
  lookup: YamlMap
  saves: YamlMap[]
  /** Later restores: a writer's proof that the entry is cached. */
  confirms: YamlMap[]
  steps: YamlMap[]
}

function cacheJobs(file: string): CacheJob[] {
  const source = readFileSync(join(process.cwd(), '.github', 'workflows', file), 'utf8')
  const jobs: CacheJob[] = []
  for (const [id, node] of Object.entries(asMap(parseYaml(source, file).jobs, `${file} jobs`))) {
    const name = `${file} ${id}`
    const job = asMap(node, name)
    const uses = (step: YamlMap): string => asText(step.uses, `${name} uses`)
    const option = (step: YamlMap, key: string): Yaml | undefined => asMap(step.with, name)[key]
    const steps = asList(job.steps, `${name} steps`)
      .map((step) => asMap(step, `${name} step`))
      .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/cache'))
      .filter((step) =>
        asText(option(step, 'path'), `${name} cache path`).includes('.engine-staging')
      )
    const [lookup, ...later] = steps
    if (!lookup) continue
    for (const step of steps) {
      assert.match(uses(step), /^actions\/cache\/(restore|save)@/, `${name}: restore or save`)
      assert.equal(option(step, 'path'), PAYLOAD_PATHS, `${name}: payload paths`)
    }
    assert.match(uses(lookup), /^actions\/cache\/restore@/, `${name}: its first step restores`)
    if (later.length) {
      const primaryKey = `\${{ steps.${asText(lookup.id, name)}.outputs.cache-primary-key }}`
      for (const step of later) assert.equal(option(step, 'key'), primaryKey, `${name}: key`)
    }
    const matrix = asMap(asMap(job.strategy, `${name} strategy`).matrix, `${name} matrix`)
    const rows = asList(matrix.include, `${name} include`).map((row) => asMap(row, name))
    const platforms = rows.map((row) => asText(row.platform, `${name} platform`))
    if (matrix.platform !== undefined) {
      assert.deepEqual(asList(matrix.platform, name), platforms, `${name}: a row per platform`)
    }
    const saves = later.filter((step) => uses(step).startsWith('actions/cache/save@'))
    const confirms = later.filter((step) => !saves.includes(step))
    jobs.push({ name, job, rows, platforms, lookup, saves, confirms, steps })
  }
  return jobs
}

interface Workflows {
  jobs: CacheJob[]
  ciEngines: CacheJob
  mainEngines: CacheJob
  release: CacheJob
  restorers: CacheJob[]
}

let parsed: Workflows | undefined

/** Both workflows' engine cache jobs, read on first use so that a parse error fails each check. */
function workflows(): Workflows {
  if (parsed) return parsed
  const jobs = [...cacheJobs('ci.yml'), ...cacheJobs('release.yml')]
  const byName = (name: string): CacheJob => {
    const job = jobs.find((candidate) => candidate.name === name)
    if (!job) throw new Error(`${name} does not use the engine cache`)
    return job
  }
  parsed = {
    jobs,
    ciEngines: byName('ci.yml engines'),
    mainEngines: byName('ci.yml release-engines'),
    release: byName('release.yml build'),
    restorers: [byName('ci.yml checks'), byName('ci.yml shots')]
  }
  return parsed
}

const keyOf = (job: CacheJob): string => asText(asMap(job.lookup.with, job.name).key, job.name)

/** The key a job computes for one matrix row, with a fixed engine input hash. */
function renderKey(expression: string, row: YamlMap): string {
  return expression.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, body: string) => {
    if (body.startsWith('hashFiles(')) return INPUT_HASH
    const reference = /^matrix\.([\w.-]+)(?:\s*\|\|\s*'([^']*)')?$/.exec(body)
    if (!reference) throw new Error(`the engine cache key cannot use \${{ ${body} }}`)
    const path = reference[1]!
    let node: Yaml | undefined = row
    for (const field of path.split('.')) node = asMap(node, `matrix.${path}`)[field]
    return asText(node, `matrix.${path}`) || (reference[2] ?? '')
  })
}

await check('engine cache: every job computes one key of platform, builder and inputs', () => {
  const { jobs } = workflows()
  const names = jobs.map((job) => job.name)
  const ci = ['engines', 'release-engines', 'checks', 'shots'].map((id) => `ci.yml ${id}`)
  assert.deepEqual(names, [...ci, 'release.yml build'], 'the jobs that use the engine cache')
  const keys = [...new Set(jobs.map(keyOf))]
  assert.equal(keys.length, 1, `the jobs compute different keys:\n${keys.join('\n')}`)
  const key = keys[0]!
  const builder = "${{ matrix.builder.runner }}-${{ matrix.builder.container || 'no-container' }}"
  assert.ok(key.startsWith(`engines-v2-\${{ matrix.platform }}-${builder}-`), key)
  const hashed = /^engines-v2-.*-\$\{\{ hashFiles\((.*)\) \}\}$/.exec(key)?.[1]
  assert.deepEqual(
    hashed?.split(',').map((input) => input.trim()),
    ENGINE_INPUTS.map((input) => `'${input}'`),
    'the key ends with the hash of the engine inputs'
  )
})

await check('engine cache: jobs that save the payload run on the builder in its key', () => {
  const { jobs } = workflows()
  for (const job of jobs.filter((candidate) => candidate.saves.length)) {
    assert.equal(job.job['runs-on'], '${{ matrix.builder.runner }}', `${job.name} runs-on`)
    assert.equal(job.job.container, '${{ matrix.builder.container }}', `${job.name} container`)
  }
  for (const job of jobs) {
    for (const row of job.rows) {
      const platform = asText(row.platform, job.name)
      const where = `${job.name} ${platform}`
      const builder = asMap(row.builder, `${where} builder`)
      assert.deepEqual(Object.keys(builder).sort(), ['container', 'runner'], where)
      assert.match(asText(builder.runner, where), /^[a-z0-9][a-z0-9.-]*$/, `${where} runner`)
      const container = asText(builder.container, `${where} container`)
      if (platform.startsWith('linux-')) {
        assert.match(container, /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/, where)
      } else {
        assert.equal(container, '', `${where} builds on the runner itself`)
      }
    }
  }
})

await check('engine cache: each platform has one builder in both workflows', () => {
  const { jobs, release } = workflows()
  const builders = new Map<string, { builder: string; where: string }>()
  for (const job of jobs) {
    for (const row of job.rows) {
      const platform = asText(row.platform, job.name)
      const builder = JSON.stringify(row.builder)
      const first = builders.get(platform)
      if (first) assert.equal(builder, first.builder, `${platform}: ${job.name}, ${first.where}`)
      else builders.set(platform, { builder, where: job.name })
    }
  }
  assert.deepEqual([...builders.keys()].sort(), [...release.platforms].sort())
})

await check('engine cache: one job saves each key in each cache scope', () => {
  const { jobs, ciEngines, mainEngines, release, restorers } = workflows()
  assert.deepEqual(
    jobs.filter((job) => job.saves.length).map((job) => job.name),
    [ciEngines.name, mainEngines.name, release.name]
  )
  assert.equal(ciEngines.job.if, undefined, 'CI builds its platforms on every event')
  assert.equal(mainEngines.job.if, "github.ref == 'refs/heads/main'")
  assert.deepEqual(
    [...ciEngines.platforms, ...mainEngines.platforms].sort(),
    [...release.platforms].sort(),
    'CI builds each release platform in one job'
  )
  for (const row of release.rows) {
    const platform = asText(row.platform, release.name)
    assert.equal(row['ci-engines'], ciEngines.platforms.includes(platform), platform)
  }
  assert.equal(release.lookup.if, "github.event_name == 'pull_request'", 'only dry runs restore')
  assert.deepEqual(
    release.saves.map((save) => save.if),
    [
      "github.event_name == 'pull_request' && !matrix.ci-engines" +
        " && steps.engines.outputs.cache-hit != 'true'"
    ],
    'dry runs save only the platforms CI does not build in pull requests'
  )
  for (const job of restorers) {
    assert.ok(asList(job.job.needs, job.name).includes('engines'), `${job.name} needs engines`)
    assert.ok(job.platforms.every((platform) => ciEngines.platforms.includes(platform)))
  }
})

await check('engine cache: a missing entry fails the job that builds it', () => {
  const { ciEngines, mainEngines, restorers } = workflows()
  for (const job of [ciEngines, mainEngines]) {
    const option = (step: YamlMap, key: string): Yaml | undefined => asMap(step.with, job.name)[key]
    assert.equal(option(job.lookup, 'lookup-only'), true, `${job.name}: a hit downloads nothing`)
    assert.equal(job.saves.length, 1, `${job.name} saves once`)
    assert.equal(job.confirms.length, 1, `${job.name} confirms the entry once`)
    const [save, confirm] = [job.saves[0]!, job.confirms[0]!]
    assert.ok(job.steps.indexOf(confirm) > job.steps.indexOf(save), `${job.name}: then confirms`)
    assert.equal(confirm.if, save.if, `${job.name}: confirms whenever it saves`)
    assert.equal(option(confirm, 'lookup-only'), true, `${job.name}: confirms by lookup`)
    assert.equal(option(confirm, 'fail-on-cache-miss'), true, `${job.name}: fails on a miss`)
  }
  for (const job of restorers) {
    assert.equal(job.steps.length, 1, `${job.name} only restores`)
    assert.equal(asMap(job.lookup.with, job.name)['fail-on-cache-miss'], true, job.name)
    assert.equal(asMap(job.lookup.with, job.name)['lookup-only'], undefined, job.name)
  }
})

await check('release receipt: only a pull request key for its own platform passes', async () => {
  const { release } = workflows()
  // A non-literal specifier keeps esbuild from bundling the receipt script into the checks.
  const url = pathToFileURL(join(process.cwd(), 'scripts', 'ci', 'release-receipt.mjs')).href
  const receipt = (await import(url)) as ReleaseReceipt
  const keys = release.rows.map((row) => ({
    platform: asText(row.platform, release.name),
    key: renderKey(keyOf(release), row)
  }))
  for (const { platform, key } of keys) {
    receipt.checkEnginesCacheKey(key, { platform, event: 'pull_request' })
    for (const event of ['push', 'schedule', 'workflow_dispatch', undefined]) {
      assert.throws(
        () => receipt.checkEnginesCacheKey(key, { platform, event }),
        /Only pull request dry runs/,
        `${platform} ${event}`
      )
    }
    const others = keys.filter((other) => other.platform !== platform).map((other) => other.key)
    const builderless = `engines-v1-${platform}-${INPUT_HASH}`
    for (const wrong of [...others, builderless, key.slice(0, -65), `${key}-${INPUT_HASH}`]) {
      assert.throws(
        () => receipt.checkEnginesCacheKey(wrong, { platform, event: 'pull_request' }),
        new RegExp(`is not a ${platform} engine payload key`),
        `${wrong} on ${platform}`
      )
    }
  }
})
