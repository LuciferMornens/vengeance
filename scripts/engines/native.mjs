import { spawn } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { run } from './common.mjs'

/** Electron's minimum macOS release; Engine 2 and its helper must start wherever the app does. */
const MACOS_MINIMUM = '13.0'
/**
 * Linux builds run in an Ubuntu 22.04 container; no symbol may require a newer glibc. On a newer
 * distribution, VENGEANCE_GLIBC_BASELINE=host builds for that machine. Releases never set it;
 * they check the packaged app again (scripts/ci/glibc-gate.mjs).
 */
const GLIBC_MAXIMUM = '2.35'
/** Thin Mach-O headers in either byte order (32- and 64-bit), read big-endian. */
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe])
/** Java class files share 0xcafebabe with universal binaries, but their version is at least 45. */
const FAT_MAGIC = new Set([0xcafebabe, 0xcafebabf])
const FAT_ARCHITECTURES_MAXIMUM = 20
const ELF_SYSTEM_LIBRARY = new RegExp(
  '^(libc\\.so\\.6|libm\\.so\\.6|libgcc_s\\.so\\.1|libpthread\\.so\\.0|' +
    'libdl\\.so\\.2|librt\\.so\\.1|ld-linux[\\w.-]*\\.so\\.\\d+)$'
)
const MACHO_SYSTEM_LIBRARIES = [
  '/usr/lib/libSystem',
  '/usr/lib/libc++',
  '/usr/lib/libobjc',
  '/usr/lib/libresolv',
  '/usr/lib/libz',
  '/usr/lib/libiconv',
  '/System/Library/Frameworks/'
]
const MACHO_DEPENDENCY_COMMANDS = new Set([
  'LC_LOAD_DYLIB',
  'LC_LOAD_WEAK_DYLIB',
  'LC_REEXPORT_DYLIB',
  'LC_LOAD_UPWARD_DYLIB',
  'LC_LAZY_LOAD_DYLIB',
  'LC_PREBOUND_DYLIB',
  'LC_LOADFVMLIB'
])

export function nativeBuildEnvironment() {
  if (process.platform !== 'darwin') return process.env
  return {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || MACOS_MINIMUM
  }
}

/** Ad-hoc signatures carry no timestamp, so the signed bytes stay reproducible. */
export function signAdHoc(executable) {
  run('codesign', ['--force', '--sign', '-', executable])
}

async function isMachO(path) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(8)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead < header.length) return false
    const magic = header.readUInt32BE(0)
    if (MACHO_MAGIC.has(magic)) return true
    return FAT_MAGIC.has(magic) && header.readUInt32BE(4) < FAT_ARCHITECTURES_MAXIMUM
  } finally {
    await file.close()
  }
}

/**
 * Prebuilt Node addons can be unsigned. Packaging leaves engine payloads untouched
 * (electron-builder.yml signIgnore), so they get signed here.
 */
export async function signMachOFiles(directory) {
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    if (!entry.isFile() || !(await isMachO(path))) continue
    signAdHoc(path)
    run('codesign', ['--verify', '--strict', path])
  }
}

// Tool output is streamed: PE unwind tables can exceed pipe capture limits.
async function scanLines(command, args, onLine) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  await Promise.all([
    completed,
    (async () => {
      for await (const line of lines) onLine(line)
    })()
  ])
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

async function verifyPe(executable) {
  const libraries = []
  await scanLines(process.env.OBJDUMP ?? 'objdump', ['-p', executable], (line) => {
    const match = /DLL Name:\s*(\S+)/.exec(line)
    if (match) libraries.push(match[1])
  })
  if (!libraries.length || libraries.some((name) => /libgcc|libstdc|libwinpthread/i.test(name))) {
    throw new Error(
      `${executable} has unexpected compiler runtime dependencies: ${libraries.join(', ')}`
    )
  }
}

async function verifyElf(executable) {
  const objdump = process.env.OBJDUMP ?? 'objdump'
  const libraries = []
  await scanLines(objdump, ['-p', executable], (line) => {
    const match = /^\s*NEEDED\s+(\S+)/.exec(line)
    if (match) libraries.push(match[1])
  })
  if (!libraries.length || libraries.some((name) => !ELF_SYSTEM_LIBRARY.test(name))) {
    throw new Error(`${executable} links libraries outside the C runtime: ${libraries.join(', ')}`)
  }
  const baseline = process.env.VENGEANCE_GLIBC_BASELINE
  if (baseline === 'host') return
  if (baseline) throw new Error("VENGEANCE_GLIBC_BASELINE must be 'host' or unset")
  let newest
  await scanLines(objdump, ['-T', executable], (line) => {
    for (const [, version] of line.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) {
      if (!newest || compareVersions(version, newest) > 0) newest = version
    }
  })
  if (!newest) throw new Error(`${executable} has no glibc symbol versions to check`)
  if (compareVersions(newest, GLIBC_MAXIMUM) > 0) {
    throw new Error(
      `${executable} requires GLIBC_${newest}; the baseline is GLIBC_${GLIBC_MAXIMUM}. Build in ` +
        'Ubuntu 22.04, or set VENGEANCE_GLIBC_BASELINE=host for a build used only on this machine'
    )
  }
}

