// Run against a coordinated build with QA_TMP_ROOT outside the repository and user profile.
// QA_SCALE_BASELINE=1 records regressions without stopping the remaining public UI probes.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createEngineFixture } from '../engines/integration-fixture.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { softSteps } from '../lib/steps.mjs'
import { SessionBuilder, workspaceSessionDir } from '../sessions/lib/session-files.mjs'
import { assertUniqueVisibleSessions, captureSidebarRows } from './workspace-scale-diagnostics.mjs'

const PRIMARY_SESSION_COUNT = 4000
const OTHER_WORKSPACE_COUNT = 64
const VISITED_WORKSPACE_COUNT = 14
const OTHER_SESSION_COUNT = 300
const SMALL_WORKSPACE_SESSION_COUNT = 2
const MAX_MOUNTED_WORKSPACES = 40
const MAX_MOUNTED_ROWS = 100
const MAX_SEARCH_MS = 2000
const MAX_HISTORY_READY_MS = 15_000
const MAX_UI_FRAME_GAP_MS = 1000
const MAX_SECOND_PASS_HEAP_GROWTH = 32 * 1024 * 1024
const MAX_MAIN_HEAP_GROWTH = 96 * 1024 * 1024
const READY_TIMEOUT_MS = 30_000
const POLL_MS = 50
const MEBIBYTE = 1024 * 1024
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const SEARCH_PAYLOAD = 'Saved implementation details '.repeat(160)
const KEYBOARD_STEPS = 80
const WRITE_BATCH_SIZE = 32
const MAX_GROUP_SCROLLS = 100
const PANEL_SETTLE_MS = 400
const baseline = process.env.QA_SCALE_BASELINE === '1'
const rowDiagnostic = process.argv.includes('--row-diagnostic')
const focused = rowDiagnostic || process.argv.includes('--focused')
const FOCUSED_CHECKS = new Set([
  'open, close and reopen each native backend from search',
  'window all-workspace groups and expand a large mixed history',
  'expanded nested rows follow a workspace reordered by new activity',
  'keyboard crosses a collapsed offscreen workspace group',
  'restore and rename dormant custom histories from a hidden workspace'
])
const report = { baseline, focused, rowDiagnostic, measurements: [], failures: [] }
const outDir = reportShotsDir('workspace-scale')

async function step(label, action) {
  const started = performance.now()
  console.log(`  • ${label}`)
  const result = await action()
  console.log(`    ✓ ${label} (${((performance.now() - started) / 1000).toFixed(1)}s)`)
  return result
}

async function waitFor(check, label) {
  const started = performance.now()
  while (performance.now() - started < READY_TIMEOUT_MS) {
    const result = await check()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS))
  }
  assert.fail(`Timed out waiting for ${label}`)
}

function sessionName(workspaceIndex, sessionIndex, engine) {
  return `Scale ${workspaceIndex} ${engine} ${String(sessionIndex).padStart(4, '0')}`
}

async function writeSession(fixture, cwd, workspaceIndex, sessionIndex) {
  const engine = sessionIndex % 2 === 0 ? 'pi' : 'prime'
  // Old and recent history exercise date sections; each timestamp establishes a stable row order.
  const age = sessionIndex < PRIMARY_SESSION_COUNT / 2 ? MINUTE_MS : DAY_MS * 14
  const startedAt = Date.now() - age - sessionIndex * 10
  const builder = new SessionBuilder({ cwd, startedAt, stepMs: 1 })
  const name = sessionName(workspaceIndex, sessionIndex, engine)
  builder.modelChange(
    engine === 'pi' ? 'qa' : 'qa-prime',
    engine === 'pi' ? 'qa-reasoning' : 'prime-qa'
  )
  builder.user(`Investigate ${name}`)
  builder.assistant(`${name}: ${SEARCH_PAYLOAD}`)
  builder.name(name)
  const folder =
    engine === 'pi' ? workspaceSessionDir(fixture.piDirectory, cwd) : fixture.sessionDirectory
  const path = await builder.write(folder)
  return { path, name, cwd, engine }
}

