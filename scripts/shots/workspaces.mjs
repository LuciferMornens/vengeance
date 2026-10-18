import assert from 'node:assert/strict'
import { mockVolumePath } from './lib/mock-paths.mjs'

const WINDOW_SIZE = { width: 1440, height: 900 }
const NARROW_WINDOW_SIZE = { width: 880, height: 760 }
const RECENT_WORKSPACE_AGE_MS = 3_600_000

export async function scenarios(page, { app, shot, test, MOCK_WORKSPACE }) {
  const now = Date.now()
  await test('setPrefs', {
    theme: 'dark',
    activeWorkspace: MOCK_WORKSPACE,
    workspaces: [
      { path: MOCK_WORKSPACE, name: 'Aurora', lastOpenedAt: now, pinned: true },
      {
        path: mockVolumePath('work', 'platform', 'release-orchestration'),
        name: 'Release orchestration',
        lastOpenedAt: now - RECENT_WORKSPACE_AGE_MS
      },
      {
        path: mockVolumePath('work', 'research', 'interface-experiments', 'vengeance'),
        name: 'Vengeance interface experiments',
        lastOpenedAt: 0
      },
      { path: mockVolumePath('work', 'relay'), name: 'Relay', lastOpenedAt: 0 }
    ],
    features: { sessions: { scope: 'workspace', hiddenWorkspaces: [] } }
  })
  await test('openWorkspace', MOCK_WORKSPACE)
  const existing = await test('agentState')
  assert.equal(existing.info.engine, 'pi')
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()
  await page.getByRole('textbox', { name: 'Find workspace' }).waitFor()
  await shot('workspaces-switcher-dark')

  await page.getByRole('textbox', { name: 'Find workspace' }).fill('release-orchestration')
  assert.equal(await page.locator('[data-workspace-choice]').count(), 1)
  await shot('workspaces-path-search')
  await page.getByRole('textbox', { name: 'Find workspace' }).fill('')

  await page.getByRole('combobox', { name: 'Engine for new sessions' }).click()
  await shot('workspaces-engine-picker')
  await page.getByRole('option', { name: /^Engine 2(?:\s|$)/ }).click()
  assert.equal((await test('agentState', existing.info.agentId)).info.engine, 'pi')
  await shot('workspaces-engine-default-dark')
  await page.keyboard.press('Escape')
  await test('openWorkspace', MOCK_WORKSPACE)
  assert.equal((await test('agentState')).info.engine, 'prime')
  const engines = await page.evaluate(() => window.vengeance.invoke('engine:list'))
  assert.ok(engines.some((engine) => engine.engine === 'prime'))
  assert.equal(engines.find((engine) => engine.agentId === existing.info.agentId).engine, 'pi')
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click()

  await test('setPrefs', { theme: 'light' })
  await shot('workspaces-switcher-bone')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, NARROW_WINDOW_SIZE)
  const popup = page
    .locator('[data-workspace-choice]')
    .first()
    .locator('xpath=ancestor::*[@role="dialog"]')
  const bounds = await popup.boundingBox()
  assert.ok(bounds, 'workspace popover is visible')
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= NARROW_WINDOW_SIZE.width)
  await shot('workspaces-switcher-narrow-bone')
  await page.keyboard.press('Escape')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height)
  }, WINDOW_SIZE)
}
