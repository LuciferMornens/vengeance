import assert from 'node:assert/strict'

// Conversation instructions: the header control and `/instructions` open one dialog per conversation;
// saving restarts it with them and the header shows the state. Mock engines echo the instructions in
// the assembled prompt.

const ENGINE_TEXT =
  'Prefer small, reviewable diffs.\nExplain every persistence change before making it.'
const ENGINE2_TEXT = 'You review release changes. Check the release notes before changing code.'
const READY_TIMEOUT_MS = 30_000
const TURN_VIEW_NOTE = 'The assembled prompt is available when this turn finishes.'

function promptDialog(page) {
  return page.getByRole('dialog', { name: 'Conversation instructions', exact: true })
}

function headerControl(page) {
  return page
    .locator('[data-session-header]')
    .getByRole('button', { name: /^Conversation instructions/ })
}

/** Waits for the restart that applied `expected` (text and mode, or none) to finish. */
async function waitForInstructions(page, agentId, expected) {
  await page.waitForFunction(
    ({ agentId, expected }) => {
      const state = window.__vengeanceTest.agentState(agentId)
      const prompt = state?.info.args.conversationPrompt ?? null
      const applied = expected
        ? prompt?.text === expected.text && prompt?.mode === expected.mode
        : prompt === null
      return applied && state.status === 'ready' && !!state.session
    },
    { agentId, expected },
    { timeout: READY_TIMEOUT_MS }
  )
}

async function viewAssembled(page, dialog) {
  await dialog.getByRole('button', { name: 'View assembled prompt', exact: true }).click()
  const assembled = page.getByRole('dialog', { name: 'Assembled prompt', exact: true })
  await assembled.waitFor()
  return assembled
}

/** A listed Engine session, so its history comes back after the restart that applies instructions. */
async function openSavedSession(page, test, cwd, name) {
  const { sessions } = await page.evaluate(
    (workspace) => window.vengeance.invoke('sessions:list', { cwd: workspace, engine: 'pi' }),
    cwd
  )
  const saved = sessions.find((session) => session.name === name)
  assert.ok(saved, `the mock workspace lists "${name}"`)
  const agentId = await test('openSession', saved.path, 'pi')
  await page.waitForFunction(
    (id) => {
      const state = window.__vengeanceTest.agentState(id)
      return state?.status === 'ready' && state.phase === 'idle' && state.entries.length > 0
    },
    agentId,
    { timeout: READY_TIMEOUT_MS }
  )
  return agentId
}