async function writeHistory(fixture) {
  const workspaces = []
  for (let workspaceIndex = 0; workspaceIndex <= OTHER_WORKSPACE_COUNT; workspaceIndex++) {
    const cwd = await fixture.root.folder(`scale-workspace-${workspaceIndex}`, {
      'README.md': '# Workspace scale QA\n'
    })
    const count =
      workspaceIndex === 0
        ? PRIMARY_SESSION_COUNT
        : workspaceIndex <= VISITED_WORKSPACE_COUNT
          ? OTHER_SESSION_COUNT
          : SMALL_WORKSPACE_SESSION_COUNT
    const sessions = []
    for (let first = 0; first < count; first += WRITE_BATCH_SIZE) {
      const batch = Array.from({ length: Math.min(WRITE_BATCH_SIZE, count - first) }, (_, offset) =>
        writeSession(fixture, cwd, workspaceIndex, first + offset)
      )
      sessions.push(...(await Promise.all(batch)))
    }
    workspaces.push({ cwd, sessions })
  }
  return workspaces
}

function rows(application, name) {
  return application.page.locator('[data-session-row]').filter({ hasText: name })
}

function committedMessages(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message')
}

async function searchSession(application, name) {
  const started = performance.now()
  await application.page.getByRole('textbox', { name: 'Search sessions' }).fill(name)
  const match = rows(application, name).or(
    application.page.getByRole('button', { name: `Resume ${name}`, exact: true })
  )
  await match.first().waitFor()
  const elapsedMs = performance.now() - started
  report.measurements.push({ operation: 'search', name, elapsedMs })
  assert.ok(elapsedMs < MAX_SEARCH_MS, `Search took ${elapsedMs.toFixed(0)}ms for ${name}`)
  return match.first()
}

async function openSwitcher(application) {
  await application.page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await application.page.getByRole('textbox', { name: 'Find workspace' }).waitFor()
  await application.page.locator('[aria-label="Workspaces"][aria-busy="false"]').waitFor()
}

async function switchWorkspace(application, cwd) {
  const started = performance.now()
  await openSwitcher(application)
  const search = application.page.getByRole('textbox', { name: 'Find workspace' })
  await search.fill(cwd)
  await search.press('ArrowDown')
  await application.page
    .locator('[data-workspace-choice]')
    .and(application.page.getByTitle(cwd, { exact: true }))
    .press('Enter')
  await waitFor(async () => (await application.appState()).prefs.activeWorkspace === cwd, cwd)
  await application.composer()
  await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
  await application.page.getByRole('status', { name: 'Loading sessions' }).waitFor({
    state: 'hidden'
  })
  report.measurements.push({
    operation: 'workspace-switch',
    cwd,
    elapsedMs: performance.now() - started
  })
}

async function revealWorkspaceGroup(application, workspaceIndex) {
  const list = application.page.locator('[data-session-list]')
  const heading = list.locator('button[aria-expanded]').filter({
    has: application.page.getByText(`Scale workspace ${workspaceIndex}`, { exact: true })
  })
  await list.evaluate((element) => element.scrollTo(0, 0))
  for (let attempt = 0; attempt < MAX_GROUP_SCROLLS; attempt++) {
    if (await heading.count()) {
      const bounds = await heading.boundingBox().catch(() => null)
      const sidebarBounds = await list.boundingBox()
      if (bounds && sidebarBounds) {
        const inside =
          bounds.y >= sidebarBounds.y &&
          bounds.y + bounds.height <= sidebarBounds.y + sidebarBounds.height
        if (inside) {
          await heading.focus()
          await application.page.waitForTimeout(PANEL_SETTLE_MS)
          await assertInsideSidebar(application, heading)
          return heading
        }
        const offset = bounds.y - sidebarBounds.y - sidebarBounds.height / 2
        await list.evaluate((element, top) => element.scrollBy(0, top), offset)
      }
    } else {
      await list.evaluate((element) => element.scrollBy(0, element.clientHeight))
    }
    await application.page.evaluate(() => new Promise(requestAnimationFrame))
  }
  assert.fail(`Workspace group ${workspaceIndex} was not reachable by scrolling`)
}

async function assertFocusedTitle(application, title) {
  await waitFor(
    () =>
      application.page.evaluate(
        (expected) => document.activeElement?.getAttribute('title') === expected,
        title
      ),
    `keyboard focus on ${title}`
  )
}

async function assertInsideSidebar(application, row) {
  const sidebarBounds = await application.page.locator('[data-session-list]').boundingBox()
  const rowBounds = await row.boundingBox()
  assert.ok(sidebarBounds && rowBounds, 'Sidebar and row have visible geometry')
  assert.ok(
    rowBounds.y >= sidebarBounds.y &&
      rowBounds.y + rowBounds.height <= sidebarBounds.y + sidebarBounds.height,
    `Row ${rowBounds.y}/${rowBounds.height} is outside sidebar ${sidebarBounds.y}/${sidebarBounds.height}`
  )
}

