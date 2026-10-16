// Session listing through the built app, checked against its bundled Engine SDK.
// Run after `npm run build`: node scripts/qa/performance/session-listing.qa.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runSuite } from '../lib/suite.mjs'
import { isInside, QA_TMP_ROOT } from '../lib/tmp.mjs'
import { SessionBuilder, workspaceSessionDir } from '../sessions/lib/session-files.mjs'
import { enginePackageDir } from '../settings/engine-sdk.mjs'

const SEARCH_TEXT_LIMIT = 4000
const BULK_SESSION_COUNT = 320
const BULK_ANSWER_LENGTH = 32_000
const IMAGE_PAYLOAD_LENGTH = 8 * 1024 * 1024
const CONCURRENT_READS = 8
const CONCURRENT_ROUNDS = 3
const LIST_TIMEOUT_MS = 20_000
const MAX_MAIN_HEAP_GROWTH = 256 * 1024 * 1024
const DISCOVERY_ARCHIVE_BYTES = 32 * 1024 * 1024
const MAX_DISCOVERY_HEAP_GROWTH = 64 * 1024 * 1024

async function bundledSessionManager(agentDir) {
  const entryPoint = join(enginePackageDir(), 'dist', 'index.js')
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir

  try {
    const sdk = await import(pathToFileURL(entryPoint).href)
    assert.equal(sdk.getAgentDir(), agentDir)
    return sdk.SessionManager
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir
  }
}

async function withAgentDir(agentDir, action) {
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir

  try {
    return await action()
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir
  }
}

