import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { download, removeStaged, run, sha256, staging, writeJson } from './common.mjs'
import { signAdHoc, verifyNativeExecutable } from './native.mjs'

const WHEEL_PLATFORM = 'darwin-x64'
const MACOS_MINIMUM = '13.0'
const BUILD_DEPENDENCIES = ['pip', 'maturin', 'cffi', 'setuptools', 'pycparser']
const LICENSE_NAME = /^(licen[cs]es?|copying|notice|copyright)([._-]|$)/i

// Python's standard library keeps wheel ZIP and CSV handling independent of build dependencies.
const WHEEL_ARCHIVE = String.raw`
import base64
import csv
import hashlib
import io
import json
import os
import stat
import sys
import zipfile
from email.parser import BytesParser
from pathlib import Path, PurePosixPath

MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf",
    b"\xbe\xba\xfe\xca", b"\xbf\xba\xfe\xca",
}
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def wheel_digest(data):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest())
    return "sha256=" + digest.rstrip(b"=").decode("ascii")


def inspect(archive, version):
    members = archive.infolist()
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise ValueError("Wheel contains duplicate ZIP entries")
    files = {}
    for member in members:
        name = member.filename
        parts = PurePosixPath(name).parts
        mode = member.external_attr >> 16
        if (not parts or name.startswith("/") or "\\" in name
                or ".." in parts or ":" in name or stat.S_ISLNK(mode)
                or PurePosixPath(name).as_posix() != name.rstrip("/")):
            raise ValueError("Unsafe wheel path: " + name)
        if not member.is_dir():
            files[name] = archive.read(member)
    records = [name for name in files if name.endswith(".dist-info/RECORD")]
    if len(records) != 1:
        raise ValueError("Wheel must contain exactly one RECORD")
    record = records[0]
    metadata_dir = record.rsplit("/", 1)[0]
    metadata = BytesParser().parsebytes(files[metadata_dir + "/METADATA"])
    if metadata["Name"] != "cryptography" or metadata["Version"] != version:
        raise ValueError("Wheel distribution/version differs from the source pin")
    wheel = BytesParser().parsebytes(files[metadata_dir + "/WHEEL"])
    tags = wheel.get_all("Tag", [])
    if not tags or wheel["Root-Is-Purelib"] != "false":
        raise ValueError("Expected a native wheel with compatibility tags")
    for tag in tags:
        interpreter, abi, platform = tag.split("-")
        parts = platform.split("_")
        if (interpreter not in {"cp39", "cp310", "cp311"} or abi != "abi3"
                or len(parts) != 5 or parts[0] != "macosx"
                or parts[3:] != ["x86", "64"]
                or (int(parts[1]), int(parts[2])) > (13, 0)):
            raise ValueError("Incompatible Intel macOS/Python 3.11 tag: " + tag)
    filename_tags = Path(archive.filename).name.removesuffix(".whl").split("-")
    if (len(filename_tags) != 5 or filename_tags[:2] != ["cryptography", version]
            or "-".join(filename_tags[2:]) not in tags):
        raise ValueError("Wheel filename differs from its distribution or platform tags")
    rows = list(csv.reader(io.StringIO(files[record].decode("utf-8"))))
    listed = set()
    for row in rows:
        if len(row) != 3:
            raise ValueError("Malformed RECORD row")
        name, digest, size = row
        if name in listed or name not in files:
            raise ValueError("Duplicate or missing RECORD member: " + name)
        listed.add(name)
        if name == record:
            if digest or size:
                raise ValueError("RECORD must not hash itself")
        elif digest != wheel_digest(files[name]) or size != str(len(files[name])):
            raise ValueError("RECORD digest/size mismatch: " + name)
    if listed != set(files):
        raise ValueError("RECORD does not cover every wheel member")
    required = {"LICENSE", "LICENSE.APACHE", "LICENSE.BSD"}
    licenses = {PurePosixPath(name).name for name in files if "/licenses/" in name}
    if not required.issubset(licenses):
        raise ValueError("Wheel is missing cryptography's license texts")
    native = sorted(name for name, data in files.items() if data[:4] in MACHO_MAGICS)
    if not native or not any(name.endswith("/_rust.abi3.so") for name in native):
        raise ValueError("Wheel is missing its native Rust binding")
    return files, record, native, tags


def unpack(wheel, directory, version):
    with zipfile.ZipFile(wheel) as archive:
        files, record, native, tags = inspect(archive, version)
    for name, data in files.items():
        destination = directory.joinpath(*PurePosixPath(name).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return {"nativeFiles": native, "tags": tags, "record": record}


def repack(wheel, directory, version):
    with zipfile.ZipFile(wheel) as archive:
        files, record, native, tags = inspect(archive, version)
    files = {name: directory.joinpath(*PurePosixPath(name).parts).read_bytes()
             for name in files}
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    for name in sorted(files):
        if name != record:
            writer.writerow([name, wheel_digest(files[name]), len(files[name])])
    writer.writerow([record, "", ""])
    files[record] = output.getvalue().encode("utf-8")
    temporary = wheel.with_suffix(".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            entry = zipfile.ZipInfo(name, date_time=ZIP_TIMESTAMP)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, files[name], compress_type=zipfile.ZIP_DEFLATED)
    os.replace(temporary, wheel)
    with zipfile.ZipFile(wheel) as archive:
        inspect(archive, version)
    return {"nativeFiles": native, "tags": tags}


mode, wheel_name, directory_name, version = sys.argv[1:]
wheel = Path(wheel_name)
directory = Path(directory_name)
if mode == "unpack":
    result = unpack(wheel, directory, version)
else:
    result = repack(wheel, directory, version)
print(json.dumps(result))
`

