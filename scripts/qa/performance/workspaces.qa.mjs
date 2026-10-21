// Workspace discovery and keyboard switching through the built app, with isolated Engine histories.
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { basename, join, normalize } from 'node:path'
import { performance } from 'node:perf_hooks'
import { answerOpenDialog } from '../lib/main-stubs.mjs'
import { runSuite } from '../lib/suite.mjs'
import { tempRoot } from '../lib/tmp.mjs'
import { SessionBuilder, workspaceSessionDir } from '../sessions/lib/session-files.mjs'

const READY_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 50
const EVENT_DELIVERY_MS = 150
const SAVED_RECENCY = Date.now() - 86_400_000
const SAVED_NAME = 'Release control'
const PINNED_NAME = 'Pinned release plan'
const NATIVE_HISTORY_NAME = 'Saved Engine 2 verification'
const PRIMARY_REFRESH_NAME = 'Engine history refreshed during native outage'
const NATIVE_REFRESH_NAME = 'Native history refreshed during Engine outage'

function normalizedPath(value) {
  return normalize(value)
    .replace(/[\\/]$/, '')
    .toLowerCase()
}

async function waitForPreferences(app, predicate, label) {
  const started = performance.now()
  while (performance.now() - started < READY_TIMEOUT_MS) {
    const prefs = (await app.appState()).prefs
    if (predicate(prefs)) return prefs
    await app.page.waitForTimeout(POLL_INTERVAL_MS)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

async function waitForPersistence(app, predicate) {
  const started = performance.now()
  while (performance.now() - started < READY_TIMEOUT_MS) {
    const prefs = await app.invoke('app:get-state')
    if (predicate(prefs)) return prefs
    await app.page.waitForTimeout(POLL_INTERVAL_MS)
  }
  assert.fail('App preferences were not persisted')
}

function workspaceChoice(app, path) {
  const pathPattern = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  return app.page.locator('[data-workspace-choice]').filter({ hasText: pathPattern })
}

async function openSwitcher(app) {
  await app.page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await app.page.getByRole('textbox', { name: 'Find workspace' }).waitFor()
  await app.page.locator('div[aria-label="Workspaces"][aria-busy="false"]').waitFor()
}

async function savedSession(agentDir, cwd, name, headerCwd = cwd) {
  const session = new SessionBuilder({ cwd: headerCwd })
  session.user(`Inspect ${name}`)
  session.assistant('The saved workspace history is available.')
  session.name(name)
  return session.write(workspaceSessionDir(agentDir, cwd))
}

async function replaceDiscovery(app, result) {
  await app.app.evaluate(({ ipcMain }, answer) => {
    ipcMain.removeHandler('sessions:workspaces')
    ipcMain.handle('sessions:workspaces', async () => answer)
  }, result)
}

async function waitForDiscoveryCalls(app, minimum) {
  const started = performance.now()
  while (performance.now() - started < READY_TIMEOUT_MS) {
    const calls = await app.app.evaluate(() => globalThis.__qaWorkspaceDiscovery.calls)
    if (calls >= minimum) return calls
    await app.page.waitForTimeout(POLL_INTERVAL_MS)
  }
  assert.fail(`Expected at least ${minimum} workspace discovery requests`)
}

async function setWorkspaceEngine(app, label) {
  await app.page.getByRole('combobox', { name: 'Engine for new sessions' }).click()
  await app.page
    .getByRole('option')
    .filter({ has: app.page.getByText(label, { exact: true }) })
    .click()
}

function historyFixture(engine, cwd, path, name) {
  const timestamp = Date.now()
  return {
    engine,
    path,
    id: name.toLowerCase().replace(/\s+/g, '-'),
    cwd,
    name,
    createdAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 2,
    firstMessage: name,
    searchText: name.toLowerCase()
  }
}

async function notifySessionChange(app, root) {
  await app.app.evaluate(({ BrowserWindow }, folder) => {
    BrowserWindow.getAllWindows()[0].webContents.send('sessions:changed', { root: folder })
  }, root)
}

async function setListingFailure(app, engine) {
  await app.app.evaluate((_electron, failedEngine) => {
    globalThis.__qaMixedWorkspaceListing.failedEngine = failedEngine
  }, engine)
}

const primeConfig = await tempRoot('vengeance-qa-workspaces-prime-')

try {
  await runSuite(
    'performance-workspaces',
    async ({ agentDir, app, step }) => {
      let current = app
      try {
        const activeCwd = agentDir.path(join('..', 'workspace-discovery-active'))
        const historyCwd = agentDir.path(join('..', 'workspace-discovery-history'))
        const otherCwd = agentDir.path(join('..', 'workspace-discovery-other'))
        const deletedCwd = agentDir.path(join('..', 'workspace-discovery-deleted'))
        const staleCwd = agentDir.path(join('..', 'workspace-discovery-stale'))
        const removedCwd = agentDir.path(join('..', 'workspace-discovery-removed'))
        const folders = [activeCwd, historyCwd, otherCwd]
        for (const folder of folders) {
          await agentDir.writeText(
            join('..', basename(folder), 'README.md'),
            '# Workspace discovery QA\n'
          )
        }
        const pinnedPath = await savedSession(agentDir, activeCwd, PINNED_NAME)
        await savedSession(agentDir, historyCwd, 'History without a recent workspace')
        await savedSession(agentDir, historyCwd, 'Case variant history', historyCwd.toUpperCase())
        await savedSession(agentDir, otherCwd, 'Other saved workspace')
        // Test runs leave history behind for temporary folders they already deleted.
        await savedSession(agentDir, deletedCwd, 'History of a deleted folder')

        await step(
          'persist only the active folder and custom metadata before restart',
          async () => {
            await current.test('setPrefs', {
              workspaces: [
                { path: activeCwd, name: SAVED_NAME, lastOpenedAt: SAVED_RECENCY, pinned: true }
              ],
              activeWorkspace: activeCwd,
              openSessions: [],
              activeSession: null,
              onboardingCompleted: true,
              features: {
                sessions: {
                  pinned: [pinnedPath],
                  scope: 'workspace',
                  collapsed: ['Older']
                }
              }
            })
            await waitForPersistence(current, (prefs) => prefs.workspaces.length === 1)
          }
        )

        await step('restart discovers every history folder without All workspaces', async () => {
          const started = performance.now()
          current = await current.relaunch()
          const prefs = await waitForPreferences(
            current,
            (value) => value.workspaces.length === folders.length,
            'saved workspace discovery'
          )
          const paths = prefs.workspaces.map((workspace) => normalizedPath(workspace.path))
          assert.equal(new Set(paths).size, folders.length, 'case variants are merged')
          assert.deepEqual(
            new Set(paths),
            new Set(folders.map(normalizedPath)),
            'a deleted folder with saved history is not a workspace'
          )
          assert.deepEqual(
            prefs.workspaces.find((workspace) => workspace.path === activeCwd),
            {
              path: activeCwd,
              name: SAVED_NAME,
              lastOpenedAt: SAVED_RECENCY,
              pinned: true,
              engine: 'pi'
            }
          )
          assert.equal(prefs.activeWorkspace, activeCwd)
          assert.equal(prefs.features.sessions.scope, 'workspace')
          assert.deepEqual(prefs.features.sessions.pinned, [pinnedPath])
          assert.deepEqual(prefs.features.sessions.collapsed, ['Older'])
          assert.ok(
            prefs.workspaces
              .filter((workspace) => workspace.path !== activeCwd)
              .every((workspace) => workspace.lastOpenedAt === 0),
            'discovery does not invent a recent opening'
          )
          await openSwitcher(current)
          assert.equal(
            await current.page.locator('[data-workspace-choice]').count(),
            folders.length
          )
          assert.match(
            await current.page.locator('[data-workspace-choice]').first().innerText(),
            new RegExp(SAVED_NAME)
          )
          await current.screenshot('workspaces-discovered-dark')
          console.log(`    restart and discovery ${(performance.now() - started).toFixed(0)} ms`)
        })

        await step('path search and keyboard navigation choose a discovered folder', async () => {
          const search = current.page.getByRole('textbox', { name: 'Find workspace' })
          await search.fill('workspace-discovery-other')
          assert.equal(await current.page.locator('[data-workspace-choice]').count(), 1)
          await search.press('ArrowDown')
          assert.equal(
            await workspaceChoice(current, otherCwd).evaluate(
              (element) => document.activeElement === element
            ),
            true
          )
          await workspaceChoice(current, otherCwd).press('Enter')
          await waitForPreferences(
            current,
            (prefs) => prefs.activeWorkspace === otherCwd,
            'keyboard switch'
          )
          await current.page
            .locator('[data-session-row]', { hasText: 'Other saved workspace' })
            .waitFor()
          await current.send('ok')
          await current.waitForSettle()
          assert.equal((await current.agentState()).info.cwd, otherCwd)

          await openSwitcher(current)
          await current.page.getByRole('textbox', { name: 'Find workspace' }).fill(SAVED_NAME)
          assert.equal(await current.page.locator('[data-workspace-choice]').count(), 1)
          await current.page.getByRole('textbox', { name: 'Find workspace' }).press('Escape')
          assert.equal(
            await current.page.getByRole('textbox', { name: 'Find workspace' }).inputValue(),
            ''
          )
          assert.equal(
            await current.page.locator('[data-workspace-choice]').count(),
            folders.length
          )
          await search.focus()
          await search.press('ArrowDown')
          const first = current.page.locator('[data-workspace-choice]').first()
          await first.press('ArrowDown')
          const second = current.page.locator('[data-workspace-choice]').nth(1)
          assert.equal(await second.evaluate((element) => document.activeElement === element), true)
          await second.press('ArrowUp')
          assert.equal(await first.evaluate((element) => document.activeElement === element), true)
        })

        await step('hide persists after restart and Open folder restores discovery', async () => {
          await current.page.keyboard.press('Escape')
          await openSwitcher(current)
          await workspaceChoice(current, historyCwd).hover()
          const historyName = (await current.appState()).prefs.workspaces.find(
            (workspace) => normalizedPath(workspace.path) === normalizedPath(historyCwd)
          ).name
          await current.page
            .getByRole('button', {
              name: `Hide ${historyName} from workspaces`,
              exact: true
            })
            .click()
          await waitForPersistence(current, (prefs) =>
            prefs.features.sessions.hiddenWorkspaces?.includes(normalizedPath(historyCwd))
          )
          current = await current.relaunch()
          await current.composer()
          await openSwitcher(current)
          assert.equal(await workspaceChoice(current, historyCwd).count(), 0)
          await answerOpenDialog(current, historyCwd)
          await current.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Open folder…', exact: true })
            .click()
          await waitForPreferences(
            current,
            (prefs) => prefs.activeWorkspace === historyCwd,
            'folder restore'
          )
          const prefs = await waitForPersistence(
            current,
            (value) =>
              !value.features.sessions.hiddenWorkspaces?.includes(normalizedPath(historyCwd))
          )
          assert.ok(prefs.workspaces.some((workspace) => workspace.path === historyCwd))
          await current.page
            .locator('[data-session-row]', {
              hasText: 'History without a recent workspace'
            })
            .waitFor()
        })

        await step('discovery failure keeps known folders and Retry recovers', async () => {
          const known = (await current.appState()).prefs.workspaces
          await replaceDiscovery(current, {
            ok: false,
            error: { message: 'Workspace discovery QA failure' }
          })
          await current.page.reload()
          await current.page
            .getByRole('button', { name: 'Switch workspace', exact: true })
            .waitFor()
          await openSwitcher(current)
          await current.page
            .getByText('Could not check saved workspaces.', { exact: true })
            .waitFor()
          assert.equal(await current.page.locator('[data-workspace-choice]').count(), known.length)
          assert.deepEqual((await current.appState()).prefs.workspaces, known)
          await current.screenshot('workspaces-discovery-retry')
          await replaceDiscovery(current, {
            ok: true,
            value: {
              workspaces: folders.map((path) => ({ path, lastActivityAt: Date.now() })),
              gone: [],
              complete: true
            }
          })
          await current.page
            .getByRole('dialog')
            .getByRole('button', { name: 'Retry', exact: true })
            .click()
          await current.page
            .getByText('Could not check saved workspaces.', { exact: true })
            .waitFor({
              state: 'hidden'
            })
          assert.equal(await current.page.locator('[data-workspace-choice]').count(), known.length)
          current.assertNoErrors()
        })

        await step(
          'history changed during a scan schedules a trailing discovery request',
          async () => {
            await current.page.keyboard.press('Escape')
            const nextCwd = agentDir.path(join('..', 'workspace-discovery-during-scan'))
            await agentDir.writeText(
              join('..', basename(nextCwd), 'README.md'),
              '# Workspace added during discovery\n'
            )
            const known = (await current.appState()).prefs.workspaces.map((workspace) => ({
              path: workspace.path,
              lastActivityAt: 0,
              engine: 'pi'
            }))
            await current.app.evaluate(
              ({ ipcMain }, responses) => {
                const state = { calls: 0, release: null }
                globalThis.__qaWorkspaceDiscovery = state
                ipcMain.removeHandler('sessions:workspaces')
                ipcMain.handle('sessions:workspaces', async () => {
                  state.calls += 1
                  if (state.calls === 1) {
                    await new Promise((release) => {
                      state.release = release
                    })
                    return { ok: true, value: responses.first }
                  }
                  return { ok: true, value: responses.next }
                })
              },
              {
                first: { workspaces: known, gone: [], complete: true },
                next: {
                  workspaces: [
                    ...known,
                    { path: nextCwd, lastActivityAt: Date.now(), engine: 'pi' }
                  ],
                  gone: [],
                  complete: true
                }
              }
            )
            await notifySessionChange(current, agentDir.path('sessions'))
            await waitForDiscoveryCalls(current, 1)
            await current.app.evaluate(({ BrowserWindow }, root) => {
              BrowserWindow.getAllWindows()[0].webContents.send('sessions:changed', { root })
            }, agentDir.path('sessions'))
            await current.page.waitForTimeout(EVENT_DELIVERY_MS)
            assert.equal(
              await current.app.evaluate(() => globalThis.__qaWorkspaceDiscovery.calls),
              1
            )
            await current.app.evaluate(() => globalThis.__qaWorkspaceDiscovery.release())
            await waitForDiscoveryCalls(current, 2)
            await waitForPreferences(
              current,
              (prefs) => prefs.workspaces.some((workspace) => workspace.path === nextCwd),
              'workspace found by the trailing request'
            )
            await openSwitcher(current)
            assert.equal(await workspaceChoice(current, nextCwd).count(), 1)
            await current.screenshot('workspaces-discovery-invalidated')
            await current.page.keyboard.press('Escape')
          }
        )

        await step(
          'workspace engine defaults persist without changing current or saved sessions',
          async () => {
            await openSwitcher(current)
            await workspaceChoice(current, otherCwd).click()
            await current.composer()
            const currentAgent = await current.agentState()
            assert.equal(currentAgent.info.engine, 'pi')
            await openSwitcher(current)
            await setWorkspaceEngine(current, 'Engine 2')
            const prefs = await waitForPersistence(
              current,
              (value) =>
                value.workspaces.find((workspace) => workspace.path === otherCwd)?.engine ===
                'prime'
            )
            assert.equal((await current.agentState()).info.engine, 'pi')
            assert.ok(
              prefs.openSessions.some(
                (session) => session.cwd === otherCwd && session.engine === 'pi'
              )
            )
            await current.screenshot('workspaces-engine-default')
            current = await current.relaunch()
            await current.composer()
            assert.equal(
              (await current.agentState()).info.engine,
              'pi',
              'saved session restores its Engine'
            )
            assert.equal(
              (await current.appState()).prefs.workspaces.find(
                (workspace) => workspace.path === otherCwd
              ).engine,
              'prime'
            )
            await current.page
              .locator('[data-session-row]', { hasText: 'Other saved workspace' })
              .click()
            await current.composer()
            assert.equal(
              (await current.agentState()).info.engine,
              'pi',
              'listed session uses its recorded Engine'
            )
            assert.equal(
              (await current.appState()).prefs.workspaces.find(
                (workspace) => workspace.path === otherCwd
              ).engine,
              'prime'
            )
            current.assertNoErrors()
          }
        )

        await step('a never-opened folder leaves the switcher with its last history', async () => {
          const hasStale = (prefs) =>
            prefs.workspaces.some(
              (workspace) => normalizedPath(workspace.path) === normalizedPath(staleCwd)
            )
          await agentDir.writeText(
            join('..', basename(staleCwd), 'README.md'),
            '# Stale workspace QA\n'
          )
          const stalePath = await savedSession(agentDir, staleCwd, 'Only history of this folder')
          await notifySessionChange(current, agentDir.path('sessions'))
          const discovered = await waitForPreferences(current, hasStale, 'stale folder discovery')
          assert.equal(
            discovered.workspaces.find(
              (workspace) => normalizedPath(workspace.path) === normalizedPath(staleCwd)
            ).lastOpenedAt,
            0
          )
          await rm(stalePath)
          await notifySessionChange(current, agentDir.path('sessions'))
          const prefs = await waitForPreferences(
            current,
            (value) => !hasStale(value),
            'stale folder removal'
          )
          const paths = new Set(prefs.workspaces.map((workspace) => normalizedPath(workspace.path)))
          for (const folder of folders) {
            assert.ok(paths.has(normalizedPath(folder)), `${folder} stays after the scan`)
          }
          await openSwitcher(current)
          assert.equal(await workspaceChoice(current, staleCwd).count(), 0)
          await current.screenshot('workspaces-stale-history-removed')
          await current.page.keyboard.press('Escape')
        })

        await step('an opened folder leaves the switcher once it is deleted', async () => {
          const hasRemoved = (prefs) =>
            prefs.workspaces.some(
              (workspace) => normalizedPath(workspace.path) === normalizedPath(removedCwd)
            )
          await agentDir.writeText(
            join('..', basename(removedCwd), 'README.md'),
            '# Removed workspace QA\n'
          )
          await savedSession(agentDir, removedCwd, 'History that outlives its folder')
          const { workspaces } = (await current.appState()).prefs
          await current.test('setPrefs', {
            workspaces: [
              ...workspaces,
              { path: removedCwd, name: 'removed', lastOpenedAt: Date.now(), engine: 'pi' }
            ]
          })
          await waitForPersistence(current, hasRemoved)
          // The folder goes; its saved history stays, as when a project folder is deleted.
          await rm(removedCwd, { recursive: true })
          await notifySessionChange(current, agentDir.path('sessions'))
          const prefs = await waitForPreferences(
            current,
            (value) => !hasRemoved(value),
            'deleted folder removal'
          )
          const paths = new Set(prefs.workspaces.map((workspace) => normalizedPath(workspace.path)))
          for (const folder of folders) {
            assert.ok(paths.has(normalizedPath(folder)), `${folder} stays after the scan`)
          }
        })

        await step(
          'both workspace scopes merge saved histories once per normalized path',
          async () => {
            const primary = await current.invoke('sessions:list', { cwd: otherCwd, engine: 'pi' })
            const nativePath = join(primeConfig.dir, 'sessions', 'qa-mixed-history.jsonl')
            const nativeSession = new SessionBuilder({ cwd: otherCwd })
            nativeSession.user(NATIVE_HISTORY_NAME)
            nativeSession.assistant('The native history is available.')
            await primeConfig.folder('sessions', {
              'qa-mixed-history.jsonl': nativeSession.text()
            })
            const nativeHistory = historyFixture('prime', otherCwd, nativePath, NATIVE_HISTORY_NAME)
            const primaryRefresh = historyFixture(
              'pi',
              otherCwd,
              join(primary.sessionDir, 'qa-primary-refresh.jsonl'),
              PRIMARY_REFRESH_NAME
            )
            const nativeRefresh = historyFixture(
              'prime',
              otherCwd,
              join(primeConfig.dir, 'sessions', 'qa-native-refresh.jsonl'),
              NATIVE_REFRESH_NAME
            )
            await current.app.evaluate(
              ({ ipcMain }, fixtures) => {
                const state = { failedEngine: null, calls: [], fixtures }
                globalThis.__qaMixedWorkspaceListing = state
                ipcMain.removeHandler('sessions:list')
                ipcMain.handle('sessions:list', async (_event, query) => {
                  state.calls.push(query)
                  if (query.engine === state.failedEngine) {
                    return { ok: false, error: { message: 'QA history backend is unavailable' } }
                  }
                  const native = query.engine === 'prime'
                  const sessions = native
                    ? [
                        fixtures.native,
                        { ...fixtures.native, path: fixtures.native.path.toUpperCase() }
                      ]
                    : [...fixtures.primary.sessions]
                  if (state.failedEngine === 'prime' && !native)
                    sessions.push(fixtures.primaryRefresh)
                  if (state.failedEngine === 'pi' && native) sessions.push(fixtures.nativeRefresh)
                  return {
                    ok: true,
                    value: {
                      sessions,
                      sessionDir: native ? fixtures.nativeDirectory : fixtures.primary.sessionDir
                    }
                  }
                })
              },
              {
                primary,
                native: nativeHistory,
                nativeDirectory: join(primeConfig.dir, 'sessions'),
                primaryRefresh,
                nativeRefresh
              }
            )
            await notifySessionChange(current, primary.sessionDir)
            const nativeRow = current.page.locator('[data-session-row]', {
              hasText: NATIVE_HISTORY_NAME
            })
            await nativeRow.waitFor()
            assert.equal(await nativeRow.count(), 1)
            const calls = await current.app.evaluate(
              () => globalThis.__qaMixedWorkspaceListing.calls
            )
            assert.deepEqual(new Set(calls.map((query) => query.engine)), new Set(['pi', 'prime']))
            await openSwitcher(current)
            await current.page
              .getByRole('dialog')
              .getByRole('button', { name: 'All workspaces', exact: true })
              .click()
            await waitForPreferences(
              current,
              (prefs) => prefs.features.sessions.scope === 'all',
              'all-workspace scope'
            )
            await nativeRow.waitFor()
            assert.equal(await nativeRow.count(), 1)
            assert.equal(
              await current.page
                .locator('[data-session-row]', {
                  hasText: 'Other saved workspace'
                })
                .count(),
              1
            )
            await current.screenshot('workspaces-mixed-history')
          }
        )

        await step(
          'partial backend failures keep cached history while the other backend refreshes',
          async () => {
            await setListingFailure(current, 'prime')
            await notifySessionChange(current, agentDir.path('sessions'))
            await current.page
              .locator('[data-session-row]', { hasText: PRIMARY_REFRESH_NAME })
              .waitFor()
            assert.equal(
              await current.page
                .locator('[data-session-row]', {
                  hasText: NATIVE_HISTORY_NAME
                })
                .count(),
              1
            )
            await current.page
              .getByText('Engine 2: QA history backend is unavailable', {
                exact: true
              })
              .waitFor()
            await current.screenshot('workspaces-native-backend-outage')

            await setListingFailure(current, 'pi')
            await notifySessionChange(current, agentDir.path('sessions'))
            await current.page
              .locator('[data-session-row]', { hasText: NATIVE_REFRESH_NAME })
              .waitFor()
            assert.equal(
              await current.page
                .locator('[data-session-row]', {
                  hasText: PRIMARY_REFRESH_NAME
                })
                .count(),
              1
            )
            assert.equal(
              await current.page
                .locator('[data-session-row]', {
                  hasText: NATIVE_HISTORY_NAME
                })
                .count(),
              1
            )
            await current.page
              .getByText('Engine: QA history backend is unavailable', {
                exact: true
              })
              .waitFor()
            await current.screenshot('workspaces-engine-backend-outage')
            await setListingFailure(current, null)
            await current.page.getByRole('button', { name: 'Try again', exact: true }).click()
            await current.page
              .getByText('Could not load sessions', { exact: true })
              .waitFor({ state: 'hidden' })
            assert.equal(
              await current.page
                .locator('[data-session-row]', {
                  hasText: NATIVE_HISTORY_NAME
                })
                .count(),
              1
            )
          }
        )

        await step(
          'sidebar reopening sends the saved native backend and session path',
          async () => {
            await openSwitcher(current)
            await setWorkspaceEngine(current, 'Engine')
            await waitForPersistence(
              current,
              (prefs) =>
                prefs.workspaces.find((workspace) => workspace.path === otherCwd)?.engine === 'pi'
            )
            await current.page.keyboard.press('Escape')
            await current.app.evaluate(({ ipcMain }) => {
              globalThis.__qaNativeReopenRequests = []
              ipcMain.removeHandler('engine:create')
              ipcMain.handle('engine:create', async (_event, args, agentId) => {
                globalThis.__qaNativeReopenRequests.push({ args, agentId })
                return { ok: false, error: { message: 'QA captured the native reopen request' } }
              })
            })
            await current.page
              .locator('[data-session-row]', { hasText: NATIVE_HISTORY_NAME })
              .click()
            await current.page
              .getByText('QA captured the native reopen request', { exact: true })
              .first()
              .waitFor()
            const requests = await current.app.evaluate(() => globalThis.__qaNativeReopenRequests)
            assert.equal(requests.length, 1)
            assert.equal(requests[0].args.engine, 'prime')
            assert.equal(requests[0].args.cwd, otherCwd)
            assert.equal(
              normalizedPath(requests[0].args.sessionPath),
              normalizedPath(join(primeConfig.dir, 'sessions', 'qa-mixed-history.jsonl'))
            )
            current.assertNoErrors()
          }
        )
      } catch (error) {
        await current
          .screenshot('performance-workspaces-FAILED', { settleMs: 0 })
          .catch(() => undefined)
        throw error
      } finally {
        if (current !== app) await current.close()
      }
    },
    {
      launch: { env: { PRIME_AGENT_CODING_AGENT_DIR: primeConfig.dir } }
    }
  )
} finally {
  await primeConfig.cleanup()
}