function expectedItem(info, subagentRun) {
  return {
    path: info.path,
    id: info.id,
    cwd: info.cwd,
    name: info.name,
    parentSessionPath: info.parentSessionPath,
    createdAt: info.created.getTime(),
    modifiedAt: info.modified.getTime(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage === '(no messages)' ? '' : info.firstMessage,
    searchText:
      `${info.name ?? ''} ${info.allMessagesText.slice(0, SEARCH_TEXT_LIMIT)}`.toLowerCase(),
    subagentRun
  }
}

function comparable(items) {
  return items
    .map((item) => {
      const metadata = JSON.parse(JSON.stringify(item))
      delete metadata.engine
      return metadata
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function assertPiItems(items) {
  for (const item of items) assert.equal(item.engine, 'pi', item.path)
}

async function expectedWorkspace(SessionManager, cwd, folder, child) {
  const parents = await SessionManager.list(cwd, folder)
  const items = parents.map((info) => expectedItem(info))
  if (child) {
    const nested = await SessionManager.listAll(child.folder)
    items.push(
      ...nested.map((info) =>
        expectedItem(info, { parentPath: child.parentPath, runId: child.runId })
      )
    )
  }
  return comparable(items)
}

async function expectedAll(SessionManager, child) {
  const parents = await SessionManager.listAll()
  const nested = await SessionManager.listAll(child.folder)
  return comparable([
    ...parents.map((info) => expectedItem(info)),
    ...nested.map((info) =>
      expectedItem(info, { parentPath: child.parentPath, runId: child.runId })
    )
  ])
}

async function timedList(app, cwd) {
  const started = performance.now()
  const result = await app.invoke('sessions:list', { cwd })
  const elapsedMs = performance.now() - started
  assert.ok(elapsedMs < LIST_TIMEOUT_MS, `listing took ${elapsedMs.toFixed(0)} ms`)
  assertPiItems(result.sessions)
  return { result, elapsedMs }
}

async function writeFixtures(agentDir, cwd, otherCwd, customCwd) {
  const folder = workspaceSessionDir(agentDir, cwd)
  const otherFolder = workspaceSessionDir(agentDir, otherCwd)
  const customFolder = agentDir.path('../session-listing-custom')
  await mkdir(folder, { recursive: true })
  await mkdir(otherFolder, { recursive: true })
  await mkdir(customFolder, { recursive: true })

  const normal = new SessionBuilder({ cwd })
  normal.user('listing normal first question')
  normal.assistant('listing normal answer')
  const normalPath = await normal.write(folder)

  const legacy = new SessionBuilder({ cwd })
  delete legacy.header.cwd
  legacy.header.version = 1
  legacy.user('listing legacy question')
  await legacy.write(folder)

  const malformed = new SessionBuilder({ cwd })
  malformed.user('listing malformed question')
  malformed.assistant('valid content after a broken line')
  const malformedPath = await malformed.write(folder)
  const malformedText = malformed.text().split('\n')
  // A valid header and first entry precede the damaged JSONL line.
  malformedText.splice(2, 0, '{broken\u2028json')
  await writeFile(malformedPath, malformedText.join('\n'), 'utf8')
  await writeFile(join(folder, 'invalid-header.jsonl'), '{broken header\n', 'utf8')

  const renamed = new SessionBuilder({ cwd })
  renamed.user('listing renamed question')
  renamed.name('Older display name')
  renamed.name('Newest display name')
  await renamed.write(folder)

  const branch = new SessionBuilder({ cwd, parentSession: normalPath })
  branch.user('listing branch question')
  await branch.write(folder)

  const customEntry = new SessionBuilder({ cwd })
  customEntry.customMessage('qa-note', 'custom entry content')
  customEntry.user('listing custom entry question')
  await customEntry.write(folder)

  const image = new SessionBuilder({ cwd })
  image.add({
    type: 'message',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'listing image question' },
        { type: 'image', data: 'QUJD'.repeat(IMAGE_PAYLOAD_LENGTH / 4), mimeType: 'image/png' }
      ],
      timestamp: image.clock + image.stepMs
    }
  })
  image.assistant('listing image answer')
  const imagePath = await image.write(folder)

  const other = new SessionBuilder({ cwd: otherCwd })
  other.user('listing other workspace question')
  await other.write(otherFolder)

  const custom = new SessionBuilder({ cwd: customCwd })
  custom.user('listing custom directory question')
  await custom.write(customFolder)

  const runId = randomUUID()
  const childFolder = join(dirname(normalPath), basename(normalPath, '.jsonl'), runId, 'run-0')
  const subagent = new SessionBuilder({ cwd, parentSession: normalPath })
  subagent.user('listing subagent question')
  await subagent.write(childFolder)

  const bulkAnswer = 'x'.repeat(BULK_ANSWER_LENGTH)
  for (let index = 0; index < BULK_SESSION_COUNT; index++) {
    const bulk = new SessionBuilder({ cwd })
    bulk.user(`listing bulk question ${index}`)
    bulk.assistant(`listing bulk answer ${index} ${bulkAnswer}`)
    await bulk.write(folder)
  }

  return {
    folder,
    customFolder,
    normalPath,
    imagePath,
    child: { folder: childFolder, parentPath: normalPath, runId }
  }
}

await runSuite('performance-session-listing', async ({ agentDir, app, step }) => {
  const cwd = await app.createWorkspace()
  const otherCwd = await app.createWorkspace()
  const customCwd = await app.createWorkspace({
    '.pi/settings.json': { sessionDir: agentDir.path('../session-listing-custom') }
  })
  const fixture = await step('create isolated session fixtures', () =>
    writeFixtures(agentDir, cwd, otherCwd, customCwd)
  )
  const SessionManager = await bundledSessionManager(agentDir.dir)

  await step('compare the cold app listing with an SDK scan', async () => {
    const beforeHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
    const appCold = await timedList(app, cwd)
    const afterHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
    const sdkStarted = performance.now()
    const expected = await withAgentDir(agentDir.dir, () =>
      expectedWorkspace(SessionManager, cwd, fixture.folder, fixture.child)
    )
    const sdkElapsedMs = performance.now() - sdkStarted
    assert.deepEqual(comparable(appCold.result.sessions), expected)
    const imageItem = appCold.result.sessions.find((item) => item.path === fixture.imagePath)
    assert.equal(imageItem?.firstMessage, 'listing image question')
    assert.ok(!imageItem.searchText.includes('QUJD'), 'image payload stays out of search text')
    console.log(
      `    cold app ${appCold.elapsedMs.toFixed(0)} ms; SDK ${sdkElapsedMs.toFixed(0)} ms; ` +
        `main heap delta ${((afterHeap - beforeHeap) / 1024 / 1024).toFixed(1)} MiB`
    )
  })

  await step('open the workspace and render listed sessions', async () => {
    await app.openWorkspace({ cwd })
    const search = app.page.getByRole('textbox', { name: 'Search sessions' })
    await search.fill('Newest display name')
    await app.page
      .locator('[data-session-row]', { hasText: 'Newest display name' })
      .first()
      .waitFor()
    await search.fill('listing subagent question')
    await app.page
      .locator('[data-session-row]', { hasText: 'listing subagent question' })
      .first()
      .waitFor()
    await search.fill('')
  })

  await step('match SDK metadata for workspace and all-workspace listings', async () => {
    const before = await stat(fixture.normalPath)
    const workspace = await timedList(app, cwd)
    const all = await timedList(app, null)
    const expectedWorkspaceItems = await withAgentDir(agentDir.dir, () =>
      expectedWorkspace(SessionManager, cwd, fixture.folder, fixture.child)
    )
    const expectedAllItems = await withAgentDir(agentDir.dir, () =>
      expectedAll(SessionManager, fixture.child)
    )
    assert.deepEqual(comparable(workspace.result.sessions), expectedWorkspaceItems)
    assert.deepEqual(comparable(all.result.sessions), expectedAllItems)
    assert.equal(workspace.result.sessionDir, fixture.folder)
    assert.equal(all.result.sessionDir, agentDir.path('sessions'))
    assert.ok(!all.result.sessions.some((item) => item.cwd === customCwd))
    const after = await stat(fixture.normalPath)
    assert.equal(after.mtimeMs, before.mtimeMs, 'listing did not write a session file')
    console.log(
      `    ${workspace.result.sessions.length} workspace sessions ` +
        `in ${workspace.elapsedMs.toFixed(0)} ms; ` +
        `${all.result.sessions.length} across workspaces in ${all.elapsedMs.toFixed(0)} ms`
    )
  })

  await step('respect a project custom session directory', async () => {
    const listed = await timedList(app, customCwd)
    const expected = await withAgentDir(agentDir.dir, () =>
      SessionManager.list(customCwd, fixture.customFolder)
    )
    assert.equal(listed.result.sessionDir, fixture.customFolder)
    assert.deepEqual(
      comparable(listed.result.sessions),
      comparable(expected.map((info) => expectedItem(info)))
    )
  })

  await step('emit a file-change event for the watched custom root', async () => {
    await app.page.evaluate(() => {
      window.__listingEvents = []
      window.__listingUnsubscribe = window.vengeance.on('sessions:changed', (event) => {
        window.__listingEvents.push(event)
      })
    })
    try {
      await app.invoke('sessions:list', { cwd: customCwd })
      const builder = new SessionBuilder({ cwd: customCwd })
      builder.user('custom watcher event')
      await builder.write(fixture.customFolder)
      await app.page.waitForFunction(
        (root) =>
          window.__listingEvents.some((event) => event.root.toLowerCase() === root.toLowerCase()),
        fixture.customFolder,
        { timeout: 10_000 }
      )
    } finally {
      await app.page.evaluate(() => {
        window.__listingUnsubscribe()
        delete window.__listingUnsubscribe
        delete window.__listingEvents
      })
    }
  })

  await step('refresh changed and deleted files without stale metadata', async () => {
    const before = await timedList(app, cwd)
    const builder = new SessionBuilder({ cwd })
    builder.user('listing newly added question')
    const addedPath = await builder.write(fixture.folder)
    const added = await timedList(app, cwd)
    assert.equal(added.result.sessions.length, before.result.sessions.length + 1)
    assert.ok(added.result.sessions.some((item) => item.path === addedPath))

    builder.name('Listing renamed on disk')
    await writeFile(addedPath, builder.text(), 'utf8')
    const renamed = await timedList(app, cwd)
    assert.equal(
      renamed.result.sessions.find((item) => item.path === addedPath)?.name,
      'Listing renamed on disk'
    )

    await unlink(addedPath)
    const deleted = await timedList(app, cwd)
    assert.deepEqual(comparable(deleted.result.sessions), comparable(before.result.sessions))
  })

  await step('repeat concurrent large listings with bounded main-process heap growth', async () => {
    const beforeHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
    const expected = comparable((await timedList(app, cwd)).result.sessions)
    const started = performance.now()

    for (let round = 0; round < CONCURRENT_ROUNDS; round++) {
      const results = await Promise.all(
        Array.from({ length: CONCURRENT_READS }, () => timedList(app, cwd))
      )
      for (const { result } of results) assert.deepEqual(comparable(result.sessions), expected)
    }

    const elapsedMs = performance.now() - started
    const afterHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
    const growth = afterHeap - beforeHeap
    assert.ok(
      growth < MAX_MAIN_HEAP_GROWTH,
      `main heap grew ${(growth / 1024 / 1024).toFixed(1)} MiB`
    )
    console.log(
      `    ${CONCURRENT_READS * CONCURRENT_ROUNDS} listings in ${elapsedMs.toFixed(0)} ms; ` +
        `main heap delta ${(growth / 1024 / 1024).toFixed(1)} MiB`
    )
  })

  await step('include a discovered custom root in the all-workspace list', async () => {
    const allAfterDiscovery = await timedList(app, null)
    assert.ok(
      allAfterDiscovery.result.sessions.some((item) => item.cwd === customCwd),
      'all-workspace listing includes a discovered custom root'
    )
  })

  await step(
    'discover workspaces from headers without loading a new large transcript',
    async () => {
      const discoveryCwd = await app.createWorkspace()
      const discoveryFolder = workspaceSessionDir(agentDir, discoveryCwd)
      const archive = new SessionBuilder({ cwd: discoveryCwd })
      archive.user('workspace discovery archive')
      archive.assistant('z'.repeat(DISCOVERY_ARCHIVE_BYTES))
      await archive.write(discoveryFolder)

      const beforeHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
      const started = performance.now()
      const discovered = await app.invoke('sessions:workspaces')
      const elapsedMs = performance.now() - started
      const afterHeap = await app.app.evaluate(() => process.memoryUsage().heapUsed)
      const workspace = discovered.find((item) => item.path === discoveryCwd)
      const outsideQaRoot = discovered.filter((item) => !isInside(QA_TMP_ROOT, item.path))

      assert.ok(workspace, 'workspace with a new large archive was found')
      assert.equal(outsideQaRoot.length, 0, 'discovery stayed inside the QA temp root')
      assert.ok(Number.isFinite(workspace.lastActivityAt))
      assert.ok(
        afterHeap - beforeHeap < MAX_DISCOVERY_HEAP_GROWTH,
        `discovery grew main heap ${((afterHeap - beforeHeap) / 1024 / 1024).toFixed(1)} MiB`
      )
      console.log(
        `    discovered ${discovered.length} workspaces in ${elapsedMs.toFixed(0)} ms; ` +
          `main heap delta ${((afterHeap - beforeHeap) / 1024 / 1024).toFixed(1)} MiB`
      )
    }
  )
})
