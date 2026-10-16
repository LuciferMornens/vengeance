import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FAKE_MODELS, FAKE_PROVIDER } from '../lib/agent-dir.mjs'
import { launchApp, reportShotsDir } from '../lib/app.mjs'
import { turn } from '../lib/fake-llm.mjs'
import { isAlive, killTree, processTable } from '../lib/processes.mjs'
import { isInside } from '../lib/tmp.mjs'
import { answerOpenDialog } from '../sessions/lib/main-stubs.mjs'
import { createEngineFixture, PRIME_MODELS, PRIME_PROVIDER } from './integration-fixture.mjs'

const OUTPUT_DIRECTORY = reportShotsDir('session-recovery')
const WAIT_TIMEOUT_MS = 60_000
const STEP_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 50
const DAEMON_LOSS_CHECKS = Number(process.env.QA_DAEMON_LOSS_CHECKS ?? 3)
assert.ok(Number.isSafeInteger(DAEMON_LOSS_CHECKS) && DAEMON_LOSS_CHECKS > 0)
const fixture = await createEngineFixture()
const foreignProcessIds = new Set((await processTable()).map((process) => process.pid))
const report = { checks: [], screenshots: [] }
let application
let failure

function samePath(first, second) {
  return !!first && !!second && resolve(first).toLowerCase() === resolve(second).toLowerCase()
}