const WHEEL_SMOKE = String.raw`
import hashlib
import json
import platform
import sys
from pathlib import Path

import cryptography
from cryptography.hazmat.backends.openssl.backend import backend
from cryptography.hazmat.bindings import _rust
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

version, openssl_version = sys.argv[1:]
assert cryptography.__version__ == version
assert backend.openssl_version_text().startswith("OpenSSL " + openssl_version + " ")
assert platform.machine() == "x86_64"
assert sys.version_info[:2] == (3, 11)
assert Path(_rust.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
message = b"Vengeance runtime wheel verification"
private_key = ed25519.Ed25519PrivateKey.generate()
private_key.public_key().verify(private_key.sign(message), message)
cipher = AESGCM(AESGCM.generate_key(bit_length=128))
nonce = b"\0" * 12
assert cipher.decrypt(nonce, cipher.encrypt(nonce, message, None), None) == message
digest = hashes.Hash(hashes.SHA256())
digest.update(message)
assert digest.finalize() == hashlib.sha256(message).digest()
print(json.dumps({"opensslVersion": backend.openssl_version_text(),
                  "pythonVersion": platform.python_version()}))
`

export function validateWheelBuildInputs(inputs) {
  if (!inputs || inputs.deploymentTarget !== MACOS_MINIMUM) {
    throw new Error(`Intel runtime wheels require deploymentTarget ${MACOS_MINIMUM}`)
  }
  if (!/^3\.11\.\d+$/.test(inputs.python?.version ?? '')) {
    throw new Error('Intel runtime wheels require an exact Python 3.11 patch release')
  }
  const dependencies = inputs.buildDependencies
  if (
    !Array.isArray(dependencies) ||
    dependencies.length !== BUILD_DEPENDENCIES.length ||
    !BUILD_DEPENDENCIES.every(
      (name) => dependencies.filter((item) => item.name === name).length === 1
    )
  ) {
    throw new Error(`Intel wheel build dependencies must pin ${BUILD_DEPENDENCIES.join(', ')}`)
  }
  for (const artifact of [inputs.python, inputs.cryptography, inputs.openssl, ...dependencies]) {
    if (
      !/^\d+(?:\.\d+)+$/.test(artifact?.version ?? '') ||
      !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '') ||
      !artifact?.url?.startsWith('https://')
    ) {
      throw new Error('Intel wheel inputs need an exact version, HTTPS URL and SHA-256')
    }
    const filename = decodeURIComponent(new URL(artifact.url).pathname.split('/').at(-1))
    if (!filename || basename(filename) !== filename || /[\\\r\n]/.test(filename)) {
      throw new Error(`Unsafe Intel wheel build input filename: ${artifact.url}`)
    }
  }
}

