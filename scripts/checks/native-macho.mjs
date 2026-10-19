import assert from 'node:assert/strict'
import { verifyMachOLoadCommands } from '../engines/native.mjs'

const SYSTEM_LIBRARY = '/usr/lib/libSystem.B.dylib'
const SHARED_IDENTITY = '@rpath/cryptography.hazmat.bindings._rust.abi3.so'
const EXECUTABLE_COMMANDS = `
prime-agent:
Load command 0
      cmd LC_SEGMENT_64
  cmdsize 152
  segname __PAGEZERO
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libSystem.B.dylib (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 1351.0.0
compatibility version 1.0.0
Load command 2
       cmd LC_BUILD_VERSION
   cmdsize 32
  platform 1
     minos 13.0
       sdk 15.5
    ntools 1
Load command 3
          cmd LC_LOAD_DYLINKER
      cmdsize 32
         name /usr/lib/dyld (offset 12)
Load command 4
      cmd LC_CODE_SIGNATURE
  cmdsize 16
  dataoff 10000
 datasize 1000
`
const SHARED_COMMANDS = `
_rust.abi3.so:
Load command 0
          cmd LC_ID_DYLIB
      cmdsize 80
         name @rpath/cryptography.hazmat.bindings._rust.abi3.so (offset 24)
   time stamp 0 Thu Jan  1 00:00:00 1970
      current version 0.0.0
compatibility version 0.0.0
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libiconv.2.dylib (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 7.0.0
compatibility version 7.0.0
Load command 2
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /usr/lib/libSystem.B.dylib (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 1351.0.0
compatibility version 1.0.0
Load command 3
       cmd LC_BUILD_VERSION
   cmdsize 32
  platform 1
     minos 13.0
       sdk 15.5
    ntools 1
`

function verify(output) {
  verifyMachOLoadCommands('Mach-O fixture', output.split(/\r?\n/))
}

verify(EXECUTABLE_COMMANDS)
verify(SHARED_COMMANDS)
verify(SHARED_COMMANDS.replace(SHARED_IDENTITY, '/tmp/build-local/image.dylib'))

for (const command of [
  'LC_LOAD_DYLIB',
  'LC_LOAD_WEAK_DYLIB',
  'LC_REEXPORT_DYLIB',
  'LC_LOAD_UPWARD_DYLIB',
  'LC_LAZY_LOAD_DYLIB',
  'LC_PREBOUND_DYLIB',
  'LC_LOADFVMLIB'
]) {
  for (const dependency of [
    SHARED_IDENTITY,
    '@rpath/libssl.4.dylib',
    '@loader_path/libcrypto.4.dylib',
    '@executable_path/libssl.4.dylib',
    '/opt/homebrew/opt/openssl/lib/libcrypto.4.dylib',
    '/Users/runner/build directory/libssl.4.dylib'
  ]) {
    const external =
      SHARED_COMMANDS +
      `
Load command 4
          cmd ${command}
      cmdsize 96
         name ${dependency} (offset 24)
`
    assert.throws(() => verify(external), /links libraries outside macOS/)
  }
}

assert.throws(
  () =>
    verify(
      EXECUTABLE_COMMANDS.replace(`name ${SYSTEM_LIBRARY} (offset 24)`, 'name ?(bad offset 24)')
    ),
  /no valid name in LC_LOAD_DYLIB/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace(`name ${SYSTEM_LIBRARY} (offset 24)`, '')),
  /no valid name in LC_LOAD_DYLIB/
)
assert.throws(
  () => verify(SHARED_COMMANDS.replace('cmd LC_ID_DYLIB', 'cmd LC_LOAD_DYLIB')),
  /links libraries outside macOS/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('cmd LC_LOAD_DYLIB', 'cmd LC_ID_DYLIB')),
  /links libraries outside macOS/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('minos 13.0', 'minos 14.0')),
  /must support macOS 13.0/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('minos 13.0', 'minos invalid')),
  /no valid minos/
)
assert.throws(() => verify(EXECUTABLE_COMMANDS.replace('minos 13.0', '')), /no valid minos/)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('cmd LC_BUILD_VERSION', 'cmd LC_SOURCE_VERSION')),
  /no LC_BUILD_VERSION/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS + EXECUTABLE_COMMANDS.replace('minos 13.0', 'minos 14.0')),
  /must support macOS 13.0/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('cmd LC_LOAD_DYLIB', 'cmd 0xffffffff')),
  /unrecognized Mach-O load command/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('/usr/lib/dyld', '@rpath/dyld')),
  /dynamic linker outside macOS/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('cmd LC_LOAD_DYLIB', 'cmd LC_LOAD_FUTURE_DYLIB')),
  /unsupported dependency command/
)
assert.throws(
  () => verify(SHARED_COMMANDS.replace('cmd LC_LOAD_DYLIB', 'cmd LC_LOAD_DYLIB\ncmd LC_ID_DYLIB')),
  /duplicate cmd fields/
)
assert.throws(
  () => verify(EXECUTABLE_COMMANDS.replace('minos 13.0', 'minos 13.0\nminos 12.0')),
  /duplicate minos fields/
)
assert.throws(
  () =>
    verify(
      EXECUTABLE_COMMANDS.replace(
        `name ${SYSTEM_LIBRARY} (offset 24)`,
        `name ${SYSTEM_LIBRARY} (offset 24)\nname /opt/local/libssl.dylib (offset 24)`
      )
    ),
  /duplicate name fields/
)

console.log('✓ Mach-O self identity, dependency load commands and macOS minimum checks passed')
