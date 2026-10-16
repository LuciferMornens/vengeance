// First run: an empty temp profile and an EMPTY temp engine dir (no providers). Every onboarding
// step, skipping, the provider step (API key through the real dialog, written to the temp
// auth.json), opening a folder through the dialog and by drag-and-drop, and the engine-not-found
// state (missing bundled payload, home moved to temp) with "Locate…" and "Check again".
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { launchApp } from '../lib/app.mjs'
import { assertTempPath } from '../lib/agent-dir.mjs'
import { answerOpenDialog } from '../lib/main-stubs.mjs'
import { dropPaths, shot, tempRoot, waitUntil } from './lib/kit.mjs'

const failures = []
async function step(label, action) {
  console.log(`  • ${label}`)
  try {
    await action()
    console.log(`    ✓ ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`    ✗ ${label}\n      ${error.message.split('\n').join('\n      ')}`)
  }
}

const root = await tempRoot('vengeance-qa-onboarding-')
const emptyAgentDir = assertTempPath(await root.folder('agent'))
let realEngineDir

console.log('▶ shell/onboarding (fake, empty engine dir)')
let app
try {
  app = await launchApp({ agentDir: emptyAgentDir, outDir: root.path('shots') })
  const { page } = app

  await step(
    'first run shows onboarding full-window: no sidebar toggle, no search pill',
    async () => {
      await page.getByRole('heading', { name: 'Engine detected' }).waitFor({ timeout: 20_000 })
      assert.equal(await page.getByRole('button', { name: /sidebar/i }).count(), 0)
      assert.equal(await page.getByText('Search or run a command…').count(), 0)
      const state = await app.appState()
      assert.equal(state.prefs.onboardingCompleted, false)
      assert.equal(state.prefs.activeWorkspace, null)
      await shot(page, 'onboarding-1-engine')
    }
  )

  await step('engine step shows the detected engine version and package folder', async () => {
    const info = await app.invoke('engine:info')
    assert.equal(info.found, true)
    assert.ok(info.packageDir)
    realEngineDir = info.packageDir
    await page.getByText(`Engine ${info.version}`).waitFor()
    await page.getByText(info.packageDir).waitFor()
  })

  await step(
    'Continue → provider step: nothing connected, Continue disabled, sign-in cards',
    async () => {
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.getByRole('heading', { name: 'Connect a provider' }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), true)
      await page.getByRole('button', { name: 'Skip for now' }).waitFor()
      await shot(page, 'onboarding-2-provider-empty')
    }
  )

  await step('Skip for now → project step; the stepper goes back to Provider', async () => {
    await page.getByRole('button', { name: 'Skip for now' }).click()
    await page.getByRole('heading', { name: 'Choose a project' }).waitFor()
    await page.getByRole('button', { name: /Provider$/ }).click()
    await page.getByRole('heading', { name: 'Connect a provider' }).waitFor()
  })

  await step(
    'API key through the real dialog lands in the temp auth.json, step reads connected',
    async () => {
      await page.getByRole('combobox').filter({ hasText: 'Choose a provider…' }).click()
      await page.getByRole('option', { name: /^Anthropic$/ }).click()
      await page.getByRole('button', { name: 'Add key' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await shot(page, 'onboarding-2b-key-dialog')
      const field = dialog.locator('input').first()
      await field.fill('sk-ant-qa-onboarding-fake')
      await field.press('Enter')
      await waitUntil(
        async () =>
          (await readFile(root.path('agent', 'auth.json'), 'utf8').catch(() => '')).includes(
            'anthropic'
          ),
        { timeoutMs: 15_000, label: 'auth.json with the anthropic key' }
      )
      const auth = JSON.parse(await readFile(root.path('agent', 'auth.json'), 'utf8'))
      assert.equal(auth.anthropic?.type, 'api_key')
      await page.keyboard.press('Escape')
      await page.getByRole('heading', { name: 'You’re connected' }).waitFor({ timeout: 15_000 })
      assert.equal(await page.getByRole('button', { name: 'Continue' }).isDisabled(), false)
      await shot(page, 'onboarding-2c-provider-connected')
    }
  )

  await step(
    'stepper: Engine step is reachable back, Project unlocked after the provider step',
    async () => {
      await page.getByRole('button', { name: /Engine$/ }).click()
      await page.getByRole('heading', { name: 'Engine detected' }).waitFor()
      await page.getByRole('button', { name: /Project$/ }).click()
      await page.getByRole('heading', { name: 'Choose a project' }).waitFor()
      await shot(page, 'onboarding-3-project')
    }
  )

  await step('dropping a FILE on the project target is refused with a message', async () => {
    const file = await root.folder('dropfile')
    const { writeFile } = await import('node:fs/promises')
    const notesPath = join(file, 'notes.txt')
    await writeFile(notesPath, 'hello')
    await dropPaths(page, 'button:has-text("Drop a folder here")', [notesPath])
    await page.getByText('Drop a folder, not a file.').waitFor({ timeout: 5000 })
    assert.equal((await app.appState()).prefs.activeWorkspace, null)
  })

  await step('dropping a FOLDER opens it as the workspace and starts a session', async () => {
    const folder = await root.folder('dropped-project', { 'README.md': '# dropped\n' })
    await dropPaths(page, 'button:has-text("Drop a folder here")', [folder])
    await page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: 60_000 })
    const state = await app.appState()
    assert.equal(state.prefs.activeWorkspace?.toLowerCase(), folder.toLowerCase())
    assert.equal(state.prefs.onboardingCompleted, true)
    assert.equal(state.prefs.workspaces.length, 1)
    await waitUntil(async () => (await app.agentState())?.status === 'ready', {
      timeoutMs: 60_000,
      label: 'engine ready'
    })
    await shot(page, 'onboarding-4-dropped-session')
  })
  app.assertNoErrors()
} catch (error) {
  failures.push(error.stack ?? String(error))
} finally {
  await app?.close().catch((error) => failures.push(`close: ${error.message}`))
}

console.log('▶ shell/onboarding: engine not found')
const noEngineHome = await root.folder('home')
try {
  app = await launchApp({
    agentDir: emptyAgentDir,
    outDir: root.path('shots'),
    env: {
      VENGEANCE_BUNDLED_ENGINES: root.path('missing-bundle'),
      USERPROFILE: noEngineHome,
      HOME: noEngineHome
    }
  })
  const { page } = app

  await step('engine missing: repair explanation, Locate and Check again', async () => {
    await page
      .getByRole('heading', { name: 'Engine unavailable', exact: true })
      .waitFor({ timeout: 20_000 })
    const info = await app.invoke('engine:info')
    assert.equal(info.found, false)
    await page
      .getByText('Reinstall Vengeance to restore its included engines', { exact: false })
      .waitFor()
    await page.getByRole('button', { name: 'Locate…' }).waitFor()
    await page.getByRole('button', { name: 'Check again' }).waitFor()
    await shot(page, 'onboarding-5-engine-missing')
  })

  await step('stepper does not let the user skip past a missing engine', async () => {
    assert.equal(await page.getByRole('button', { name: /Provider$/ }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: /Project$/ }).isDisabled(), true)
  })

  await step('engine-missing copy never says "pi" (UI calls it the Engine)', async () => {
    const text = await page.locator('main').innerText()
    const sentence =
      text.split('\n').find((line) => /bundled Engine is unavailable/i.test(line)) ?? ''
    assert.notEqual(sentence, '', 'the repair step shows why the engine is missing')
    assert.doesNotMatch(sentence, /\bpi\b/, `engine-missing reason shows "pi": ${sentence}`)
  })

  await step('Check again with nothing changed stays on the repair step', async () => {
    await page.getByRole('button', { name: 'Check again' }).click()
    await page.getByRole('heading', { name: 'Engine unavailable', exact: true }).waitFor()
  })

  await step('Locate… (folder dialog) → engine detected, override saved', async () => {
    assert.ok(realEngineDir, 'the detected install folder is available for Locate')
    await answerOpenDialog(app, normalize(realEngineDir))
    await page.getByRole('button', { name: 'Locate…' }).click()
    await page.getByRole('heading', { name: 'Engine detected' }).waitFor({ timeout: 20_000 })
    const state = await app.appState()
    assert.ok(state.prefs.engineOverridePath, 'engineOverridePath set')
    await shot(page, 'onboarding-6-engine-located')
  })
  app.assertNoErrors()
} catch (error) {
  failures.push(error.stack ?? String(error))
} finally {
  await app?.close().catch((error) => failures.push(`close: ${error.message}`))
  await root.cleanup()
}

if (failures.length) {
  console.error(`✗ shell/onboarding: ${failures.length} failure(s)`)
  process.exitCode = 1
} else console.log('✓ shell/onboarding passed')
