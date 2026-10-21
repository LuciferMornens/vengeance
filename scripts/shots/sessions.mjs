// Sessions + inspector scenarios: session browser (many sessions, live dots, pinned, context menu, inline
// rename, delete confirm, fork dialog, all workspaces), share / import / closed-session tree dialogs,
// inspector tabs (overview with engine arguments, branches with filters, labels and in-place navigation
// with the branch-summary prompt, tools, files, timeline, extensions), two agents open + switching, light theme.
import { mockHomePath, mockVolumePath } from './lib/mock-paths.mjs'

const now = Date.now()
const WORKSPACES = [
  { path: mockHomePath('projects', 'aurora'), name: 'aurora', lastOpenedAt: now },
  { path: mockHomePath('projects', 'takedown'), name: 'takedown', lastOpenedAt: now - 3_600_000 },
  { path: mockVolumePath('work', 'relay'), name: 'relay', lastOpenedAt: now - 86_400_000 }
]

/** Launch options of the first session, so Overview shows real engine arguments. */
const LAUNCH = {
  approve: true,
  launch: {
    tools: ['read', 'bash', 'edit', 'write', 'todo'],
    appendSystemPrompt: ['Prefer small, reviewable diffs.'],
    extensionFlags: { 'no-lens': true }
  }
}

/** Main button of the first session row whose text contains `text`. */
const row = (page, text) => page.locator('[data-session-row]', { hasText: text }).first()

/** Close transient toasts so they do not cover the inspector. */
async function dismissToasts(page) {
  for (const button of await page.getByRole('button', { name: 'Dismiss' }).all())
    await button.click().catch(() => undefined)
}