async function memorySample(application, debuggerSession, label) {
  await debuggerSession.send('HeapProfiler.collectGarbage')
  const renderer = await debuggerSession.send('Runtime.getHeapUsage')
  const main = await application.app.evaluate(() => process.memoryUsage())
  const sample = {
    operation: 'memory',
    label,
    rendererHeap: renderer.usedSize,
    mainHeap: main.heapUsed,
    mainRss: main.rss,
    mountedRows: await application.page.locator('[data-session-row]').count()
  }
  report.measurements.push(sample)
  console.log(
    `    ${label}: renderer ${(sample.rendererHeap / MEBIBYTE).toFixed(1)} MiB; ` +
      `main heap ${(sample.mainHeap / MEBIBYTE).toFixed(1)} MiB; ` +
      `${sample.mountedRows} mounted rows`
  )
  return sample
}

async function startFrameProbe(application) {
  await application.page.evaluate(() => {
    const state = { last: performance.now(), gaps: [], running: true }
    window.__qaScaleFrames = state
    const tick = (now) => {
      state.gaps.push(now - state.last)
      state.last = now
      if (state.running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function finishFrameProbe(application) {
  return application.page.evaluate(() => {
    const state = window.__qaScaleFrames
    state.running = false
    delete window.__qaScaleFrames
    return Math.max(0, ...state.gaps)
  })
}

async function renameThroughKeyboard(application, session, name) {
  const row = await searchSession(application, session.name)
  await row.press('F2')
  const field = application.page.getByRole('textbox', { name: 'Session name', exact: true })
  await field.fill(name)
  await field.press('Enter')
  await application.page.getByRole('textbox', { name: 'Search sessions' }).fill(name)
  await rows(application, name).waitFor()
  const listing = await application.invoke('sessions:list', {
    cwd: session.cwd,
    engine: session.engine
  })
  assert.equal(
    listing.sessions.find((item) => item.path.toLowerCase() === session.path.toLowerCase())?.name,
    name
  )
}

async function waitForHandleClose(application, agentId) {
  await waitFor(
    async () =>
      !(await application.invoke('engine:list')).some((agent) => agent.id === agentId) &&
      !(await application.agentState(agentId)),
    `app handle ${agentId} closed`
  )
}

async function writeDormantHistory(fixture) {
  const piFolder = await fixture.root.folder('custom-pi-history')
  const primeFolder = await fixture.root.folder('custom-prime-history')
  const cwd = await fixture.root.folder('hidden-dormant-workspace', {
    'README.md': '# Hidden restored workspace\n',
    [join('.pi', 'settings.json')]: { sessionDir: piFolder },
    [join('.prime', 'agent', 'settings.json')]: { sessionDir: primeFolder }
  })
  const sessions = []
  for (const engine of ['pi', 'prime']) {
    const builder = new SessionBuilder({ cwd })
    const name = `Dormant custom ${engine} history`
    builder.user(`Continue ${name}`)
    builder.assistant('The saved project details remain available.')
    builder.name(name)
    const path = await builder.write(engine === 'pi' ? piFolder : primeFolder)
    sessions.push({ path, cwd, engine, name })
  }
  return { cwd, sessions }
}

const fixture = await createEngineFixture()
let application
let debuggerSession
console.log(`▶ performance-workspace-scale (${baseline ? 'baseline' : 'gated'})`)

try {
  const workspaces = await step('write 8,300 isolated mixed-engine native histories', () =>
    writeHistory(fixture)
  )
  const primary = workspaces[0]
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir
  })
  debuggerSession = await application.page.context().newCDPSession(application.page)
  const checks = softSteps(
    async (label, action) => {
      if (focused && !FOCUSED_CHECKS.has(label)) return
      if (
        rowDiagnostic &&
        (label.startsWith('keyboard crosses') || label.startsWith('restore and rename'))
      )
        return
      return step(label, action)
    },
    { app: () => application, name: 'workspace-scale' }
  )

  await step('persist workspace metadata and load the primary history', async () => {
    const started = performance.now()
    await application.test('setPrefs', {
      workspaces: workspaces.map((workspace, index) => ({
        path: workspace.cwd,
        name: `Scale workspace ${index}`,
        lastOpenedAt: Date.now() - index,
        engine: 'pi'
      })),
      activeWorkspace: primary.cwd,
      onboardingCompleted: true,
      features: { sessions: { scope: 'workspace', pinned: [primary.sessions[0].path] } }
    })
    await rows(application, primary.sessions[0].name).waitFor()
    const elapsedMs = performance.now() - started
    report.measurements.push({ operation: 'primary-history-ready', elapsedMs })
    assert.ok(elapsedMs < MAX_HISTORY_READY_MS, `Primary history took ${elapsedMs.toFixed(0)}ms`)
    for (const engine of ['pi', 'prime']) {
      const result = await application.invoke('sessions:list', { cwd: primary.cwd, engine })
      assert.equal(result.sessions.length, PRIMARY_SESSION_COUNT / 2)
      assert.ok(result.sessions.every((session) => session.engine === engine))
    }
  })

  const initial = await memorySample(application, debuggerSession, 'primary-loaded')
  await checks.check('mount a bounded sidebar for four thousand saved sessions', async () => {
    assert.ok(initial.mountedRows < MAX_MOUNTED_ROWS, `${initial.mountedRows} rows mounted`)
    await application.screenshot('workspace-scale-primary')
    assert.ok(await application.page.getByRole('region', { name: 'Pinned sessions' }).count())
  })

  await checks.check('search oldest and newest sessions from both engines', async () => {
    await startFrameProbe(application)
    try {
      for (const index of [0, 1, PRIMARY_SESSION_COUNT - 2, PRIMARY_SESSION_COUNT - 1]) {
        await searchSession(application, primary.sessions[index].name)
        assert.equal(await application.page.locator('[data-session-row]').count(), 1)
      }
      await application.screenshot('workspace-scale-oldest-search')
    } finally {
      const maximumGapMs = await finishFrameProbe(application)
      report.measurements.push({ operation: 'search-frame-gap', maximumGapMs })
      assert.ok(maximumGapMs < MAX_UI_FRAME_GAP_MS, `Search blocked frames for ${maximumGapMs}ms`)
    }
  })

  await checks.check('scroll to old history and keyboard across offscreen rows', async () => {
    const search = application.page.getByRole('textbox', { name: 'Search sessions' })
    await search.fill('')
    const list = application.page.locator('[data-session-list]')
    await list.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    await rows(application, primary.sessions.at(-1).name).waitFor()
    assert.ok((await application.page.locator('[data-session-row]').count()) < MAX_MOUNTED_ROWS)
    await application.screenshot('workspace-scale-oldest-scroll')
    await list.evaluate((element) => element.scrollTo(0, 0))
    await search.focus()
    await search.press('ArrowDown')
    const titles = new Set()
    for (let index = 0; index < KEYBOARD_STEPS; index++) {
      const focused = await application.page.evaluate(() => ({
        title: document.activeElement?.textContent,
        row: document.activeElement?.hasAttribute('data-session-row')
      }))
      assert.equal(focused.row, true, `Keyboard lost the row after ${index} steps`)
      titles.add(focused.title)
      await application.page.keyboard.press('ArrowDown')
    }
    assert.equal(titles.size, KEYBOARD_STEPS, 'ArrowDown reaches distinct offscreen sessions')
  })

  await checks.check('open, close and reopen each native backend from search', async () => {
    for (const session of primary.sessions.slice(0, 2)) {
      const original = await readFile(session.path, 'utf8')
      await (await searchSession(application, session.name)).press('Enter')
      await application.composer()
      await waitFor(async () => {
        const state = await application.agentState()
        return (
          state?.info.engine === session.engine &&
          state.entries.some((entry) => JSON.stringify(entry).includes(session.name))
        )
      }, `native session ${session.name}`)
      const state = await application.agentState()
      assert.equal(state.info.engine, session.engine)
      assert.ok(state.entries.some((entry) => JSON.stringify(entry).includes(session.name)))
      await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
      await application.page
        .getByRole('region', { name: 'Open sessions', exact: true })
        .locator('[data-session-row]')
        .filter({ hasText: session.name })
        .locator('..')
        .getByRole('button', { name: 'Close tab', exact: true })
        .click()
      await waitForHandleClose(application, state.id)
      await (await searchSession(application, session.name)).press('Enter')
      await application.composer()
      await waitFor(async () => {
        const reopened = await application.agentState()
        return reopened?.info.engine === session.engine && reopened.id !== state.id
      }, `${session.engine} session reopened with a new app handle`)
      assert.equal((await application.agentState()).info.engine, session.engine)
      assert.deepEqual(
        committedMessages(await readFile(session.path, 'utf8')),
        committedMessages(original),
        'Opening keeps committed saved messages intact'
      )
    }
    await application.screenshot('workspace-scale-native-reopened')
  })

  await checks.check(
    'window sixty-five workspace choices and navigate the oldest choice',
    async () => {
      await openSwitcher(application)
      const choices = application.page.locator('[data-workspace-choice]')
      assert.ok((await choices.count()) < MAX_MOUNTED_WORKSPACES)
      const search = application.page.getByRole('textbox', { name: 'Find workspace' })
      await search.press('ArrowDown')
      const sorted = [...(await application.appState()).prefs.workspaces].sort(
        (first, second) => second.lastOpenedAt - first.lastOpenedAt
      )
      await assertFocusedTitle(application, sorted[0].path)
      await application.page.keyboard.press('ArrowUp')
      await assertFocusedTitle(application, sorted.at(-1).path)
      await application.page.keyboard.press('ArrowDown')
      await assertFocusedTitle(application, sorted[0].path)
      const visited = new Set()
      for (let index = 0; index < OTHER_WORKSPACE_COUNT; index++) {
        const focused = await application.page.evaluate(() => ({
          title: document.activeElement?.getAttribute('title'),
          choice: document.activeElement?.hasAttribute('data-workspace-choice')
        }))
        assert.equal(focused.choice, true, `Workspace keyboard focus lost at ${index}`)
        visited.add(focused.title)
        await application.page.keyboard.press('ArrowDown')
      }
      assert.equal(visited.size, OTHER_WORKSPACE_COUNT)
      await application.screenshot('workspace-scale-picker-last')
      await application.page.keyboard.press('Escape')
    }
  )

  await checks.check('window all-workspace groups and expand a large mixed history', async () => {
    await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
    await openSwitcher(application)
    await application.page.getByRole('button', { name: 'All workspaces', exact: true }).click()
    await application.page.getByRole('region', { name: 'Sessions by workspace' }).waitFor()
    assert.ok((await application.page.locator('[data-session-row]').count()) < MAX_MOUNTED_ROWS)
    const list = application.page.locator('[data-session-list]')
    await list.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    const showMore = application.page.getByRole('button', { name: /^Show \d+ more$/ }).last()
    await showMore.waitFor()
    await showMore.click()
    await list.evaluate((element) => element.scrollTo(0, element.scrollHeight))
    await rows(application, primary.sessions.at(-1).name).waitFor()
    assert.ok((await application.page.locator('[data-session-row]').count()) < MAX_MOUNTED_ROWS)
    await application.screenshot('workspace-scale-all-expanded')
    await searchSession(application, primary.sessions.at(-1).name)
    await switchWorkspace(application, primary.cwd)
  })

  await checks.check(
    'expanded nested rows follow a workspace reordered by new activity',
    async () => {
      const activitySession = primary.sessions.find(
        (session) => session.engine === 'pi' && session.path !== primary.sessions[0].path
      )
      await (await searchSession(application, activitySession.name)).press('Enter')
      await waitFor(async () => {
        const state = await application.agentState()
        return state?.entries.some((entry) => JSON.stringify(entry).includes(activitySession.name))
      }, 'an unpinned native session to create history activity')
      await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
      await openSwitcher(application)
      await application.page.getByRole('button', { name: 'All workspaces', exact: true }).click()
      const activeId = await application.activeAgentId()
      assert.equal((await application.agentState()).info.engine, 'pi')
      fixture.piServer.queue(turn.text('Updated sidebar activity.'))
      await application.send('ok')
      await application.waitForSettle()
      await rows(application, activitySession.name)
        .first()
        .locator('..')
        .getByRole('button', { name: 'Close tab', exact: true })
        .click()
      await waitForHandleClose(application, activeId)
      await waitFor(
        async () =>
          (
            await application.page
              .getByRole('region', { name: 'Sessions by workspace' })
              .locator('button[aria-expanded]')
              .first()
              .innerText()
          ).includes('Scale workspace 0'),
        'new saved activity reorders the expanded workspace to the first group'
      )
      const heading = await revealWorkspaceGroup(application, 0)
      const list = application.page.locator('[data-session-list]')
      await heading.evaluate((element) => {
        const group = element.parentElement.parentElement
        const scroll = element.closest('[data-session-list]')
        const offset =
          group.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
        scroll.scrollTo(0, offset + group.clientHeight - scroll.clientHeight)
      })
      const oldest = rows(application, primary.sessions.at(-1).name)
      await oldest.waitFor()
      await assertInsideSidebar(application, oldest)
      if (rowDiagnostic) {
        report.measurements.push(
          await captureSidebarRows(application, primary.sessions, 'before-arrow-up', true)
        )
        await application.screenshot('workspace-scale-expanded-reordered-before-arrow')
      }
      await oldest.focus()
      await oldest.press('ArrowUp')
      await waitFor(
        () =>
          application.page.evaluate(() =>
            document.activeElement?.textContent?.includes('Scale 0 pi 3998')
          ),
        'keyboard navigation inside the reordered expanded group'
      )
      await application.screenshot('workspace-scale-expanded-reordered')
      const rowsSnapshot = await captureSidebarRows(
        application,
        primary.sessions,
        'after-arrow-up',
        rowDiagnostic
      )
      report.measurements.push(rowsSnapshot)
      try {
        assertUniqueVisibleSessions(rowsSnapshot)
      } catch (error) {
        report.measurements.push(
          await captureSidebarRows(application, primary.sessions, 'duplicate-visible-rows', true)
        )
        throw error
      }
      await list.evaluate((element) => element.scrollTo(0, 0))
      await switchWorkspace(application, primary.cwd)
    }
  )

  await checks.check('keyboard crosses a collapsed offscreen workspace group', async () => {
    await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
    await openSwitcher(application)
    await application.page.getByRole('button', { name: 'All workspaces', exact: true }).click()
    const largeGroup = await revealWorkspaceGroup(application, 0)
    if ((await largeGroup.getAttribute('aria-expanded')) === 'true') await largeGroup.click()
    await application.page.waitForTimeout(PANEL_SETTLE_MS)
    const collapsed = await revealWorkspaceGroup(application, 2)
    if ((await collapsed.getAttribute('aria-expanded')) === 'true') await collapsed.click()
    await application.page.waitForTimeout(PANEL_SETTLE_MS)
    await revealWorkspaceGroup(application, 3)
    const thirdRows = application.page
      .locator('[data-session-row]')
      .filter({ hasText: /^Scale 3 / })
    await thirdRows.last().press('ArrowDown')
    await waitFor(
      () =>
        application.page.evaluate(() =>
          document.activeElement?.textContent?.includes('Scale 1 pi 0000')
        ),
      'the next real row beyond collapsed workspace 2'
    )
    await application.screenshot('workspace-scale-collapsed-keyboard')
    await switchWorkspace(application, primary.cwd)
  })

  await checks.check('visit fourteen workspaces twice with bounded retained memory', async () => {
    const samples = []
    for (let pass = 0; pass < 2; pass++) {
      for (const workspace of workspaces.slice(1, VISITED_WORKSPACE_COUNT + 1)) {
        await switchWorkspace(application, workspace.cwd)
        await searchSession(application, workspace.sessions[0].name)
        await searchSession(application, workspace.sessions[1].name)
      }
      samples.push(await memorySample(application, debuggerSession, `workspace-pass-${pass + 1}`))
    }
    const rendererGrowth = samples[1].rendererHeap - samples[0].rendererHeap
    const mainGrowth = samples[1].mainHeap - initial.mainHeap
    assert.ok(rendererGrowth < MAX_SECOND_PASS_HEAP_GROWTH, `Renderer grew ${rendererGrowth} bytes`)
    assert.ok(mainGrowth < MAX_MAIN_HEAP_GROWTH, `Main heap grew ${mainGrowth} bytes`)
  })

  await checks.check(
    'rename and delete history after eviction and restore mixed provenance',
    async () => {
      for (const session of primary.sessions.slice(6, 8)) {
        await application.invoke(
          'sessions:rename',
          session.path,
          `Externally renamed ${session.name}`
        )
      }
      await switchWorkspace(application, primary.cwd)
      for (const session of primary.sessions.slice(6, 8)) {
        await searchSession(application, `Externally renamed ${session.name}`)
      }
      for (const session of primary.sessions.slice(2, 4)) {
        await renameThroughKeyboard(application, session, `Renamed ${session.name}`)
      }
      const deleted = primary.sessions[4]
      await (await searchSession(application, deleted.name)).press('Delete')
      await application.page
        .getByRole('button', { name: 'Move to Recycle Bin', exact: true })
        .click()
      await application.page.getByText('No matching sessions', { exact: true }).waitFor()
      await switchWorkspace(application, workspaces.at(-1).cwd)
      await switchWorkspace(application, primary.cwd)
      for (const session of primary.sessions.slice(2, 4)) {
        await searchSession(application, `Renamed ${session.name}`)
      }
      await application.page.getByRole('textbox', { name: 'Search sessions' }).fill(deleted.name)
      await application.page.getByText('No matching sessions', { exact: true }).waitFor()
      await application.screenshot('workspace-scale-mutations')
      const listed = await Promise.all(
        ['pi', 'prime'].map((engine) =>
          application.invoke('sessions:list', { cwd: primary.cwd, engine })
        )
      )
      assert.equal(listed.flatMap((result) => result.sessions).length, PRIMARY_SESSION_COUNT - 1)
      assert.ok(
        !listed.some((result) =>
          result.sessions.some((item) => item.path.toLowerCase() === deleted.path.toLowerCase())
        )
      )
      application.assertNoErrors()
    }
  )

  await checks.check(
    'restore and rename dormant custom histories from a hidden workspace',
    async () => {
      const dormant = await writeDormantHistory(fixture)
      const prefs = (await application.appState()).prefs
      const front = primary.sessions[0]
      await application.invoke('app:set-state', {
        workspaces: prefs.workspaces.filter((workspace) => workspace.path !== dormant.cwd),
        activeWorkspace: primary.cwd,
        activeSession: front.path,
        openSessions: [front, ...dormant.sessions].map(({ path, cwd, engine }) => ({
          path,
          cwd,
          engine
        })),
        features: {
          ...prefs.features,
          sessions: {
            ...prefs.features.sessions,
            scope: 'workspace',
            hiddenWorkspaces: [dormant.cwd.toLowerCase()]
          }
        }
      })
      await debuggerSession.detach()
      debuggerSession = undefined
      application = await application.relaunch()
      debuggerSession = await application.page.context().newCDPSession(application.page)
      await application.composer()
      for (const session of dormant.sessions) {
        await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
        await rows(application, session.name).waitFor()
        await renameThroughKeyboard(application, session, `Renamed ${session.name}`)
        const current = (await application.appState()).prefs
        assert.equal(current.activeWorkspace, primary.cwd)
        assert.equal(current.features.sessions.scope, 'workspace')
        assert.ok(!current.workspaces.some((workspace) => workspace.path === dormant.cwd))
        const agents = await application.invoke('engine:list')
        assert.ok(
          !agents.some((agent) => agent.cwd === dormant.cwd),
          'Dormant history stays dormant'
        )
      }
      await application.page.getByRole('textbox', { name: 'Search sessions' }).fill('')
      await application.screenshot('workspace-scale-dormant-custom-renamed')
      application.assertNoErrors()
    }
  )

  report.failures = checks.failures
  assert.equal(
    fixture.piServer.requests.length,
    1,
    'Only the local history activity probe requests a model'
  )
  assert.equal(
    fixture.primeServer.requests.length,
    0,
    'History QA never requests an Engine 2 model'
  )
  if (!baseline) checks.finish()
} catch (error) {
  report.failures.push(error.stack ?? String(error))
  await application?.screenshot('workspace-scale-failed', { settleMs: 0 }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await debuggerSession?.detach().catch(() => undefined)
  await application?.close({ beforeCleanup: fixture.stopNativeDaemon }).catch((error) => {
    report.failures.push(error.stack ?? String(error))
    process.exitCode = 1
  })
  await fixture.cleanup().catch((error) => {
    report.failures.push(error.stack ?? String(error))
    process.exitCode = 1
  })
  await mkdir(outDir, { recursive: true })
  const reportName = baseline
    ? 'baseline'
    : rowDiagnostic
      ? 'row-diagnostic'
      : focused
        ? 'focused'
        : 'final'
  await writeFile(join(outDir, `${reportName}-report.json`), JSON.stringify(report, null, 2))
  console.log(`Report: ${join(outDir, `${reportName}-report.json`)}`)
  console.log(`Failures: ${report.failures.length}`)
  console.log(`${process.exitCode ? '✗' : '✓'} performance-workspace-scale completed`)
}
