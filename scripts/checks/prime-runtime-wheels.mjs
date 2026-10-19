import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildPrimeWheels,
  inspectCryptoWheel,
  repackCryptoWheel,
  validateWheelBuildInputs
} from '../engines/build-prime-wheels.mjs'
import { engineLock, removeStaged, run, sha256, staging } from '../engines/common.mjs'

const MAKE_WHEEL = String.raw`
import base64
import csv
import hashlib
import io
import stat
import sys
import zipfile
from pathlib import Path

directory, version, variant = sys.argv[1:]
metadata = "cryptography-" + version + ".dist-info/"
platform = "macosx_14_0_x86_64" if variant == "minimum" else "macosx_13_0_x86_64"
tag = "cp39-abi3-" + platform
wheel = Path(directory) / ("cryptography-" + version + "-" + tag + ".whl")
files = {
    metadata + "METADATA": ("Metadata-Version: 2.4\nName: cryptography\nVersion: "
                            + version + "\n").encode(),
    metadata + "WHEEL": ("Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: "
                         + tag + "\n").encode(),
    "cryptography/hazmat/bindings/_rust.abi3.so": b"\xcf\xfa\xed\xfe" + b"test binding",
}
for name in ["LICENSE", "LICENSE.APACHE", "LICENSE.BSD"]:
    files[metadata + "licenses/" + name] = b"Test fixture license"
if variant == "traversal":
    files["../outside.txt"] = b"must not extract"
if variant == "normalized":
    files["cryptography//alias.py"] = b"must not extract"
record = metadata + "RECORD"
output = io.StringIO(newline="")
writer = csv.writer(output, lineterminator="\n")
for name, data in files.items():
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    writer.writerow([name, "sha256=" + digest, len(data)])
writer.writerow([record, "", ""])
files[record] = output.getvalue().encode()
if variant == "digest":
    files["cryptography/hazmat/bindings/_rust.abi3.so"] += b"altered"
if variant == "coverage":
    files["unrecorded.txt"] = b"must be covered by RECORD"
with zipfile.ZipFile(wheel, "w") as archive:
    for name, data in files.items():
        entry = zipfile.ZipInfo(name)
        entry.create_system = 3
        mode = stat.S_IFLNK if variant == "symlink" and name.endswith(".so") else stat.S_IFREG
        entry.external_attr = (mode | 0o644) << 16
        archive.writestr(entry, data)
    if variant == "duplicate":
        archive.writestr(record, files[record])
print(wheel)
`

const inputs = engineLock.prime.runtimeWheels['darwin-x64']
validateWheelBuildInputs(inputs)
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
await mkdir(staging, { recursive: true })
const directory = await mkdtemp(join(staging, 'wheel-check-'))

try {
  const makeWheel = async (variant) => {
    const destination = join(directory, variant)
    await mkdir(destination)
    return run(
      python,
      ['-I', '-c', MAKE_WHEEL, destination, inputs.cryptography.version, variant],
      {
        stdio: 'pipe'
      }
    )
  }
  const wheel = await makeWheel('valid')
  const unpacked = join(directory, 'unpacked')
  const inspected = inspectCryptoWheel(python, wheel, unpacked, inputs.cryptography.version)
  assert.deepEqual(inspected.tags, ['cp39-abi3-macosx_13_0_x86_64'])
  assert.deepEqual(inspected.nativeFiles, ['cryptography/hazmat/bindings/_rust.abi3.so'])
  const before = sha256(await readFile(wheel))
  const binding = join(unpacked, ...inspected.nativeFiles[0].split('/'))
  await writeFile(binding, Buffer.concat([await readFile(binding), Buffer.from('signed fixture')]))
  repackCryptoWheel(python, wheel, unpacked, inputs.cryptography.version)
  assert.notEqual(sha256(await readFile(wheel)), before)
  const verified = join(directory, 'verified')
  inspectCryptoWheel(python, wheel, verified, inputs.cryptography.version)
  assert.deepEqual(
    await readFile(join(verified, ...inspected.nativeFiles[0].split('/'))),
    await readFile(binding)
  )
  const firstRepack = sha256(await readFile(wheel))
  repackCryptoWheel(python, wheel, verified, inputs.cryptography.version)
  assert.equal(sha256(await readFile(wheel)), firstRepack)

  for (const [variant, expectedError] of [
    ['digest', /RECORD digest\/size mismatch/],
    ['coverage', /RECORD does not cover every wheel member/],
    ['duplicate', /duplicate ZIP entries/],
    ['traversal', /Unsafe wheel path/],
    ['normalized', /Unsafe wheel path/],
    ['symlink', /Unsafe wheel path/],
    ['minimum', /Incompatible Intel macOS\/Python 3.11 tag/]
  ]) {
    const malformed = await makeWheel(variant)
    assert.throws(
      () =>
        inspectCryptoWheel(
          python,
          malformed,
          join(directory, `${variant}-unpacked`),
          inputs.cryptography.version
        ),
      expectedError
    )
  }
  assert.throws(
    () => inspectCryptoWheel(python, wheel, unpacked, '0.0.0'),
    /distribution\/version differs from the source pin/
  )
  for (const invalid of [
    { ...inputs, deploymentTarget: '14.0' },
    { ...inputs, python: { ...inputs.python, version: '3.12.0' } },
    { ...inputs, cryptography: { ...inputs.cryptography, sha256: 'missing' } },
    { ...inputs, buildDependencies: [...inputs.buildDependencies, inputs.buildDependencies[0]] }
  ]) {
    assert.throws(() => validateWheelBuildInputs(invalid))
  }
  await buildPrimeWheels(join(directory, 'other-platform'), {}, { key: 'linux-x64' })
  if (`${process.platform}-${process.arch}` !== 'darwin-x64') {
    await assert.rejects(
      buildPrimeWheels(join(directory, 'cross-build'), engineLock.prime, { key: 'darwin-x64' }),
      /native Intel macOS host/
    )
  }
  console.log(
    '✓ Intel wheel input pins, RECORD repair, reproducible ZIP and corruption guards passed'
  )
} finally {
  await removeStaged(directory)
}
