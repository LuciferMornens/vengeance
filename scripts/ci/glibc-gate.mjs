// GLIBC gate for the Linux release builds: no ELF file a package loads on its architecture may
// need a glibc symbol version newer than the build container's (Ubuntu 22.04, glibc 2.35), so the
// packages run on that distro and every newer one. Reads dynamic symbol versions with binutils
// `objdump -T` (OBJDUMP overrides the command).
//
//   node scripts/ci/glibc-gate.mjs [--max 2.35] <file or folder>...
//
// Folders are walked: their ELF files for another machine (prebuilds a package carries for other
// architectures) are skipped, and so are files that import no versioned glibc symbol. A file named
// on the command line must be an ELF file for this machine that does.
import { execFile } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const executeFile = promisify(execFile)

/** ELF `e_machine` of the architectures Vengeance ships for Linux. */
const ELF_MACHINE = { x64: 62, arm64: 183 }

const { values, positionals } = parseArgs({
  options: { max: { type: 'string', default: '2.35' } },
  allowPositionals: true
})
const machine = ELF_MACHINE[process.arch]
if (!/^\d+(?:\.\d+)+$/.test(values.max)) usage(`--max must look like 2.35, got ${values.max}`)
if (positionals.length === 0) usage('name at least one file or folder to check')
if (machine === undefined) usage(`no ELF machine is known for ${process.arch}`)

const failures = []
let checked = 0
let newestOverall
for (const target of positionals) {
  const folder = (await stat(target)).isDirectory()
  if (!folder && (await elfMachine(target)) !== machine) {
    failures.push(`${target} is not an ELF file for ${process.arch}`)
    continue
  }
  for (const file of folder ? await elfFilesIn(target) : [target]) {
    const newest = await newestGlibc(file)
    if (!newest) {
      if (!folder) failures.push(`${file} imports no versioned glibc symbol`)
      continue
    }
    checked += 1
    console.log(`  GLIBC_${newest.padEnd(6)} ${file}`)
    if (compareVersions(newest, values.max) > 0) {
      failures.push(`${file} needs GLIBC_${newest}; the baseline is GLIBC_${values.max}`)
    }
    if (!newestOverall || compareVersions(newest, newestOverall) > 0) newestOverall = newest
  }
}
if (checked === 0) failures.push('no ELF file with versioned glibc symbols was found')
const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : 'error: '
for (const failure of failures) console.error(`${prefix}${failure}`)
if (failures.length > 0) process.exit(1)
console.log(`GLIBC gate passed: ${checked} checked, newest GLIBC_${newestOverall} <= ${values.max}`)

/** The ELF `e_machine` of `file`, or null when it is not an ELF file. */
async function elfMachine(file) {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(20)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < header.length || header.readUInt32BE(0) !== 0x7f454c46) return null
    // EI_DATA: 1 little-endian, 2 big-endian.
    return header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18)
  } finally {
    await handle.close()
  }
}

/** Every regular file below `folder` that is an ELF file for this machine. */
async function elfFilesIn(folder) {
  const files = []
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    const file = join(entry.parentPath, entry.name)
    if (entry.isFile() && (await elfMachine(file)) === machine) files.push(file)
  }
  return files.sort()
}

/** The newest `GLIBC_x.y` version `file` requires, or undefined when it requires none. */
async function newestGlibc(file) {
  const { stdout } = await executeFile(process.env.OBJDUMP || 'objdump', ['-T', file], {
    maxBuffer: 256 * 1024 * 1024
  })
  let newest
  for (const [, version] of stdout.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) {
    if (!newest || compareVersions(version, newest) > 0) newest = version
  }
  return newest
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

function usage(message) {
  console.error(`glibc-gate: ${message}`)
  console.error('usage: node scripts/ci/glibc-gate.mjs [--max 2.35] <file or folder>...')
  process.exit(2)
}