async function downloadInput(artifact) {
  const filename = decodeURIComponent(new URL(artifact.url).pathname.split('/').at(-1))
  const destination = join(staging, 'wheel-downloads', artifact.sha256, filename)
  await download(artifact.url, destination, artifact.sha256)
  return destination
}

function wheelBuildEnvironment(toolchain, rustVersion, directory) {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (
      /^(PYTHON|PIP_|UV_|OPENSSL_|CARGO_TARGET_|CARGO_BUILD_|CARGO_PROFILE_)/.test(name) ||
      name === 'CARGO_ENCODED_RUSTFLAGS' ||
      /^(RUSTFLAGS|RUSTC(?:_(?:WORKSPACE_)?WRAPPER)?|RUSTDOC)$/.test(name) ||
      /^(SDKROOT|ARCHFLAGS|CC|CXX|CPP|AR|RANLIB|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS)$/.test(name)
    ) {
      delete environment[name]
    }
  }
  return {
    ...environment,
    PATH: [
      join(directory, 'environment', 'bin'),
      dirname(toolchain.cargo),
      '/usr/bin',
      '/bin'
    ].join(delimiter),
    CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), '.cargo'),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
    RUSTUP_TOOLCHAIN: `${rustVersion}-${toolchain.host}`,
    CARGO_TARGET_DIR: join(directory, 'target'),
    MACOSX_DEPLOYMENT_TARGET: MACOS_MINIMUM,
    ARCHFLAGS: '-arch x86_64',
    _PYTHON_HOST_PLATFORM: 'macosx-13.0-x86_64',
    CC: '/usr/bin/clang',
    CXX: '/usr/bin/clang++',
    AR: '/usr/bin/ar',
    RANLIB: '/usr/bin/ranlib',
    CFLAGS: '-fPIC',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    OPENSSL_DIR: join(directory, 'openssl'),
    OPENSSL_STATIC: '1',
    OPENSSL_NO_VENDOR: '1',
    PKG_CONFIG: '/usr/bin/false',
    // ZIP cannot represent timestamps before 1 January 1980.
    SOURCE_DATE_EPOCH: '315532800'
  }
}

async function preparePython(inputs, directory, environment) {
  const archive = await downloadInput(inputs.python)
  const pythonDirectory = join(directory, 'interpreter')
  await mkdir(pythonDirectory, { recursive: true })
  run('/usr/bin/tar', ['-xzf', archive, '-C', pythonDirectory])
  const interpreter = join(pythonDirectory, 'python', 'bin', 'python3.11')
  const version = run(
    interpreter,
    ['-I', '-c', 'import platform\nprint(platform.python_version())'],
    {
      env: environment,
      stdio: 'pipe'
    }
  )
  if (version !== inputs.python.version) throw new Error(`Python pin mismatch: ${version}`)
  run(interpreter, ['-I', '-m', 'venv', join(directory, 'environment')], {
    env: environment
  })
  const python = join(directory, 'environment', 'bin', 'python')
  const requirements = []
  for (const dependency of inputs.buildDependencies) {
    const wheel = await downloadInput(dependency)
    requirements.push(`${pathToFileURL(wheel).href} --hash=sha256:${dependency.sha256}`)
  }
  const requirementsPath = join(directory, 'build-requirements.txt')
  await writeFile(requirementsPath, requirements.join('\n') + '\n')
  run(
    python,
    [
      '-I',
      '-m',
      'pip',
      '--isolated',
      'install',
      '--no-index',
      '--no-deps',
      '--no-compile',
      '--require-hashes',
      '--only-binary=:all:',
      '-r',
      requirementsPath
    ],
    { env: environment }
  )
  const installed = JSON.parse(
    run(
      python,
      [
        '-I',
        '-c',
        'import importlib.metadata, json, sys\n' +
          'print(json.dumps({name: importlib.metadata.version(name) for name in sys.argv[1:]}))',
        ...BUILD_DEPENDENCIES
      ],
      { env: environment, stdio: 'pipe' }
    )
  )
  for (const dependency of inputs.buildDependencies) {
    if (installed[dependency.name] !== dependency.version) {
      throw new Error(`Installed build dependency differs from its pin: ${dependency.name}`)
    }
  }
  return python
}

async function extractSource(artifact, directory) {
  const archive = await downloadInput(artifact)
  await mkdir(directory, { recursive: true })
  run('/usr/bin/tar', ['-xzf', archive, '-C', directory, '--strip-components', '1'])
}