function machOLoadCommands(executable, lines) {
  const commands = []
  let current
  for (const line of lines) {
    if (/^\s*Load command \d+\s*$/.test(line)) {
      current = {}
      commands.push(current)
      continue
    }
    const kind = /^\s*cmd\s+(LC_\w+)(?:\s|$)/.exec(line)
    if (kind && current) {
      if (current.kind !== undefined) {
        throw new Error(`${executable} has duplicate cmd fields in a Mach-O load command`)
      }
      current.kind = kind[1]
    }
    const field = /^\s*(name|minos)\s+(.+)$/.exec(line)
    if (!field || !current) continue
    const [, name, value] = field
    if (current[name] !== undefined) {
      throw new Error(`${executable} has duplicate ${name} fields in ${current.kind}`)
    }
    current[name] = value.trim()
  }
  if (commands.some((command) => !command.kind)) {
    throw new Error(`${executable} has an unrecognized Mach-O load command`)
  }
  return commands
}

function machOLibraryName(executable, command) {
  const name = /^(\S.*?) \(offset \d+\)$/.exec(command.name ?? '')?.[1]
  if (!name) throw new Error(`${executable} has no valid name in ${command.kind}`)
  return name
}

/** LC_ID_DYLIB names the image itself; only load commands create library dependencies. */
export function verifyMachOLoadCommands(executable, lines) {
  const commands = machOLoadCommands(executable, lines)
  const libraries = []
  const minimums = []
  for (const command of commands) {
    if (MACHO_DEPENDENCY_COMMANDS.has(command.kind)) {
      libraries.push(machOLibraryName(executable, command))
    } else if (command.kind === 'LC_LOAD_DYLINKER') {
      const linker = machOLibraryName(executable, command)
      if (linker !== '/usr/lib/dyld') {
        throw new Error(`${executable} uses a dynamic linker outside macOS: ${linker}`)
      }
    } else if (
      command.kind !== 'LC_ID_DYLIB' &&
      (/^LC_LOAD/.test(command.kind) || /(?:DYLIB|FVMLIB)$/.test(command.kind))
    ) {
      throw new Error(`${executable} has an unsupported dependency command: ${command.kind}`)
    }
    if (command.kind === 'LC_BUILD_VERSION') {
      if (!/^\d+(?:\.\d+)+$/.test(command.minos ?? '')) {
        throw new Error(`${executable} has no valid minos in LC_BUILD_VERSION`)
      }
      minimums.push(command.minos)
    }
  }
  const system = (name) => MACHO_SYSTEM_LIBRARIES.some((prefix) => name.startsWith(prefix))
  if (
    !libraries.some((name) => name.startsWith('/usr/lib/libSystem')) ||
    !libraries.every(system)
  ) {
    throw new Error(`${executable} links libraries outside macOS: ${libraries.join(', ')}`)
  }
  const requiresNewerMacOS = minimums.some((value) => compareVersions(value, MACOS_MINIMUM) > 0)
  if (!minimums.length || requiresNewerMacOS) {
    throw new Error(
      `${executable} must support macOS ${MACOS_MINIMUM}; found ` +
        `${minimums.join(', ') || 'no LC_BUILD_VERSION'}`
    )
  }
}

async function verifyMachO(executable) {
  const lines = []
  await scanLines('otool', ['-l', executable], (line) => lines.push(line))
  verifyMachOLoadCommands(executable, lines)
  run('codesign', ['--verify', '--strict', executable])
}

/** Fails a build whose executable would need anything beyond the operating system to start. */
export async function verifyNativeExecutable(executable, platform) {
  if (platform.startsWith('win32-')) await verifyPe(executable)
  else if (platform.startsWith('linux-')) await verifyElf(executable)
  else if (platform.startsWith('darwin-')) await verifyMachO(executable)
  else throw new Error(`No runtime dependency check for ${platform}`)
}