async function until(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function check(label, action) {
  console.log(`  • ${label}`)
  await withTimeout(action(), label, STEP_TIMEOUT_MS)
  report.checks.push(label)
  console.log(`    ✓ ${label}`)
}

async function withTimeout(task, label, timeoutMs = WAIT_TIMEOUT_MS) {
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(
          () => rejectTimeout(new Error(`Timed out waiting for ${label}`)),
          timeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function openWorkspace(options) {
  console.log(`  • Open ${options.args.engine} workspace: ${options.cwd}`)
  let completed = false
  let opened
  let openError
  const opening = application.openWorkspace(options).then(
    (result) => {
      opened = result
      completed = true
    },
    (error) => {
      openError = error
      completed = true
    }
  )
  const trust = application.page.getByRole('dialog', { name: /^Trust/ })
  await withTimeout(
    until(async () => {
      if (completed) return true
      if (await trust.isVisible()) {
        console.log('    • Accept project trust for the isolated QA workspace')
        await trust.getByRole('option', { name: /^Trust and remember/ }).click()
      }
      return false
    }, 'workspace opened after project trust'),
    `${options.args.engine} workspace startup`
  )
  await opening
  if (openError) throw openError
  return opened
}

async function screenshot(name) {
  report.screenshots.push(await application.screenshot(name))
}

async function activeSession(engine, path) {
  return until(async () => {
    const active = await application.agentState()
    return active?.status === 'ready' &&
      active.info.engine === engine &&
      (!path || samePath(active.session?.sessionFile, path))
      ? active
      : undefined
  }, `${engine} historical session ready`)
}

async function allWorkspaces() {
  await application.page.getByRole('button', { name: 'Switch workspace' }).click()
  await application.page.getByRole('button', { name: 'All workspaces', exact: true }).click()
}

function sessionRow(name) {
  return application.page.locator('[data-session-row]', { hasText: name })
}

async function closeSavedSession(name, engine) {
  const active = await application.agentState()
  const descriptor = (await application.invoke('engine:list')).find(
    (entry) => entry.agentId === active.id
  )
  const row = application.page
    .locator('section[aria-label="Open sessions"]')
    .locator('[data-session-row]', { hasText: name })
  await row.hover()
  await row.locator('xpath=..').getByRole('button', { name: 'Close tab' }).click()
  await until(async () => !(await application.agentState(active.id)), 'saved tab closed')
  if (engine === 'prime') {
    await application.invoke('engine:background-stop', engine, descriptor.nativeAgentId)
  }
  if (descriptor.pid) {
    await until(() => !isAlive(descriptor.pid), 'the saved session worker released its workspace')
  }
}

async function setOverride(engine, path) {
  const patch =
    engine === 'pi' ? { engineOverridePath: path } : { engineOverridePaths: { prime: path } }
  await application.test('setPrefs', patch)
  await until(async () => {
    const prefs = await application.invoke('app:get-state')
    return (engine === 'pi' ? prefs.engineOverridePath : prefs.engineOverridePaths?.prime) === path
  }, 'engine override saved')
}

async function verifyHistory(engine, cwd, path, answer) {
  const active = await activeSession(engine, path)
  assert.ok(samePath(active.info.cwd, cwd), 'workspace belongs to the historical session')
  assert.ok(JSON.stringify(active.entries).includes(answer), 'native transcript restored')
  const owners = (await application.invoke('engine:list')).filter((entry) =>
    samePath(entry.sessionFile ?? entry.args.sessionPath, path)
  )
  assert.equal(owners.length, 1, 'one owner for the saved file')
  return active
}

async function recoverHistory(engine) {
  const sessionDirectory = fixture.root.path(`${engine}-custom-history`)
  const projectSettings =
    engine === 'pi' ? join('.pi', 'settings.json') : join('.prime', 'agent', 'settings.json')
  const workspace = await fixture.root.folder(`${engine}-history`, {
    'README.md': '# History\n',
    [projectSettings]: { sessionDir: sessionDirectory }
  })
  const otherWorkspace = await fixture.root.folder(`${engine}-other`)
  const targetWorkspace = await fixture.root.folder(`${engine}-relocated`)
  const name = `${engine === 'pi' ? 'Engine' : 'Engine 2'} historical recovery`
  const answer = `${name}: remembered before recovery.`
  const server = engine === 'pi' ? fixture.piServer : fixture.primeServer
  const args = {
    engine,
    name,
    provider: engine === 'pi' ? FAKE_PROVIDER : PRIME_PROVIDER,
    model: engine === 'pi' ? FAKE_MODELS.openai : PRIME_MODELS.reasoning,
    thinking: 'off'
  }
  await openWorkspace({ cwd: workspace, args })
  server.queue(turn.text(answer))
  await application.send('Remember this short historical session.')
  await application.waitForSettle()
  const original = await application.rpc({ type: 'get_state' })
  const originalPath = original.sessionFile
  assert.ok(isInside(sessionDirectory, originalPath), 'the native project storage setting applies')

  await check(`${engine}: reopen historical transcript from another workspace`, async () => {
    await closeSavedSession(name, engine)
    await openWorkspace({
      cwd: otherWorkspace,
      args: { engine: engine === 'pi' ? 'prime' : 'pi', noSession: true }
    })
    await allWorkspaces()
    const allBeforeScoped = await application.invoke('sessions:list', { engine, cwd: null })
    const scoped = await application.invoke('sessions:list', { engine, cwd: workspace })
    const allAfterScoped = await application.invoke('sessions:list', { engine, cwd: null })
    await mkdir(OUTPUT_DIRECTORY, { recursive: true })
    await writeFile(
      join(OUTPUT_DIRECTORY, `${engine}-history-discovery.json`),
      JSON.stringify(
        {
          originalPath,
          workspace,
          prefs: await application.invoke('app:get-state'),
          allBeforeScoped,
          scoped,
          allAfterScoped
        },
        null,
        2
      )
    )
    assert.ok(
      allBeforeScoped.sessions.some((session) => samePath(session.path, originalPath)),
      'All workspaces discovers custom storage without a prior workspace-scoped listing'
    )
    await sessionRow(name).click()
    await verifyHistory(engine, workspace, originalPath, answer)
    await screenshot(`${engine}-cross-workspace`)
  })

  if (engine === 'prime') {
    await check('prime: failed initial resume retains its tab and Restart retries it', async () => {
      await closeSavedSession(name, engine)
      await setOverride(engine, fixture.root.path('unavailable-prime.exe'))
      await sessionRow(name).click()
      await application.page.getByRole('button', { name: 'Restart engine', exact: true }).waitFor()
      const failed = await application.agentState()
      assert.equal(failed.status, 'crashed')
      assert.ok(samePath(failed.info.args.sessionPath, originalPath))
      const prefs = await application.invoke('app:get-state')
      assert.ok(prefs.openSessions.some((entry) => samePath(entry.path, originalPath)))
      await screenshot('prime-failed-resume')
      await setOverride(engine, null)
      await application.page.getByRole('button', { name: 'Restart engine', exact: true }).click()
      const resumed = await verifyHistory(engine, workspace, originalPath, answer)
      assert.equal(resumed.id, failed.id, 'Restart recovers the selected tab')
    })
  } else {
    await check('pi: a failed restored tab remains recoverable after relaunch', async () => {
      await setOverride(engine, fixture.root.path('unavailable-pi.cjs'))
      application = await application.relaunch()
      await until(async () => {
        const prefs = await application.invoke('app:get-state')
        return prefs.openSessions.some((entry) => samePath(entry.path, originalPath))
      }, 'failed restore remains persisted')
      await application.page.getByRole('button', { name: 'Restart engine', exact: true }).waitFor()
      await screenshot('pi-failed-restore')
      await setOverride(engine, null)
      await application.page.getByRole('button', { name: 'Restart engine', exact: true }).click()
      await verifyHistory(engine, workspace, originalPath, answer)
    })
  }

  if (engine === 'prime') {
    await check('prime: a lost owned daemon can resume saved history from Restart', async () => {
      report.daemonLoss = []
      for (let attempt = 0; attempt < DAEMON_LOSS_CHECKS; attempt++) {
        const active = await application.agentState()
        const descriptor = (await application.invoke('engine:list')).find(
          (entry) => entry.agentId === active.id
        )
        const processes = await processTable()
        const worker = processes.find((process) => process.pid === descriptor.pid)
        const daemon = processes.find((process) => process.pid === worker?.ppid)
        assert.ok(daemon && !foreignProcessIds.has(daemon.pid))
        assert.ok(daemon.commandLine.includes('vengeance-engine2-'), 'only the isolated app daemon')
        report.daemonLoss.push(descriptor)
        await killTree(daemon.pid)
        await application.page
          .getByRole('button', { name: 'Restart engine', exact: true })
          .waitFor()
        await screenshot(`prime-lost-daemon-${attempt}`)
        await application.page.getByRole('button', { name: 'Restart engine', exact: true }).click()
        await verifyHistory(engine, workspace, originalPath, answer)
      }
    })
  }

  await check(
    `${engine}: missing workspace opens a reviewed copy with native provenance`,
    async () => {
      await closeSavedSession(name, engine)
      const sourceBefore = await readFile(originalPath)
      const movedWorkspace = fixture.root.path(`${engine}-archived-workspace`)
      assert.ok(isInside(fixture.root.dir, workspace) && isInside(fixture.root.dir, movedWorkspace))
      await application.test('setPrefs', { activeWorkspace: otherWorkspace })
      await until(async () => {
        try {
          await rename(workspace, movedWorkspace)
          return true
        } catch (error) {
          if (error.code === 'EBUSY' || error.code === 'EPERM') return false
          throw error
        }
      }, 'the isolated historical workspace moved after handles closed')
      const prefs = await application.invoke('app:get-state')
      await application.test('setPrefs', {
        openSessions: [
          ...prefs.openSessions.filter((entry) => !samePath(entry.path, originalPath)),
          { path: originalPath, cwd: workspace, engine }
        ],
        activeSession: originalPath
      })
      await until(async () => {
        const saved = await application.invoke('app:get-state')
        return samePath(saved.activeSession, originalPath)
      }, 'the recoverable historical tab persisted')
      application = await application.relaunch()
      const dialog = application.page.getByRole('dialog', { name: 'Import a session' })
      await dialog.waitFor()
      await answerOpenDialog(application, targetWorkspace)
      await dialog.getByRole('button', { name: 'Choose workspace…' }).click()
      await dialog.getByText(targetWorkspace, { exact: true }).waitFor()
      await screenshot(`${engine}-missing-workspace-review`)
      await dialog.getByRole('button', { name: 'Import and open', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      const recovered = await activeSession(engine)
      const copyPath = recovered.session.sessionFile
      assert.ok(!samePath(copyPath, originalPath), 'relocation makes a copy')
      await verifyHistory(engine, targetWorkspace, copyPath, answer)
      assert.deepEqual(await readFile(originalPath), sourceBefore, 'the source bytes stay intact')
      const identity = await application.invoke('sessions:describe', copyPath)
      assert.equal(identity.engine, engine)
      assert.ok(samePath(identity.cwd, targetWorkspace))
      if (engine === 'prime') {
        const header = JSON.parse((await readFile(copyPath, 'utf8')).split(/\r?\n/, 1)[0])
        assert.ok(samePath(header.parentSession, originalPath), 'native copy records its source')
      }
      application = await application.relaunch()
      await verifyHistory(engine, targetWorkspace, copyPath, answer)
      await screenshot(`${engine}-recovered-after-relaunch`)
    }
  )
}

try {
  application = await launchApp({
    agentDir: fixture.piDirectory.dir,
    env: fixture.environment,
    outDir: OUTPUT_DIRECTORY
  })
  await recoverHistory('pi')
  await recoverHistory('prime')
} catch (error) {
  failure = error
  report.failureState = await application?.agentState().catch(() => undefined)
  report.failureEngines = await application?.invoke('engine:list').catch(() => undefined)
  await application?.screenshot('FAILED').catch(() => undefined)
} finally {
  await application
    ?.close({ beforeCleanup: fixture.stopNativeDaemon })
    .catch((error) => (failure ??= error))
  await fixture.cleanup().catch((error) => (failure ??= error))
  await mkdir(OUTPUT_DIRECTORY, { recursive: true })
  await writeFile(
    join(OUTPUT_DIRECTORY, 'report.json'),
    JSON.stringify({ ...report, error: failure?.stack, passed: !failure }, null, 2)
  )
}

if (failure) {
  console.error(failure.stack ?? failure)
  process.exitCode = 1
} else {
  console.log('✓ native historical session recovery passed')
}