async function buildOpenSsl(openssl, directory, environment, buildJobs) {
  const source = join(directory, 'openssl-source')
  await extractSource(openssl, source)
  run(
    '/usr/bin/perl',
    [
      'Configure',
      'darwin64-x86_64-cc',
      'no-shared',
      'no-module',
      'no-tests',
      `--prefix=${environment.OPENSSL_DIR}`,
      '--libdir=lib'
    ],
    { cwd: source, env: environment }
  )
  run('/usr/bin/make', [`-j${buildJobs}`], { cwd: source, env: environment })
  run('/usr/bin/make', ['install_sw'], { cwd: source, env: environment })
  for (const library of ['libcrypto.a', 'libssl.a']) {
    await stat(join(environment.OPENSSL_DIR, 'lib', library))
  }
  return source
}

async function copyLicenseTexts(source, destination) {
  const files = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!LICENSE_NAME.test(entry.name)) continue
    if (entry.isFile()) {
      await mkdir(destination, { recursive: true })
      await copyFile(join(source, entry.name), join(destination, entry.name))
      files.push(entry.name)
    } else if (entry.isDirectory()) {
      for (const nested of await readdir(join(source, entry.name), {
        recursive: true,
        withFileTypes: true
      })) {
        if (!nested.isFile()) continue
        const path = join(nested.parentPath, nested.name)
        const name = relative(source, path)
        await mkdir(dirname(join(destination, name)), { recursive: true })
        await copyFile(path, join(destination, name))
        files.push(name)
      }
    }
  }
  return files
}

export async function writeWheelLicenses(
  source,
  opensslSource,
  destination,
  toolchain,
  environment
) {
  await copyLicenseTexts(source, join(destination, 'cryptography'))
  const opensslLicenses = await copyLicenseTexts(opensslSource, join(destination, 'OpenSSL'))
  if (!opensslLicenses.length) throw new Error('OpenSSL source contains no license texts')
  const metadata = JSON.parse(
    run(
      toolchain.cargo,
      ['metadata', '--locked', '--format-version', '1', '--filter-platform', toolchain.host],
      {
        cwd: source,
        env: environment,
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 16 * 1024 * 1024
      }
    )
  )
  const packages = []
  for (const dependency of metadata.packages) {
    if (!dependency.source) continue
    const directory = join(destination, 'Rust', `${dependency.name}-${dependency.version}`)
    const files = await copyLicenseTexts(dirname(dependency.manifest_path), directory)
    if (dependency.license_file) {
      const name = basename(dependency.license_file)
      await mkdir(directory, { recursive: true })
      await copyFile(
        resolve(dirname(dependency.manifest_path), dependency.license_file),
        join(directory, name)
      )
      if (!files.includes(name)) files.push(name)
    }
    if (!files.length)
      throw new Error(`Missing license texts for Rust dependency ${dependency.name}`)
    packages.push({
      name: dependency.name,
      version: dependency.version,
      license: dependency.license,
      source: dependency.source,
      files: files.sort()
    })
  }
  await writeJson(join(destination, 'Rust', 'packages.json'), packages)
}

