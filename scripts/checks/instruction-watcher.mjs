import assert from 'node:assert/strict'
import fileSystem from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { tempRoot } from '../qa/lib/tmp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixture = await tempRoot('vengeance-instruction-watcher-')
const temporaryRoot = fixture.dir
const account = join(temporaryRoot, 'account')
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const BLOCKED_MAIN_MS = 1800
const WATCHER_SETTLE_MS = 700
const QUICK_WATCHER_SETTLE_MS = 450
const OWNED_WRITE_SETTLE_MS = 150
const SAVED_TEXT = 'Saved inside Vengeance\n'
const TRASH_FAILURE = 'Simulated recycle bin failure'
const events = []
const trashRequests = []
let watcher

function delayMainThread() {
  const deadline = Date.now() + BLOCKED_MAIN_MS
  while (Date.now() < deadline) {
    // A delayed filesystem callback must not turn an owned write into an outside edit.
  }
}

async function expectEvents(expected) {
  await delay(WATCHER_SETTLE_MS)
  assert.deepEqual(events.splice(0), expected)
}

// Simulate a Windows sharing lock for one replacement while allowing overlapping writes to finish.
async function withBlockedReplacement(path, operation) {
  const nativeRename = fileSystem.renameSync
  let blockedSource
  fileSystem.renameSync = (source, destination) => {
    if (destination === path && (blockedSource === undefined || source === blockedSource)) {
      blockedSource = source
      throw Object.assign(new Error('Simulated Windows sharing violation'), { code: 'EPERM' })
    }
    return nativeRename(source, destination)
  }
  syncBuiltinESMExports()
  try {
    await operation()
    assert.notEqual(blockedSource, undefined, 'The replacement must reach the rename boundary')
  } finally {
    fileSystem.renameSync = nativeRename
    syncBuiltinESMExports()
  }
}