export async function scenarios(page, { shot, test, wait, MOCK_WORKSPACE }) {
  const inspector = (tab, open = true) => test('setPrefs', { inspector: { open, width: 360, tab } })
  const settle = async () => {
    await dismissToasts(page)
    await page.mouse.move(760, 520)
    await page.evaluate(
      () => document.activeElement instanceof HTMLElement && document.activeElement.blur()
    )
  }
  /** Close a menu/dialog and let Radix finish restoring focus. */
  const escape = async () => {
    await page.keyboard.press('Escape')
    await wait(350)
  }
  const panel = () => page.locator('[role=tabpanel]')
  const treeNode = (text) => panel().locator('button[aria-expanded]', { hasText: text }).first()
  const dialog = () => page.getByRole('dialog')

  await test('setPrefs', {
    workspaces: WORKSPACES,
    activeWorkspace: MOCK_WORKSPACE,
    features: { sessions: { pinned: [], scope: 'workspace', collapsed: [] } }
  })
  await test('openWorkspace', MOCK_WORKSPACE, LAUNCH)
  await row(page, 'Theme tokens audit').waitFor()

  // The list holds main conversations; a subagent session sits collapsed under the session that started it.
  const child = row(page, 'Worker subagent')
  if (await child.isVisible()) throw new Error('a subagent session is listed as a main conversation')
  const subagents = page.getByRole('button', { name: '1 subagent session' })
  await subagents.click()
  // It reads as its role and task; the generated name is only in the tooltip.
  await child.waitFor()
  const childText = await child.innerText()
  if (
    !childText.includes('Worker subagent · Fix the session-tree jump on fork') ||
    /subagent-worker-|[0-9a-f]{8}-[0-9a-f]{4}-/.test(childText)
  ) {
    throw new Error(`child subagent session row reads "${childText}"`)
  }
  const childTitle = child.locator('span.truncate').first()
  await childTitle.hover()
  // On the macOS runner the first hover sometimes opens no tooltip; leave the row and hover again once.
  const tooltip = page.getByRole('tooltip')
  if (!(await tooltip.waitFor({ timeout: 3_000 }).then(() => true, () => false))) {
    await page.mouse.move(760, 520)
    await childTitle.hover()
    await tooltip.waitFor()
  }
  await shot('sessions-child-subagent', { settleMs: 600 })
  await subagents.click()
  await child.waitFor({ state: 'detached' })
  await settle()

  // Pin two sessions through the hover action.
  for (const title of ['Release 0.9 checklist', 'Migrate to React 19']) {
    await row(page, title).hover()
    await page
      .locator('div.group\\/row', { hasText: title })
      .first()
      .getByRole('button', { name: 'Pin' })
      .click()
  }

  // A complete showcase run in agent A (tools, files, abandoned branch, extension status/widgets).
  await test('mockPlay', { script: 'showcase', instant: true, pauseAt: 'select' })
  await test('mockPlay', { resume: true, instant: true })
  await test('mockPlay', { resume: true, instant: true, pauseAt: 'final-text' })
  await test('answerDialog', 'No, just SessionStore')
  // Mid-run: extension status + widget are live.
  await inspector('extensions')
  await settle()
  await shot('inspector-extensions', { settleMs: 700 })
  await test('mockPlay', { resume: true, instant: true })
  await test('waitForIdle')
  await wait(400)
  await settle()

  // ── Inspector tabs ──
  await inspector('overview')
  await page.getByRole('button', { name: 'Show engine command' }).waitFor()
  await shot('inspector-overview', { settleMs: 800 })
  await page.getByRole('button', { name: 'Show engine command' }).click()
  await wait(300)
  await panel().evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await shot('inspector-overview-engine', { settleMs: 500 })
  await inspector('files')
  await shot('inspector-files', { settleMs: 700 })
  await inspector('timeline')
  await shot('inspector-timeline', { settleMs: 700 })

  await inspector('tools')
  await page.getByText('tools offered to the model').waitFor()
  await shot('inspector-tools', { settleMs: 700 })
  await panel().getByRole('switch', { name: 'Turn on grep' }).click()
  await panel().getByRole('textbox', { name: 'Filter tools' }).fill('issue')
  await shot('inspector-tools-filter', { settleMs: 500 })
  await panel().getByRole('textbox', { name: 'Filter tools' }).fill('')

  await inspector('branches')
  await page.getByText('Session tree').waitFor()
  await shot('inspector-branches', { settleMs: 700 })
  await treeNode('How is the session store persisted').click()
  await shot('inspector-branches-actions', { settleMs: 500 })

  // Label the abandoned question (live, through the bridge).
  await panel().getByRole('button', { name: 'Add label' }).click()
  await panel().getByRole('textbox', { name: 'Label' }).fill('persist question')
  await shot('inspector-branches-label-edit', { settleMs: 300 })
  await page.keyboard.press('Enter')
  await panel().getByText('persist question').first().waitFor()
  await settle()
  await shot('inspector-branches-labeled', { settleMs: 500 })

  // treeFilterMode chips.
  await panel().getByRole('radio', { name: 'You', exact: true }).click()
  await shot('inspector-branches-filter-user', { settleMs: 500 })
  await panel().getByRole('radio', { name: 'All', exact: true }).click()
  await shot('inspector-branches-filter-all', { settleMs: 500 })
  await panel().getByRole('radio', { name: 'Labeled' }).click()
  await shot('inspector-branches-filter-labeled', { settleMs: 500 })
  await panel().getByRole('radio', { name: 'Default' }).click()
  await inspector('overview', false)

  // ── Two agents: resume a listed session (B), stream in it, switch back to A ──
  await row(page, 'Theme tokens audit').click()
  await page.locator('section[aria-label="Open sessions"] [data-session-row]').nth(1).waitFor()
  await test('waitForIdle')
  await wait(300)
  await test('mockPlay', {
    script: 'short',
    prompt: 'Also check the chart palette tokens',
    instant: true,
    pauseAt: 'short-text'
  })
  await shot('sessions-two-agents-b', { settleMs: 500 })
  await row(page, 'fix dropped session writes').click()
  await settle()
  await shot('sessions-two-agents-a', { settleMs: 600 })
  await shot('sessions-sidebar')

  // ── Menus and dialogs ──
  await settle()
  await row(page, 'Add keyboard navigation').click({ button: 'right' })
  await shot('sessions-context-menu')
  await escape()
  await settle()

  await row(page, 'Why does the dev server').focus()
  await page.keyboard.press('F2')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Vite double restart')
  await shot('sessions-rename', { settleMs: 300 })
  await page.keyboard.press('Enter')
  await settle()

  await row(page, 'Explain how the plugin loader').focus()
  await page.keyboard.press('Delete')
  await shot('sessions-delete-confirm', { settleMs: 500 })
  await escape()

  await row(page, 'Write integration tests').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Fork from a message…' }).click()
  await page.getByText('Can you also add a regression test').waitFor()
  await shot('sessions-fork-dialog', { settleMs: 400 })
  await escape()

  // Closed-session tree: browse and label without opening it.
  await row(page, 'Write integration tests').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Browse session tree…' }).click()
  await dialog().getByText('Can you also add a regression test').waitFor()
  await dialog()
    .locator('button[aria-expanded]', { hasText: 'Can you also add a regression test' })
    .click()
  await dialog().getByRole('button', { name: 'Add label' }).click()
  await dialog().getByRole('textbox', { name: 'Label' }).fill('tests requested')
  await page.keyboard.press('Enter')
  await dialog().getByText('tests requested').first().waitFor()
  await shot('sessions-tree-dialog', { settleMs: 500 })
  await escape()

  // Share: review → link.
  await row(page, 'fix dropped session writes').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Share…' }).click()
  await dialog().getByRole('button', { name: 'Create link' }).waitFor()
  await wait(300)
  await shot('sessions-share-review', { settleMs: 400 })
  await dialog().getByRole('button', { name: 'Create link' }).click()
  await dialog().getByText('Link copied').waitFor()
  await shot('sessions-share-done', { settleMs: 400 })
  await dialog().getByRole('button', { name: 'Done' }).click()
  await wait(300)

  const shareDestination = async (value) =>
    page.evaluate(
      (destination) =>
        window.vengeance.invoke('engine:settings', {
          engine: 'pi',
          channel: 'settings:set',
          args: [
            { scope: 'global', cwd: null, path: ['sessionShareDestination'], value: destination }
          ]
        }),
      value
    )
  await shareDestination('radius')
  await row(page, 'fix dropped session writes').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Share…' }).click()
  await dialog()
    .getByText('Uploads this session to your Radius organization and copies its link.')
    .waitFor()
  await shot('sessions-share-radius-review', { settleMs: 400 })

  await shareDestination('gist')
  await dialog().getByRole('button', { name: 'Create link' }).click()
  await dialog().getByRole('alert').filter({ hasText: 'destination changed' }).waitFor()
  await shot('sessions-share-destination-changed', { settleMs: 400 })
  await shareDestination('radius')
  await dialog().getByRole('button', { name: 'Check destination again' }).click()
  await dialog().getByRole('button', { name: 'Create link' }).click()
  await dialog().getByText('Shared with your Radius organization.').waitFor()
  if (await dialog().getByText('Anyone with the link', { exact: false }).count()) {
    throw new Error('Radius success uses gist visibility copy')
  }
  await shot('sessions-share-radius-done', { settleMs: 400 })
  await dialog().getByRole('button', { name: 'Done' }).click()
  await shareDestination(undefined)

  // Import: pick (mock file) → review → open.
  await page.getByRole('button', { name: 'More ways to start' }).click()
  await shot('sessions-new-menu', { settleMs: 300 })
  await page.getByRole('menuitem', { name: 'Import session…' }).click()
  await dialog().getByText('Offline sync design review').waitFor()
  await shot('sessions-import', { settleMs: 400 })
  await dialog().getByRole('button', { name: 'Import and open' }).click()
  await page
    .locator('section[aria-label="Open sessions"] [data-session-row]', {
      hasText: 'Offline sync design review'
    })
    .waitFor()
  await test('waitForIdle')
  await settle()
  await shot('sessions-imported', { settleMs: 600 })

  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await shot('sessions-workspace-switcher', { settleMs: 400 })
  await escape()

  // ── All workspaces ──
  await test('setPrefs', { features: { sessions: { pinned: [], scope: 'all', collapsed: [] } } })
  await page.locator('section[aria-label="Sessions by workspace"]').waitFor()
  await settle()
  await shot('sessions-all-workspaces', { settleMs: 600 })

  await page.getByRole('textbox', { name: 'Search sessions' }).fill('websocket')
  await shot('sessions-search', { settleMs: 400 })
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('')
  await test('setPrefs', {
    features: { sessions: { pinned: [], scope: 'workspace', collapsed: [] } }
  })

  // ── Go to an earlier point in place, with the branch-summary prompt ──
  await row(page, 'fix dropped session writes').click()
  await inspector('branches')
  await page.getByText('Session tree').waitFor()
  await settle()
  await treeNode('Sessions are written by').click()
  await panel().getByRole('button', { name: 'Go to this point' }).click()
  await dialog()
    .getByRole('radio', { name: /No summary/ })
    .waitFor()
  await shot('inspector-navigate-prompt', { settleMs: 400 })
  await dialog()
    .getByRole('radio', { name: /Summarize with instructions/ })
    .click()
  await dialog().getByRole('textbox').fill('Keep the debounce findings and the dirty-set idea.')
  await shot('inspector-navigate-instructions', { settleMs: 300 })
  await dialog().getByRole('button', { name: 'Go to this point' }).click()
  await panel()
    .getByText(/Explored the debounced persist path/)
    .first()
    .waitFor()
  await settle()
  await shot('inspector-branches-moved', { settleMs: 700 })

  // ── Light theme ──
  await test('setPrefs', { theme: 'light' })
  await settle()
  await shot('sessions-light', { settleMs: 800 })
  await inspector('tools')
  await page.getByText('tools offered to the model').waitFor()
  await shot('inspector-tools-light', { settleMs: 700 })
  await inspector('overview')
  await shot('inspector-overview-light', { settleMs: 800 })
}
