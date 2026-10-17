// A session far deeper than contextBridge's 1000-level object limit (the mock's "Decoder fuzzing
// marathon", over 3000 entries): its tree in the closed-session dialog and in the inspector's Branches tab.
import { mockVolumePath } from './lib/mock-paths.mjs'

const RELAY = mockVolumePath('work', 'relay')
const LONG_SESSION = 'Decoder fuzzing marathon'

export async function scenarios(page, { shot, test, wait }) {
  const row = () => page.locator('[data-session-row]', { hasText: LONG_SESSION }).first()
  const dialog = () => page.getByRole('dialog')
  const panel = () => page.locator('[role=tabpanel]')
  const assertNoTreeError = async (scope) => {
    if ((await scope.getByText(/Could not (load|read) the (session )?tree/).count()) > 0) throw new Error('the session tree did not load')
  }

  await test('setPrefs', {
    workspaces: [{ path: RELAY, name: 'relay', lastOpenedAt: Date.now() }],
    activeWorkspace: RELAY,
    features: { sessions: { pinned: [], scope: 'workspace', collapsed: [] } }
  })
  await test('openWorkspace', RELAY)
  await row().waitFor()

  // Closed session: the tree comes from the session file (sessions:tree).
  await row().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
  await dialog().getByText('Round 1500 done').waitFor()
  await assertNoTreeError(dialog())
  await shot('sessions-tree-deep', { settleMs: 500 })
  await page.keyboard.press('Escape')
  await wait(350)

  // Open session: the tree comes from the engine (get_tree).
  await row().click()
  await test('waitForIdle')
  await test('setPrefs', { inspector: { open: true, width: 360, tab: 'branches' } })
  await panel().getByText('Round 1500 done').waitFor()
  await assertNoTreeError(panel())
  await page.mouse.move(760, 520)
  await shot('inspector-branches-deep', { settleMs: 700 })
}