export async function scenarios(page, { shot, test, MOCK_WORKSPACE }) {
  // The Engine: open from the header, draft, inspect, save and restart.
  const blank = await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi' })
  const engineAgent = await openSavedSession(page, test, MOCK_WORKSPACE, 'Debounced persist race')
  await test('closeSession', blank)
  await headerControl(page).click()
  let dialog = promptDialog(page)
  await dialog.waitFor()
  assert.equal(
    await dialog.getByRole('button', { name: 'Save and restart', exact: true }).isDisabled(),
    true
  )
  await shot('conversation-prompt-empty-dark')

  const editor = dialog.getByRole('textbox', { name: 'Conversation instructions', exact: true })
  await editor.fill(ENGINE_TEXT)
  await dialog.getByText('Unsaved', { exact: true }).waitFor()
  await shot('conversation-prompt-draft-dark')

  // No turn ran in this process yet: the Engine reports its base prompt, labeled as partial.
  let assembled = await viewAssembled(page, dialog)
  assert.ok(!(await assembled.locator('pre').innerText()).includes('reviewable diffs'))
  await assembled.getByText(/This is the base prompt/).waitFor()
  await assembled.getByText(/Unsaved instructions are not included/).waitFor()
  await shot('conversation-prompt-assembled-draft-dark')
  await page.keyboard.press('Escape')
  await assembled.waitFor({ state: 'hidden' })

  await dialog.getByRole('radio', { name: 'Replace foundation' }).click()
  await dialog.getByText('Replaces the foundation', { exact: true }).waitFor()
  await shot('conversation-prompt-replace-dark')
  await dialog.getByRole('radio', { name: 'Add to engine prompt' }).click()

  await dialog.getByRole('button', { name: 'Save and restart', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: READY_TIMEOUT_MS })
  await waitForInstructions(page, engineAgent, { text: ENGINE_TEXT, mode: 'append' })
  await page.locator('[data-session-header] [data-conversation-prompt="append"]').waitFor()
  await page.waitForFunction(
    (agentId) => window.__vengeanceTest.agentState(agentId)?.entries.length > 0,
    engineAgent,
    { timeout: READY_TIMEOUT_MS }
  )
  // Main saved them for the session file, so every later resume gets them.
  const sessionFile = await page.evaluate(
    (agentId) => window.__vengeanceTest.agentState(agentId)?.info.sessionFile,
    engineAgent
  )
  const stored = await page.evaluate(
    (file) => window.vengeance.invoke('engine:conversation-prompt', 'pi', file),
    sessionFile
  )
  assert.deepEqual([stored?.mode, stored?.text], ['append', ENGINE_TEXT])
  await shot('conversation-prompt-saved-dark')

  // After a turn in the restarted process, the Engine reports that turn's full prompt.
  await test('mockPlay', { script: 'short', instant: true })
  await headerControl(page).click()
  dialog = promptDialog(page)
  await dialog.waitFor()
  assert.equal(await editor.inputValue(), ENGINE_TEXT)
  assembled = await viewAssembled(page, dialog)
  assert.ok((await assembled.locator('pre').innerText()).includes('reviewable diffs'))
  assert.equal(await assembled.getByText(/This is the base prompt/).count(), 0)
  await shot('conversation-prompt-assembled-dark')
  await page.keyboard.press('Escape')
  await assembled.waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  // Busy work keeps the draft editable and says why it cannot apply yet.
  await test('mockPlay', {
    script: 'short',
    prompt: 'Also batch the title writes of pinned sessions.',
    pauseAt: 'short-text'
  })
  await headerControl(page).click()
  await dialog.waitFor()
  await dialog.getByText('Wait for this conversation to finish its current work.').waitFor()
  // That also says why the assembled prompt waits: no second note.
  assert.equal(await dialog.getByText(TURN_VIEW_NOTE, { exact: true }).count(), 0)
  await editor.fill(`${ENGINE_TEXT}\nKeep the public API unchanged.`)
  assert.equal(
    await dialog.getByRole('button', { name: 'Save and restart', exact: true }).isDisabled(),
    true
  )
  await shot('conversation-prompt-busy-dark')
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await test('mockPlay', { resume: true, instant: true })
  await test('waitForIdle')

  // The dialog lives outside the session pane: another session coming to the front keeps it, its
  // conversation and its draft.
  const backgroundDraft = `${ENGINE_TEXT}\nName the migration in the summary.`
  await headerControl(page).click()
  await dialog.waitFor()
  await editor.fill(backgroundDraft)
  const engine2Agent = await test('openWorkspace', MOCK_WORKSPACE, {
    engine: 'prime',
    name: 'Validate release notes'
  })
  await page.waitForFunction(
    (agentId) => window.__vengeanceTest.agentState(agentId)?.status === 'ready',
    engine2Agent,
    { timeout: READY_TIMEOUT_MS }
  )
  assert.equal(await dialog.isVisible(), true)
  assert.equal(await editor.inputValue(), backgroundDraft)
  await dialog.getByText('Debounced persist race · Engine', { exact: true }).waitFor()
  await shot('conversation-prompt-background-draft-dark')
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  // Engine 2: `/instructions <text>` opens the dialog with a draft; replace the foundation.
  await page.waitForFunction(
    (agentId) => window.__vengeanceTest.agentState(agentId)?.commandsStatus === 'ready',
    engine2Agent,
    { timeout: READY_TIMEOUT_MS }
  )
  const composer = page.locator('textarea[aria-label="Message"]')
  await composer.fill(`/instructions ${ENGINE2_TEXT}`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  dialog = promptDialog(page)
  await dialog.waitFor()
  assert.equal(await editor.inputValue(), ENGINE2_TEXT)
  await dialog.getByRole('radio', { name: 'Replace foundation' }).click()
  await dialog.getByText(/core, usage, opinionated and per-model layers/).waitFor()
  await shot('conversation-prompt-engine2-replace-dark')
  await dialog.getByRole('button', { name: 'Save and restart', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: READY_TIMEOUT_MS })
  await waitForInstructions(page, engine2Agent, { text: ENGINE2_TEXT, mode: 'replace' })
  await page.locator('[data-session-header] [data-conversation-prompt="replace"]').waitFor()

  await test('setPrefs', { theme: 'light' })
  await headerControl(page).click()
  await dialog.waitFor()
  assembled = await viewAssembled(page, dialog)
  assert.ok((await assembled.locator('pre').innerText()).includes('Check the release notes'))
  await page.keyboard.press('Escape')
  await assembled.waitFor({ state: 'hidden' })
  await shot('conversation-prompt-engine2-bone')

  // Remove restarts it with the engine's own prompt and clears the header state.
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await dialog.getByRole('button', { name: 'Remove and restart', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: READY_TIMEOUT_MS })
  await waitForInstructions(page, engine2Agent, null)
  await page
    .locator('[data-session-header]')
    .getByRole('button', { name: 'Conversation instructions…', exact: true })
    .waitFor()
  await test('setPrefs', { theme: 'dark' })

  // A temporary chat cannot restart. During a turn the assembled prompt waits as well, and the
  // temporary-chat warning does not say so: the reason joins it under the editor.
  await test('openWorkspace', MOCK_WORKSPACE, { engine: 'pi', noSession: true })
  await test('mockPlay', {
    script: 'short',
    prompt: 'Sketch the retry policy for webhooks.',
    pauseAt: 'short-text'
  })
  await headerControl(page).click()
  await dialog.waitFor()
  const viewNote = dialog.getByText(TURN_VIEW_NOTE, { exact: true })
  await viewNote.waitFor()
  assert.match(
    await viewNote.locator('..').innerText(),
    /^Temporary chats with messages cannot restart\./
  )
  assert.equal(
    await dialog.getByRole('button', { name: 'View assembled prompt', exact: true }).isDisabled(),
    true
  )
  await shot('conversation-prompt-temporary-busy-dark')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await test('mockPlay', { resume: true, instant: true })
  await test('waitForIdle')
}
