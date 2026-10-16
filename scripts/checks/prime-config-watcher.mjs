import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tempRoot = await mkdtemp(join(tmpdir(), 'vengeance-prime-watcher-'))
const account = join(tempRoot, 'account')
const firstWorkspace = join(tempRoot, 'first-workspace')
const secondWorkspace = join(tempRoot, 'second-workspace')
const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR
const SETTLE_MS = 700
const QUIET_MS = 2_400
const EXPECTED_WATCHERS = 3
const events = []
let workspaces = [firstWorkspace]
let watcher
process.env.PRIME_AGENT_CODING_AGENT_DIR = account

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data))
}

function takeEvents() {
  return events.splice(0).map(({ area, project }) => ({ area, cwd: project?.cwd ?? null }))
}

async function expectEvents(expected) {
  await delay(SETTLE_MS)
  assert.deepEqual(takeEvents(), expected)
}

try {
  await mkdir(firstWorkspace)
  const bundlePath = join(tempRoot, 'watcher.mjs')
  await build({
    entryPoints: [join(root, 'src', 'main', 'features', 'settings', 'prime-config-watcher.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [
      {
        name: 'watcher-observers',
        setup(bundler) {
          bundler.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'fixture'
          }))
          bundler.onLoad({ filter: /^electron$/, namespace: 'fixture' }, () => ({
            contents: 'export const app = {}',
            loader: 'js'
          }))
          bundler.onResolve({ filter: /^node:fs$/ }, (args) => {
            if (args.namespace === 'fixture') return undefined
            return { path: 'fs', namespace: 'fixture' }
          })
          bundler.onLoad({ filter: /^fs$/, namespace: 'fixture' }, () => ({
            contents: `
              import { watch as nativeWatch } from 'node:fs'
              export * from 'node:fs'
              const handles = new Set()
              globalThis.__primeWatcherHandles = handles
              export function watch(...args) {
                const watcher = nativeWatch(...args)
                handles.add(watcher)
                watcher.once('close', () => handles.delete(watcher))
                return watcher
              }
            `,
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })
  const { PrimeConfigWatcher } = await import(pathToFileURL(bundlePath).href)
  watcher = new PrimeConfigWatcher(
    (event) => events.push(event),
    () => workspaces
  )
  watcher.start()
  watcher.start()
  await expectEvents([])
  assert.equal(globalThis.__primeWatcherHandles.size, EXPECTED_WATCHERS)

  const authPath = join(account, 'auth.json')
  await writeJson(authPath, {})
  await expectEvents([])
  const credential = {
    type: 'oauth',
    access: 'fixture-access',
    refresh: 'fixture-refresh',
    expires: 1
  }
  await writeJson(authPath, { 'fixture-provider': credential })
  await expectEvents([{ area: 'auth', cwd: null }])
  await writeJson(authPath, {
    'fixture-provider': { ...credential, access: 'refreshed', refresh: 'rotated', expires: 2 }
  })
  await expectEvents([])
  await writeFile(authPath, '{')
  await expectEvents([])
  await writeJson(authPath, { 'fixture-provider': credential })
  await expectEvents([])
  await writeJson(authPath, { 'fixture-provider': { type: 'api_key', key: 'fixture-key' } })
  await expectEvents([{ area: 'auth', cwd: null }])
  await rm(authPath)
  await expectEvents([{ area: 'auth', cwd: null }])
  console.log(
    'PASS auth refresh, malformed writes and empty creation stay quiet; add/type/remove notify'
  )

  const settingsPath = join(account, 'settings.json')
  await writeJson(settingsPath, { retry: { enabled: true } })
  await expectEvents([{ area: 'settings', cwd: null }])
  await writeJson(settingsPath, { retry: { enabled: false } })
  watcher.noteSelfChange('settings')
  await expectEvents([])
  await writeJson(settingsPath, { retry: { enabled: true } })
  watcher.noteSelfChange('settings')
  await writeJson(settingsPath, { retry: { enabled: false } })
  await expectEvents([{ area: 'settings', cwd: null }])
  await writeJson(authPath, { 'fixture-provider': credential })
  watcher.noteSelfChange('auth')
  await expectEvents([])
  await writeJson(authPath, {})
  await expectEvents([{ area: 'auth', cwd: null }])
  console.log(
    'PASS own settings/auth writes are acknowledged; immediate outside edits still notify'
  )

  const firstProjectSettings = join(firstWorkspace, '.prime', 'agent', 'settings.json')
  await writeJson(firstProjectSettings, { defaultModel: 'fixture-model' })
  await expectEvents([{ area: 'settings', cwd: firstWorkspace }])
  await writeJson(firstProjectSettings, { defaultModel: 'outside-model' })
  watcher.noteSelfChange('settings')
  await expectEvents([{ area: 'settings', cwd: firstWorkspace }])
  await writeFile(join(firstWorkspace, 'AGENTS.md'), 'Fixture instructions')
  await expectEvents([{ area: 'instructions', cwd: firstWorkspace }])
  await writeJson(firstProjectSettings, { defaultModel: 'own-project-model' })
  watcher.noteSelfChange('settings', firstWorkspace)
  await expectEvents([])
  const promptDirectory = join(account, 'prompts')
  await mkdir(promptDirectory)
  await writeFile(join(promptDirectory, 'fixture.md'), 'Fixture prompt')
  await expectEvents([{ area: 'resources', cwd: null }])
  console.log(
    'PASS newly created project configuration and workspace instructions notify with scope'
  )

  await mkdir(secondWorkspace)
  workspaces = [secondWorkspace]
  watcher.sync()
  await delay(QUIET_MS)
  assert.deepEqual(takeEvents(), [])
  assert.equal(globalThis.__primeWatcherHandles.size, EXPECTED_WATCHERS)
  await writeJson(firstProjectSettings, { defaultModel: 'closed-workspace' })
  await expectEvents([])
  const secondProjectSettings = join(secondWorkspace, '.prime', 'agent', 'settings.json')
  await writeJson(secondProjectSettings, { retry: {} })
  await expectEvents([{ area: 'settings', cwd: secondWorkspace }])
  console.log('PASS workspace switches release old watchers and keep handles bounded')

  await rm(join(secondWorkspace, '.prime'), { recursive: true })
  await expectEvents([{ area: 'settings', cwd: secondWorkspace }])
  assert.equal(globalThis.__primeWatcherHandles.size, EXPECTED_WATCHERS)
  await writeJson(secondProjectSettings, { retry: { enabled: true } })
  await expectEvents([{ area: 'settings', cwd: secondWorkspace }])
  console.log('PASS a removed project configuration folder is watched again once recreated')

  // Sessions ended without engine:dispose (renderer crash: disposeAll) leave the list with no sync() call.
  workspaces = []
  await writeJson(secondProjectSettings, { retry: { enabled: false } })
  await expectEvents([])
  assert.equal(globalThis.__primeWatcherHandles.size, 1)
  workspaces = [secondWorkspace]
  watcher.sync()
  await expectEvents([])
  console.log('PASS a workspace that left the list without sync() no longer notifies')

  await writeJson(settingsPath, { retry: { enabled: true } })
  watcher.stop()
  watcher.noteSelfChange('settings')
  await delay(QUIET_MS)
  assert.deepEqual(takeEvents(), [])
  assert.equal(globalThis.__primeWatcherHandles.size, 0)
  watcher.start()
  await expectEvents([])
  await writeJson(settingsPath, { retry: { enabled: false } })
  await expectEvents([{ area: 'settings', cwd: null }])
  watcher.stop()
  await delay(SETTLE_MS)
  assert.equal(globalThis.__primeWatcherHandles.size, 0)
  console.log('PASS stop cancels pending events and closes handles; explicit restart re-baselines')
} finally {
  watcher?.stop()
  if (previousAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR
  else process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir
  delete globalThis.__primeWatcherHandles
  const resolvedTempRoot = await realpath(tempRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  assert.ok(relative(resolvedSystemTemp, resolvedTempRoot).split(sep)[0] !== '..')
  await rm(resolvedTempRoot, { recursive: true, force: true })
}