try {
  await mkdir(account)
  process.env.PI_CODING_AGENT_DIR = account
  const bundlePath = join(temporaryRoot, 'watcher.mjs')
  await build({
    stdin: {
      contents: `
        export { ConfigWatcher } from './src/main/features/settings/config-watcher.ts'
        export { writeFileAtomic } from './src/main/features/settings/json-file.ts'
        export { writeInstructionFile } from './src/main/features/settings/instructions.ts'
        export { shell } from 'electron'
      `,
      resolveDir: root,
      loader: 'ts'
    },
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(root, 'src', 'shared') },
    plugins: [
      {
        name: 'isolated-instruction-watcher',
        setup(bundler) {
          const modules = {
            'app-state':
              'export const appState = { getPrefs: () => ({ activeWorkspace: null }), onPrefsChange: () => () => {} }',
            'pi-cli':
              'export const hasActiveRuns = () => false; export const hadRecentRun = () => false',
            electron: `
              export const app = {
                isPackaged: false, on() {},
                getPath() { return ${JSON.stringify(temporaryRoot)} }
              }
              export const shell = {}
            `,
            client:
              'export async function sdkHostCall() { throw new Error("No SDK calls in fixture") }',
            trust:
              'export async function trustPreflight() { throw new Error("No trust calls in fixture") }'
          }
          bundler.onResolve(
            { filter: /(?:app-state|pi-cli|sdk-host\/client|launch\/trust)$|^electron$/ },
            (args) => ({
              path: args.path.split(/[\\/]/).at(-1),
              namespace: 'fixture'
            })
          )
          bundler.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents: modules[path],
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })
  const { ConfigWatcher, writeFileAtomic, writeInstructionFile, shell } = await import(
    pathToFileURL(bundlePath).href
  )
  shell.trashItem = (path) => {
    const request = { path, ...Promise.withResolvers() }
    trashRequests.push(request)
    return request.promise
  }
  const instructionRef = { kind: 'SYSTEM.md', scope: 'global' }
  watcher = new ConfigWatcher(
    (area, cwd, fromRun) => events.push({ area, cwd, fromRun }),
    () => false
  )
  watcher.start()
  const instructionPath = join(account, 'SYSTEM.md')
  watcher.noteSelfChange('instructions')
  await writeFileAtomic(instructionPath, SAVED_TEXT)
  watcher.noteSelfChange('instructions')
  delayMainThread()
  await expectEvents([])
  console.log('PASS delayed owned instruction write stays quiet after the mute window')

  await writeFile(instructionPath, 'Written outside Vengeance\n')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  await writeFile(instructionPath, SAVED_TEXT)
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS a different external write invalidates ownership; reverting stays external')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  watcher.noteSelfChange('instructions')
  await delay(OWNED_WRITE_SETTLE_MS)
  await writeFile(instructionPath, 'External edit during the save mute window\n')
  await delay(QUICK_WATCHER_SETTLE_MS)
  assert.deepEqual(events.splice(0), [{ area: 'instructions', cwd: null, fromRun: false }])
  await writeFile(instructionPath, SAVED_TEXT)
  await delay(QUICK_WATCHER_SETTLE_MS)
  assert.deepEqual(events.splice(0), [{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS external edits and reverts stay visible inside the save mute window')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  watcher.noteSelfChange('instructions')
  await expectEvents([])
  const removedFile = writeInstructionFile(null, instructionRef, null)
  const successfulTrash = trashRequests.shift()
  assert.equal(successfulTrash.path, instructionPath)
  await unlink(instructionPath)
  successfulTrash.resolve()
  await removedFile
  watcher.noteSelfChange('instructions')
  delayMainThread()
  await expectEvents([])
  await writeFile(instructionPath, SAVED_TEXT)
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS delayed owned removal stays quiet; external recreation still notifies')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  watcher.noteSelfChange('instructions')
  await expectEvents([])
  const rejectedText = 'Rejected by a sharing lock\n'
  await withBlockedReplacement(instructionPath, () =>
    assert.rejects(writeFileAtomic(instructionPath, rejectedText), { code: 'EPERM' })
  )
  fileSystem.writeFileSync(instructionPath, SAVED_TEXT, 'utf8')
  await expectEvents([])
  fileSystem.writeFileSync(instructionPath, rejectedText, 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log(
    'PASS failed replacement keeps the saved ownership and exposes attempted text as external'
  )

  const appendPath = join(account, 'APPEND_SYSTEM.md')
  await withBlockedReplacement(appendPath, () =>
    assert.rejects(writeFileAtomic(appendPath, rejectedText), { code: 'EPERM' })
  )
  fileSystem.writeFileSync(appendPath, rejectedText, 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS failed creation does not suppress a matching external creation')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  watcher.noteSelfChange('instructions')
  await expectEvents([])
  const concurrentText = 'Saved by an overlapping write\n'
  await withBlockedReplacement(instructionPath, async () => {
    const failedWrite = assert.rejects(writeFileAtomic(instructionPath, concurrentText), {
      code: 'EPERM'
    })
    try {
      await delay(OWNED_WRITE_SETTLE_MS)
      await writeFileAtomic(instructionPath, concurrentText)
    } finally {
      await failedWrite
    }
  })
  await expectEvents([])
  fileSystem.writeFileSync(instructionPath, SAVED_TEXT, 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS failed replacement cannot undo ownership of a concurrent same-text save')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  await expectEvents([])
  const outsideRemoval = assert.rejects(writeInstructionFile(null, instructionRef, null), {
    message: TRASH_FAILURE
  })
  fileSystem.writeFileSync(instructionPath, 'External edit while removal is pending\n', 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  trashRequests.shift().reject(new Error(TRASH_FAILURE))
  await outsideRemoval
  fileSystem.writeFileSync(instructionPath, SAVED_TEXT, 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS failed removal does not resurrect ownership invalidated by an external edit')

  await writeFileAtomic(instructionPath, SAVED_TEXT)
  await expectEvents([])
  const overlappingRemoval = assert.rejects(writeInstructionFile(null, instructionRef, null), {
    message: TRASH_FAILURE
  })
  await writeInstructionFile(null, instructionRef, concurrentText)
  await expectEvents([])
  trashRequests.shift().reject(new Error(TRASH_FAILURE))
  await overlappingRemoval
  fileSystem.writeFileSync(instructionPath, concurrentText, 'utf8')
  await expectEvents([])
  fileSystem.writeFileSync(instructionPath, SAVED_TEXT, 'utf8')
  await expectEvents([{ area: 'instructions', cwd: null, fromRun: false }])
  console.log('PASS failed removal cannot overwrite ownership of a newer successful save')

  for (const failureOrder of [
    [0, 1],
    [1, 0]
  ]) {
    await writeFileAtomic(instructionPath, SAVED_TEXT)
    await expectEvents([])
    const removals = failureOrder.map(() =>
      assert.rejects(writeInstructionFile(null, instructionRef, null), { message: TRASH_FAILURE })
    )
    const concurrentTrash = trashRequests.splice(0)
    assert.equal(concurrentTrash.length, failureOrder.length)
    try {
      for (const index of failureOrder) {
        concurrentTrash[index].reject(new Error(TRASH_FAILURE))
        await removals[index]
      }
    } finally {
      for (const request of concurrentTrash) request.reject(new Error(TRASH_FAILURE))
      await Promise.allSettled(removals)
    }
    fileSystem.writeFileSync(instructionPath, SAVED_TEXT, 'utf8')
    await expectEvents([])
  }
  console.log('PASS concurrent same-null removals roll back safely in either failure order')
} finally {
  for (const request of trashRequests) request.reject(new Error(TRASH_FAILURE))
  watcher?.stop()
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  await fixture.cleanup()
}
