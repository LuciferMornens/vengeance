// Shell scenarios (foundation): onboarding, empty session, extension dialog, mid-stream transcript,
// inspector, settings sheet, command palette.
export async function scenarios(page, { shot, test, MOCK_WORKSPACE }) {
  await shot('shell-onboarding')

  await test('openWorkspace', MOCK_WORKSPACE)
  await shot('shell-empty-session')

  await test('mockPlay', { script: 'showcase', instant: true, pauseAt: 'select' })
  await test('mockPlay', { resume: true, instant: true })
  await shot('shell-extension-dialog')

  // Arm the next pause while the run is blocked on the dialog, then answer it.
  await test('mockPlay', { resume: true, instant: true, pauseAt: 'final-text' })
  await test('answerDialog', 'No, just SessionStore')
  await shot('shell-mid-stream')

  await test('setPrefs', { inspector: { open: true, width: 340, tab: 'overview' } })
  await shot('shell-inspector', { settleMs: 700 })
  await test('setPrefs', { inspector: { open: false, width: 340, tab: 'overview' } })

  await test('openSettings', 'general')
  await shot('shell-settings', { settleMs: 700 })
  await test('closeSettings')

  await test('setPalette', true)
  await shot('shell-palette')
  await test('setPalette', false)
}
