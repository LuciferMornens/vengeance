// The SDK host against the installed engine (needs `npm run build` for out/main/provider-host.js):
// a host that dies in the middle of an operation fails that operation once, with the plain crash
// text, and the next operation starts a new host and succeeds. A host that only ran background
// operations exits soon; a Settings section call or prewarm keeps it for a visit.
//
//   node scripts/checks/sdk-host-recovery.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const hostBundle = join(root, 'out', 'main', 'provider-host.js')
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-sdk-host-'))
const agentDir = join(tempRoot, 'agent')
const previousOffline = process.env.PI_OFFLINE
process.env.PI_OFFLINE = '1'
let client

/** Node processes this check started that run the host bundle (it never touches anything else). */
function ownHostPids() {
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='node.exe'" | Where-Object { $_.CommandLine -like '*provider-host.js*' } | ForEach-Object { $_.ProcessId }`
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitForExit(pid, timeoutMs) {
  const started = Date.now()
  while (ownHostPids().includes(pid)) {
    if (Date.now() - started > timeoutMs) throw new Error(`the SDK host ${pid} is still running`)
    await sleep(250)
  }
  return Date.now() - started
}

async function waitForHost() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pids = ownHostPids()
    if (pids.length > 0) return pids
    await sleep(100)
  }
  throw new Error('the SDK host did not start')
}

try {
  // The client finds the host bundle next to itself, as in out/main.
  const clientBundle = join(tempRoot, 'client.cjs')
  await copyFile(hostBundle, join(tempRoot, 'provider-host.js'))
  await build({
    entryPoints: [join(root, 'src', 'main', 'engine', 'sdk-host', 'client.ts')],
    outfile: clientBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    logLevel: 'silent'
  })
  client = createRequire(import.meta.url)(clientBundle)

  const first = await client.sdkHostCall(null, 'keybindings', { config: null })
  assert.ok(first.actions.length > 0, 'the engine lists its key actions')
  console.log('PASS a first operation starts the host and answers')

  const [pid] = await waitForHost()
  const pending = client.sdkHostCall(null, 'catalog', {
    agentDir,
    extraModels: [],
    extraProviderIds: []
  })
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await assert.rejects(pending, { message: 'The Engine stopped unexpectedly.' })
  console.log('PASS a host that dies mid-operation fails it once, with the plain crash text')

  const catalog = await client.sdkHostCall(null, 'catalog', {
    agentDir,
    extraModels: [],
    extraProviderIds: []
  })
  assert.ok(catalog.providers.length > 0, 'a new host answers with the built-in providers')
  const [catalogPid] = await waitForHost()
  assert.notEqual(catalogPid, pid)
  console.log('PASS the next operation starts a new host and succeeds')

  await sleep(6_000)
  assert.ok(ownHostPids().includes(catalogPid), 'a background call keeps the host for a follow-up')
  const exitedAfter = await waitForExit(catalogPid, 12_000)
  console.log(`PASS a host that only ran background calls exits soon (${6 + Math.round(exitedAfter / 1000)} s)`)

  client.prewarmSdkHost(null)
  const [settingsPid] = await waitForHost()
  await client.sdkHostCall(null, 'keybindings', { config: null })
  await sleep(20_000)
  assert.ok(ownHostPids().includes(settingsPid), 'Settings keeps the host for a visit')
  console.log('PASS a prewarm and a Settings section call keep the host past the background idle time')
} finally {
  client?.disposeSdkHost()
  if (previousOffline === undefined) delete process.env.PI_OFFLINE
  else process.env.PI_OFFLINE = previousOffline
  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(relative(resolvedSystemTemp, resolvedTempRoot).split(sep)[0] !== '..')
  await rm(resolvedTempRoot, { recursive: true, force: true, maxRetries: 5 })
}