function wheelArchive(python, mode, wheel, directory, version, environment) {
  const result = spawnSync(python, ['-I', '-c', WHEEL_ARCHIVE, mode, wheel, directory, version], {
    env: environment,
    windowsHide: true,
    encoding: 'utf8',
    stdio: 'pipe'
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `${python} exited ${result.status}`)
  return JSON.parse(result.stdout)
}

export function inspectCryptoWheel(python, wheel, directory, version, environment) {
  return wheelArchive(python, 'unpack', wheel, directory, version, environment)
}

export function repackCryptoWheel(python, wheel, directory, version, environment) {
  return wheelArchive(python, 'repack', wheel, directory, version, environment)
}

async function signWheel(python, wheel, directory, version, environment) {
  const inspected = inspectCryptoWheel(python, wheel, directory, version, environment)
  const nativeFiles = []
  for (const path of inspected.nativeFiles) {
    const executable = join(directory, ...path.split('/'))
    const architectures = run('/usr/bin/lipo', ['-archs', executable], { stdio: 'pipe' }).split(
      /\s+/
    )
    if (architectures.length !== 1 || architectures[0] !== 'x86_64') {
      throw new Error(
        `Intel wheel has unexpected Mach-O architectures: ${architectures.join(', ')}`
      )
    }
    signAdHoc(executable)
    await verifyNativeExecutable(executable, WHEEL_PLATFORM)
    nativeFiles.push({ path, sha256: sha256(await readFile(executable)), architectures })
  }
  repackCryptoWheel(python, wheel, directory, version, environment)
  // Verify the ZIP bytes after signing; codesign changes must be covered by the wheel's RECORD.
  inspectCryptoWheel(python, wheel, join(directory, 'verified'), version, environment)
  return { nativeFiles, tags: inspected.tags }
}

export async function buildPrimeWheels(output, engine, platform, toolchain, buildJobs) {
  if (platform.key !== WHEEL_PLATFORM) return
  if (`${process.platform}-${process.arch}` !== WHEEL_PLATFORM) {
    throw new Error('Intel macOS runtime wheels must build on a native Intel macOS host')
  }
  const inputs = engine.runtimeWheels?.[platform.key]
  validateWheelBuildInputs(inputs)
  const directory = join(staging, 'prime-wheels', platform.key)
  await removeStaged(directory)
  await mkdir(directory, { recursive: true })
  const environment = wheelBuildEnvironment(toolchain, engine.rustVersion, directory)
  const python = await preparePython(inputs, directory, environment)
  const opensslSource = await buildOpenSsl(inputs.openssl, directory, environment, buildJobs)
  const source = join(directory, 'cryptography-source')
  await extractSource(inputs.cryptography, source)
  const rawWheels = join(directory, 'raw-wheels')
  run(
    python,
    [
      '-I',
      '-m',
      'maturin',
      'build',
      '--release',
      '--locked',
      '--target',
      platform.rustTarget,
      '--interpreter',
      python,
      '--features',
      'pyo3/abi3-py39',
      '--out',
      rawWheels
    ],
    { cwd: source, env: { ...environment, CARGO_BUILD_JOBS: String(buildJobs) } }
  )
  const wheels = (await readdir(rawWheels)).filter((name) => name.endsWith('.whl'))
  if (wheels.length !== 1)
    throw new Error(`Expected one cryptography wheel; found ${wheels.length}`)
  const wheel = join(rawWheels, wheels[0])
  const verified = await signWheel(
    python,
    wheel,
    join(directory, 'unpacked'),
    inputs.cryptography.version,
    environment
  )
  run(
    python,
    ['-I', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile', wheel],
    { cwd: directory, env: environment }
  )
  const smoke = JSON.parse(
    run(python, ['-I', '-c', WHEEL_SMOKE, inputs.cryptography.version, inputs.openssl.version], {
      cwd: directory,
      env: environment,
      stdio: 'pipe'
    })
  )
  const destination = join(output, 'prime-agent-runtime', 'wheels')
  await mkdir(destination, { recursive: true })
  await copyFile(wheel, join(destination, wheels[0]))
  const wheelIdentity = { file: wheels[0], sha256: sha256(await readFile(wheel)) }
  await writeWheelLicenses(
    source,
    opensslSource,
    join(destination, 'licenses'),
    toolchain,
    environment
  )
  await writeJson(join(destination, 'build.json'), {
    schemaVersion: 1,
    platform: platform.key,
    deploymentTarget: inputs.deploymentTarget,
    inputs,
    rust: { version: toolchain.version, host: toolchain.host },
    compiler: run('/usr/bin/clang', ['--version'], { stdio: 'pipe' }).split('\n')[0],
    sdk: run('/usr/bin/xcrun', ['--show-sdk-version'], { stdio: 'pipe' }),
    cargoLockSha256: sha256(await readFile(join(source, 'Cargo.lock'))),
    wheel: wheelIdentity,
    ...verified,
    ...smoke
  })
  await writeJson(join(destination, 'manifest.json'), {
    schemaVersion: 1,
    platform: platform.key,
    wheels: [
      { distribution: 'cryptography', version: inputs.cryptography.version, ...wheelIdentity }
    ]
  })
  console.log(
    `prime: built and verified Intel macOS cryptography ${inputs.cryptography.version} wheel`
  )
}
