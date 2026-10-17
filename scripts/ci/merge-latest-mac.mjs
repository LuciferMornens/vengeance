// Merges the two macOS update files of a release into the one electron-updater reads. Each Mac
// build runs on its own runner and writes release/latest-mac.yml for its architecture; the
// release workflow renames them latest-mac-x64.yml and latest-mac-arm64.yml. The merged
// latest-mac.yml lists every file of both, the way one two-arch electron-builder run writes it
// (x64 first, top-level path and sha512 from x64): electron-updater's MacUpdater picks the files
// whose URL contains "arm64" on Apple silicon and the others on Intel.
//
//   node scripts/ci/merge-latest-mac.mjs <folder>
//
// Writes <folder>/latest-mac.yml and removes the two inputs. The parser accepts exactly the YAML
// electron-builder writes for update files (js-yaml block style: top-level scalars and the `files`
// list of `url:`-first mappings); anything else fails, so a format change never merges silently.
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REQUIRED_KEYS = ['version', 'files', 'path', 'sha512']
const REQUIRED_FILE_KEYS = ['url', 'sha512', 'size']

const folder = process.argv[2]
if (!folder || process.argv.length > 3) {
  console.error('usage: node scripts/ci/merge-latest-mac.mjs <folder>')
  process.exit(2)
}
const output = join(folder, 'latest-mac.yml')
const inputs = {
  x64: join(folder, 'latest-mac-x64.yml'),
  arm64: join(folder, 'latest-mac-arm64.yml')
}

try {
  if (await exists(output)) throw new Error(`${output} exists; expected only the per-arch files`)
  const x64 = parseUpdateInfo(await readFile(inputs.x64, 'utf8'), inputs.x64)
  const arm64 = parseUpdateInfo(await readFile(inputs.arm64, 'utf8'), inputs.arm64)
  if (x64.scalars.get('version') !== arm64.scalars.get('version')) {
    throw new Error(
      `version differs: x64 ${x64.scalars.get('version')}, arm64 ${arm64.scalars.get('version')}`
    )
  }
  for (const [arch, info] of [['x64', x64], ['arm64', arm64]]) {
    for (const file of info.files) {
      if (isArm64(file.url) !== (arch === 'arm64')) {
        throw new Error(`${inputs[arch]} lists ${file.url}, which MacUpdater offers the other arch`)
      }
    }
  }
  const files = [...x64.files, ...arm64.files]
  const urls = new Set(files.map((file) => file.url))
  if (urls.size !== files.length) throw new Error('the two update files list the same URL')

  const lines = x64.order.flatMap((key) =>
    key === 'files' ? ['files:', ...files.flatMap((file) => file.lines)] : [x64.lines.get(key)]
  )
  await writeFile(output, `${lines.join('\n')}\n`)
  await Promise.all(Object.values(inputs).map((input) => rm(input)))
  console.log(`${output}: version ${x64.scalars.get('version')}, ${files.length} files`)
  for (const file of files) console.log(`  ${file.url}`)
} catch (error) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : 'error: '
  console.error(`${prefix}${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

/** MacUpdater's own test: a file is for Apple silicon when its URL contains arm64. */
function isArm64(url) {
  return url.includes('arm64')
}

/**
 * Splits an update file into its top-level lines (kept verbatim, in order) and its `files` entries
 * (each with its verbatim lines and unquoted URL). Values stay raw: nothing is re-serialized.
 */
function parseUpdateInfo(text, source) {
  const order = []
  const lines = new Map()
  const scalars = new Map()
  const files = []
  let inFiles = false
  for (const [index, line] of text.replace(/\n$/, '').split('\n').entries()) {
    const at = `${source}:${index + 1}`
    const scalar = /^([A-Za-z]\w*): (\S.*)$/.exec(line)
    const entry = /^ {2}- ([A-Za-z]\w*): (\S.*)$/.exec(line)
    const field = /^ {4}([A-Za-z]\w*): (\S.*)$/.exec(line)
    if (line === 'files:' || scalar) {
      const key = scalar ? scalar[1] : 'files'
      if (order.includes(key)) throw new Error(`${at}: duplicate key ${key}`)
      order.push(key)
      inFiles = key === 'files'
      if (scalar) {
        lines.set(key, line)
        scalars.set(key, unquote(scalar[2]))
      }
    } else if (inFiles && entry) {
      if (entry[1] !== 'url') throw new Error(`${at}: a files entry must start with url`)
      files.push({ url: unquote(entry[2]), keys: new Set(['url']), lines: [line] })
    } else if (inFiles && field && files.length > 0) {
      const file = files.at(-1)
      if (file.keys.has(field[1])) throw new Error(`${at}: duplicate key ${field[1]}`)
      file.keys.add(field[1])
      file.lines.push(line)
    } else {
      throw new Error(`${at}: unexpected line ${JSON.stringify(line)}`)
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!order.includes(key)) throw new Error(`${source}: ${key} is missing`)
  }
  if (files.length === 0) throw new Error(`${source}: files is empty`)
  for (const file of files) {
    for (const key of REQUIRED_FILE_KEYS) {
      if (!file.keys.has(key)) throw new Error(`${source}: ${file.url} has no ${key}`)
    }
  }
  return { order, lines, scalars, files }
}

/** A js-yaml plain or quoted scalar's text. */
function unquote(raw) {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  if (raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw)
  return raw
}

async function exists(file) {
  return access(file).then(
    () => true,
    () => false
  )
}
